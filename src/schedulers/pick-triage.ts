import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Client,
  type TextChannel
} from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { markPosted, isPosted, isResolved, type PostedItem } from "../services/pickTriageStore.js";
import { buildTriageSelect } from "../handlers/pickTriage.js";

/**
 * Triase interaktif "PICK nyangkut >= N jam" (default band 24-48 jam).
 *
 * Beda dengan fulfillment-stale.ts (digest read-only, level order, 3-30 hari):
 * ini LEVEL BARANG (order_items), khusus stage PICK, dan interaktif — tiap
 * barang punya dropdown 3 opsi (masih antri / rusak / belum ketemu) yang saat
 * dipilih membuka modal deskripsi lalu menghasilkan embed balasan.
 *
 * Logika stage PICK dijaga konsisten dengan App\Support\FulfillmentStale di
 * kyou.id & fulfillment-stale.ts: order sudah di-print (masuk PICK), belum
 * di-pack, dan barang (order_items) belum di-pick.
 *
 * Bukan cron harian: bot POLL tiap PICK_TRIAGE_POLL_MINUTES menit dan mengirim
 * barang begitu dia melewati 24 jam. Dedupe lewat store (`posted`), jadi tiap
 * barang muncul tepat sekali. Kalau tidak ada yang baru → diam, tidak ada pesan
 * "tidak ada" (kalau tidak, channel kebanjiran tiap putaran).
 *
 * Format: SATU pesan per barang (1 embed + 1 dropdown), biar rapi & jelas siapa
 * jawab apa.
 *
 * Batas atas MAX_HOURS tetap dipakai sebagai pengaman: kalau store hilang (mis.
 * redeploy tanpa volume di data/), tanpa batas atas bot akan memblast ULANG
 * seluruh backlog (pernah ada barang nyangkut 1378 jam).
 */

const EMBED_COLOR = 0xd9534f;

type StalePickItem = {
  itemId: string;
  orderId: string;
  itemName: string;
  hours: number;
  user: string;
  shipping: string;
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

function buildQuery(minHours: number, maxHours: number): string {
  // HANYA band [minHours, maxHours] jam — barang yang BARU lewat 24 jam.
  // Yang nyangkut lebih lama dari maxHours SENGAJA tidak dikirim: itu ranah
  // digest fulfillment-stale (3-30 hari), bukan triase harian ini. Jangan
  // tambahkan mode cutoff absolut lagi — pernah bikin barang 1378 jam ikut
  // terkirim dan membanjiri channel.

  // Tanpa LIMIT — fetchNativeQueryWithPagination yang menambah LIMIT/OFFSET.
  return `
    SELECT
      oi.id AS item_id,
      o.order_id AS order_id,
      oi.item_name AS item_name,
      ROUND(TIMESTAMPDIFF(HOUR, o.updated_at, NOW())) AS hours_stuck,
      u.name AS user_name,
      o.shipping_type AS shipping_type
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
      AND TIMESTAMPDIFF(HOUR, o.updated_at, NOW()) BETWEEN ${minHours} AND ${maxHours}
    ORDER BY hours_stuck DESC
  `.trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export async function fetchStalePickItems(minHours: number, maxHours: number): Promise<StalePickItem[]> {
  const config = metabaseConfig();
  if (!config) {
    throw new Error("Metabase belum dikonfigurasi (METABASE_URL/EMAIL/PASSWORD).");
  }

  const { columns, rows } = await fetchNativeQueryWithPagination(config, buildQuery(minHours, maxHours));
  const idx = (name: string) => columns.indexOf(name);
  const iItem = idx("item_id");
  const iOrder = idx("order_id");
  const iName = idx("item_name");
  const iHours = idx("hours_stuck");
  const iUser = idx("user_name");
  const iShip = idx("shipping_type");

  return rows.map((row): StalePickItem => ({
    itemId: String(row[iItem] ?? "").trim(),
    orderId: String(row[iOrder] ?? "-").trim(),
    itemName: String(row[iName] ?? "-").trim() || "-",
    hours: Number(row[iHours] ?? 0),
    user: String(row[iUser] ?? "-").trim() || "-",
    shipping: String(row[iShip] ?? "-").trim() || "-"
  }));
}

/** Embed satu barang (dipasang bareng satu dropdown). */
function itemEmbed(item: StalePickItem): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(`🔴 #${item.orderId} — nyangkut di PICK ${item.hours} jam`)
    .addFields(
      { name: "Barang", value: truncate(item.itemName, 240), inline: false },
      { name: "Customer", value: item.user, inline: true },
      { name: "Kurir", value: item.shipping, inline: true }
    )
    .setFooter({ text: "Pilih status di dropdown bawah, lalu isi deskripsi" });
}

/**
 * Satu putaran cek. Kirim HANYA barang yang belum pernah diposting & belum
 * dijawab — jadi tiap barang muncul sekali, tepat setelah dia lewat 24 jam.
 * Kalau tidak ada yang baru: diam (tidak ada pesan "tidak ada"), supaya poller
 * tidak menyampah tiap 15 menit.
 *
 * Return jumlah barang yang dikirim (dipakai tes/log).
 */
export async function runPickTriageCheck(client: Client): Promise<number> {
  const channelId = env.PICK_TRIAGE_CHANNEL_ID;
  if (!channelId) {
    console.warn("[pick-triage] PICK_TRIAGE_CHANNEL_ID kosong — skip.");
    return 0;
  }

  const minHours = env.PICK_TRIAGE_MIN_HOURS;
  const maxHours = env.PICK_TRIAGE_MAX_HOURS;

  let items: StalePickItem[];
  try {
    items = await fetchStalePickItems(minHours, maxHours);
  } catch (error) {
    console.error("[pick-triage] gagal ambil data dari Metabase:", error);
    return 0;
  }

  // Yang baru: itemId valid, belum pernah diposting, belum dijawab.
  const fresh = items.filter((it) => it.itemId && !isPosted(it.itemId) && !isResolved(it.itemId));
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
    console.warn(`[pick-triage] ${fresh.length - shown.length} barang tidak dikirim (cap MAX_ITEMS=${env.PICK_TRIAGE_MAX_ITEMS}).`);
  }

  for (const item of shown) {
    const posted: PostedItem = {
      itemId: item.itemId,
      orderId: item.orderId,
      itemName: item.itemName,
      user: item.user,
      shipping: item.shipping,
      hours: item.hours,
      channelId,
      messageId: "" // diisi setelah pesan terkirim
    };
    const message = await textChannel.send({
      embeds: [itemEmbed(item)],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buildTriageSelect(posted))]
    });
    markPosted({ ...posted, messageId: message.id });
  }

  console.log(`[pick-triage] ${shown.length} barang baru lewat ${minHours} jam — terkirim.`);
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
