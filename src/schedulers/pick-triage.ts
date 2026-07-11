import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Client,
  type TextChannel
} from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { markPosted, isPosted, isResolved, hasLegacyItem, type PostedOrder } from "../services/pickTriageStore.js";
import { adminOrderUrl } from "../services/kyouLinks.js";
import { buildTriageSelect, itemListValue } from "../handlers/pickTriage.js";

/**
 * Triase interaktif "PICK nyangkut >= N jam" (default band 24-30 jam).
 *
 * Beda dengan fulfillment-stale.ts (digest read-only, 3-30 hari, semua stage):
 * ini khusus stage PICK dan interaktif — tiap order punya dropdown 3 opsi
 * (masih antri / rusak / belum ketemu) yang saat dipilih membuka modal
 * deskripsi lalu menghasilkan embed balasan.
 *
 * Data diambil per BARANG (order_items) tapi dikirim per ORDER: satu pesan
 * memuat semua barang order itu yang nyangkut, dengan SATU dropdown. Dulu satu
 * pesan per barang, dan order berisi 5 barang membanjiri channel dengan 5 pesan
 * yang isinya nyaris identik. Kalau kasus tiap barang beda (satu rusak, satu
 * belum ketemu), itu dijelaskan di deskripsi modal.
 *
 * Logika stage PICK dijaga konsisten dengan App\Support\FulfillmentStale di
 * kyou.id & fulfillment-stale.ts: order sudah di-print (masuk PICK), belum
 * di-pack, dan barang (order_items) belum di-pick.
 *
 * Bukan cron harian: bot POLL tiap PICK_TRIAGE_POLL_MINUTES menit dan mengirim
 * order begitu barangnya melewati 24 jam. Dedupe lewat store (`posted`), jadi
 * tiap order muncul tepat sekali. Kalau tidak ada yang baru → diam, tidak ada
 * pesan "tidak ada" (kalau tidak, channel kebanjiran tiap putaran).
 *
 * Batas atas MAX_HOURS tetap dipakai sebagai pengaman: kalau store hilang (mis.
 * redeploy tanpa volume di data/), tanpa batas atas bot akan memblast ULANG
 * seluruh backlog (pernah ada barang nyangkut 1378 jam).
 */

const EMBED_COLOR = 0xd9534f;
const EMBED_COLOR_EARLY = 0x9b59b6;

/**
 * Order yang pelunasannya ditagih lewat tombol **Early** di panel PO kyou.id.
 *
 * Tagih vs Early memanggil fungsi yang sama (`OrderHelper::createFullPayment`);
 * bedanya cuma flag `$early`, yang (a) menambah kalimat "Pengiriman itemnya
 * diestimasi mulai minggu depan yah" di WA ke pembeli, dan (b) mencatat
 * `admin_logs.action = 'early_order'` alih-alih `'tagih_order'`.
 *
 * Artinya: pembeli sudah ditagih lunas SEBELUM barangnya sampai, dan ordernya
 * di-print duluan supaya barangnya disiapkan. Menagih staf setelah 24 jam itu
 * tidak adil — barangnya sendiri mungkin belum datang. Karena itu ambangnya
 * dilonggarkan jadi 4 hari (PICK_TRIAGE_EARLY_MIN_HOURS).
 */
const EARLY_BILLED_SQL = `EXISTS (
        SELECT 1 FROM admin_logs al2
        WHERE al2.order_id = o.order_id AND al2.action = 'early_order'
      )`;

type StalePickItem = {
  itemId: string;
  orderId: string;
  itemName: string;
  hours: number;
  user: string;
  shipping: string;
  isEarly: boolean;
  eta: string;
};

/** Semua barang nyangkut milik satu order, digabung jadi satu pesan. */
type StalePickOrder = {
  orderId: string;
  itemIds: string[];
  itemNames: string[];
  hours: number; // yang paling lama di antara barangnya
  user: string;
  shipping: string;
  isEarly: boolean;
  eta: string; // perkiraan barang datang (orders.eta), mis. "July-August 2026"
};

function metabaseConfig(): MetabaseConfig | null {
  if (!env.METABASE_URL || !env.METABASE_EMAIL || !env.METABASE_PASSWORD) {
    return null;
  }
  return {
    url: env.METABASE_URL,
    email: env.METABASE_EMAIL,
    password: env.METABASE_PASSWORD,
    databaseId: env.METABASE_DATABASE_ID
  };
}

/** Lebar band pengaman (jam) — sama untuk order biasa maupun yang ditagih early. */
function bandWidth(): number {
  return Math.max(1, env.PICK_TRIAGE_MAX_HOURS - env.PICK_TRIAGE_MIN_HOURS);
}

function buildQuery(minHours: number, maxHours: number, earlyMinHours: number): string {
  // Dua ambang dalam SATU query: order yang ditagih early (barangnya boleh jadi
  // belum datang) baru ditanyakan setelah earlyMinHours (default 96 jam = 4
  // hari); sisanya tetap minHours (24 jam).
  //
  // Tetap pakai BAND, bukan cutoff absolut. Yang nyangkut lebih lama dari batas
  // atas SENGAJA tidak dikirim: itu ranah digest fulfillment-stale (3-30 hari).
  // Jangan tambahkan mode cutoff absolut lagi — pernah bikin barang 1378 jam
  // ikut terkirim dan membanjiri channel.
  const earlyMaxHours = earlyMinHours + bandWidth();

  // Tanpa LIMIT — fetchNativeQueryWithPagination yang menambah LIMIT/OFFSET.
  return `
    SELECT
      oi.id AS item_id,
      o.order_id AS order_id,
      oi.item_name AS item_name,
      ROUND(TIMESTAMPDIFF(HOUR, o.updated_at, NOW())) AS hours_stuck,
      u.name AS user_name,
      o.shipping_type AS shipping_type,
      ${EARLY_BILLED_SQL} AS is_early,
      COALESCE(o.eta, '') AS eta
    FROM orders o
    JOIN users u ON u.user_id = o.user_id
    JOIN order_items oi ON oi.order_id = o.order_id
    WHERE o.status = 'paid'
      AND (oi.is_picked = 0 OR oi.is_picked IS NULL)
      AND o.pack_status = 0
      AND EXISTS (
        SELECT 1 FROM admin_logs al
        WHERE al.order_id = o.order_id
          AND al.action IN ('print_order_address', 'print_order_address_manual')
      )
      AND TIMESTAMPDIFF(HOUR, o.updated_at, NOW()) BETWEEN
            (CASE WHEN ${EARLY_BILLED_SQL} THEN ${earlyMinHours} ELSE ${minHours} END)
        AND (CASE WHEN ${EARLY_BILLED_SQL} THEN ${earlyMaxHours} ELSE ${maxHours} END)
    ORDER BY hours_stuck DESC
  `.trim();
}

export async function fetchStalePickItems(
  minHours: number,
  maxHours: number,
  earlyMinHours: number
): Promise<StalePickItem[]> {
  const config = metabaseConfig();
  if (!config) {
    throw new Error("Metabase belum dikonfigurasi (METABASE_URL/EMAIL/PASSWORD).");
  }

  const { columns, rows } = await fetchNativeQueryWithPagination(
    config,
    buildQuery(minHours, maxHours, earlyMinHours)
  );
  const idx = (name: string) => columns.indexOf(name);
  const iItem = idx("item_id");
  const iOrder = idx("order_id");
  const iName = idx("item_name");
  const iHours = idx("hours_stuck");
  const iUser = idx("user_name");
  const iShip = idx("shipping_type");
  const iEarly = idx("is_early");
  const iEta = idx("eta");

  return rows.map((row): StalePickItem => ({
    itemId: String(row[iItem] ?? "").trim(),
    orderId: String(row[iOrder] ?? "-").trim(),
    itemName: String(row[iName] ?? "-").trim() || "-",
    hours: Number(row[iHours] ?? 0),
    user: String(row[iUser] ?? "-").trim() || "-",
    shipping: String(row[iShip] ?? "-").trim() || "-",
    // Metabase mengembalikan boolean MySQL sebagai true/false atau 1/0 —
    // tergantung driver, jadi jangan bandingkan ke satu bentuk saja.
    isEarly: ["true", "1"].includes(String(row[iEarly]).toLowerCase()),
    eta: String(row[iEta] ?? "").trim()
  }));
}

/**
 * Gabungkan baris per-barang jadi satu entri per order. Usia yang dipakai =
 * yang paling lama; customer & kurir sama untuk semua barang dalam satu order.
 */
export function groupByOrder(items: StalePickItem[]): StalePickOrder[] {
  const byOrder = new Map<string, StalePickOrder>();

  for (const item of items) {
    if (!item.itemId || !item.orderId || item.orderId === "-") continue;

    const existing = byOrder.get(item.orderId);
    if (!existing) {
      byOrder.set(item.orderId, {
        orderId: item.orderId,
        itemIds: [item.itemId],
        itemNames: [item.itemName],
        hours: item.hours,
        user: item.user,
        shipping: item.shipping,
        isEarly: item.isEarly,
        eta: item.eta
      });
      continue;
    }
    existing.itemIds.push(item.itemId);
    existing.itemNames.push(item.itemName);
    existing.hours = Math.max(existing.hours, item.hours);
  }

  return [...byOrder.values()].sort((a, b) => b.hours - a.hours);
}

/** "26 jam" untuk order biasa; "4 hari" untuk yang ditagih early (angkanya besar). */
function stuckLabel(hours: number): string {
  if (hours < 48) return `${hours} jam`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} hari ${rest} jam` : `${days} hari`;
}

/** Embed satu order (dipasang bareng satu dropdown). */
export function orderEmbed(order: StalePickOrder): EmbedBuilder {
  const count = order.itemNames.length;

  const embed = new EmbedBuilder()
    .setColor(order.isEarly ? EMBED_COLOR_EARLY : EMBED_COLOR)
    .setTitle(
      order.isEarly
        ? `🟣 #${order.orderId} — ditagih early · nyangkut ${stuckLabel(order.hours)} · ${count} barang`
        : `🔴 #${order.orderId} — nyangkut di PICK ${stuckLabel(order.hours)} · ${count} barang`
    );

  // Judul jadi link ke halaman ordernya di admin — satu klik, tanpa copy nomor.
  const url = adminOrderUrl(order.orderId);
  if (url) embed.setURL(url);

  if (order.isEarly) {
    // Konteks yang menentukan jawaban staf: pembeli sudah dilunasi SEBELUM
    // barangnya sampai, jadi "belum di-pick" bisa jadi memang karena barangnya
    // belum datang — bukan kelalaian gudang.
    embed.setDescription(
      "Pelunasan ditagih **sebelum barangnya datang** (tombol Early di panel PO), " +
        "lalu ordernya di-print supaya barangnya disiapkan. " +
        "Kalau barangnya memang belum sampai, pilih **Masih antri pick** dan sebutkan di deskripsi." +
        (order.eta ? `\nPerkiraan barang datang: **${order.eta}**` : "")
    );
  }

  return embed
    .addFields(
      { name: "Barang", value: itemListValue(order.itemNames, order.itemIds), inline: false },
      { name: "Customer", value: order.user, inline: true },
      { name: "Kurir", value: order.shipping, inline: true }
    )
    .setFooter({
      text: order.isEarly
        ? `Ditagih early — ambang ${Math.round(env.PICK_TRIAGE_EARLY_MIN_HOURS / 24)} hari, bukan 24 jam`
        : "Pilih status di dropdown bawah, lalu isi deskripsi"
    });
}

/**
 * Satu putaran cek. Kirim HANYA order yang belum pernah diposting & belum
 * dijawab — jadi tiap order muncul sekali, tepat setelah barangnya lewat 24
 * jam. Kalau tidak ada yang baru: diam (tidak ada pesan "tidak ada"), supaya
 * poller tidak menyampah tiap 15 menit.
 *
 * Return jumlah ORDER yang dikirim (dipakai tes/log).
 */
export async function runPickTriageCheck(client: Client): Promise<number> {
  const channelId = env.PICK_TRIAGE_CHANNEL_ID;
  if (!channelId) {
    console.warn("[pick-triage] PICK_TRIAGE_CHANNEL_ID kosong — skip.");
    return 0;
  }

  const minHours = env.PICK_TRIAGE_MIN_HOURS;
  const maxHours = env.PICK_TRIAGE_MAX_HOURS;
  const earlyMinHours = env.PICK_TRIAGE_EARLY_MIN_HOURS;

  let items: StalePickItem[];
  try {
    items = await fetchStalePickItems(minHours, maxHours, earlyMinHours);
  } catch (error) {
    console.error("[pick-triage] gagal ambil data dari Metabase:", error);
    return 0;
  }

  // Yang baru: belum pernah diposting, belum dijawab, DAN barangnya belum
  // pernah dikirim satu-satu oleh versi lama (store lama ber-key item) —
  // tanpa cek terakhir, deploy ini akan mengirim ulang order yang barangnya
  // sudah nangkring di channel.
  const fresh = groupByOrder(items).filter(
    (o) => !isPosted(o.orderId) && !isResolved(o.orderId) && !o.itemIds.some(hasLegacyItem)
  );
  if (fresh.length === 0) return 0;

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.error("[pick-triage] channel tidak ditemukan / bukan text:", channelId);
    return 0;
  }
  const textChannel = channel as TextChannel;

  // Pengaman ledakan: kalau store hilang (mis. redeploy tanpa volume), band
  // 24-30 jam sudah membatasi, tapi cap ini menjaga kalau tetap banyak.
  const shown = fresh.slice(0, env.PICK_TRIAGE_MAX_ITEMS);
  if (fresh.length > shown.length) {
    console.warn(`[pick-triage] ${fresh.length - shown.length} order tidak dikirim (cap MAX_ITEMS=${env.PICK_TRIAGE_MAX_ITEMS}).`);
  }

  for (const order of shown) {
    const posted: PostedOrder = {
      orderId: order.orderId,
      itemIds: order.itemIds,
      itemNames: order.itemNames,
      user: order.user,
      shipping: order.shipping,
      hours: order.hours,
      isEarly: order.isEarly,
      eta: order.eta,
      channelId,
      messageId: "" // diisi setelah pesan terkirim
    };
    // Mention HANYA untuk order biasa (24 jam). Order yang ditagih early memang
    // wajar lambat — barangnya boleh jadi belum datang — jadi tidak perlu
    // memburu siapa pun.
    const mention =
      !order.isEarly && env.PICK_TRIAGE_MENTION_USER_ID
        ? `<@${env.PICK_TRIAGE_MENTION_USER_ID}>`
        : undefined;

    const message = await textChannel.send({
      ...(mention ? { content: mention } : {}),
      embeds: [orderEmbed(order)],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buildTriageSelect(posted))],
      // Batasi siapa yang benar-benar kena ping: tanpa ini, teks lain di embed
      // yang kebetulan berbentuk mention bisa ikut memberi notifikasi.
      allowedMentions: { users: mention ? [env.PICK_TRIAGE_MENTION_USER_ID] : [] }
    });
    markPosted({ ...posted, messageId: message.id });
  }

  const itemCount = shown.reduce((sum, o) => sum + o.itemIds.length, 0);
  const earlyCount = shown.filter((o) => o.isEarly).length;
  console.log(
    `[pick-triage] ${shown.length} order (${itemCount} barang) terkirim — ` +
      `${shown.length - earlyCount} lewat ${minHours} jam, ${earlyCount} ditagih early lewat ${earlyMinHours} jam.`
  );
  return shown.length;
}

export function startPickTriageScheduler(client: Client): void {
  if (!env.PICK_TRIAGE_ENABLED) {
    console.log("[pick-triage] poller nonaktif (PICK_TRIAGE_ENABLED=false).");
    return;
  }

  const intervalMs = env.PICK_TRIAGE_POLL_MINUTES * 60_000;
  let running = false;

  // Poll, bukan cron: begitu ada barang yang baru lewat 24 jam, langsung kirih
  // saat itu juga — tidak perlu nunggu jam 09:00. Guard `running` supaya putaran
  // yang lambat (Metabase lelet) tidak numpuk dengan putaran berikutnya.
  const tick = async () => {
    if (running) {
      console.warn("[pick-triage] putaran sebelumnya belum selesai — lewati.");
      return;
    }
    running = true;
    try {
      await runPickTriageCheck(client);
    } catch (err) {
      console.error("[pick-triage] gagal cek:", err);
    } finally {
      running = false;
    }
  };

  setInterval(tick, intervalMs).unref?.();
  void tick(); // cek sekali langsung saat start
  console.log(`[pick-triage] poller aktif — cek tiap ${env.PICK_TRIAGE_POLL_MINUTES} menit, kirim begitu barang lewat ${env.PICK_TRIAGE_MIN_HOURS} jam.`);
}
