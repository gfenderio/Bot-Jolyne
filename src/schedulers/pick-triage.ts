import cron from "node-cron";
import {
  ActionRowBuilder,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Client,
  type TextChannel
} from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import {
  markPosted,
  isResolved,
  getSentMessages,
  setSentMessages,
  type PostedItem
} from "../services/pickTriageStore.js";
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
 * Format: SATU pesan per barang (1 embed + 1 dropdown), biar rapi & jelas siapa
 * jawab apa. Tiap run, pesan run sebelumnya dihapus dulu supaya channel tidak
 * numpuk. Kalau tidak ada barang nyangkut → kirim satu pesan "tidak ada".
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

// Format datetime SQL yang diterima untuk cutoff absolut: "YYYY-MM-DD HH:MM:SS"
// (atau tanpa detik). Divalidasi supaya tidak jadi celah injection dari env.
const SINCE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

function normalizeSince(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  if (!SINCE_RE.test(value)) {
    console.warn(`[pick-triage] PICK_TRIAGE_SINCE format tidak valid ("${value}"), diabaikan. Pakai "YYYY-MM-DD HH:MM:SS".`);
    return null;
  }
  return value;
}

function buildQuery(minHours: number, maxHours: number, since: string | null): string {
  // Dua mode:
  // - `since` diisi (mode CONTOH): ambil semua barang yang updated_at-nya sudah
  //   <= waktu itu (nyangkut sejak jam segitu ke belakang), tanpa batas atas.
  // - normal (harian): band [minHours, maxHours] jam — hanya barang yang BARU
  //   lewat 24 jam ("24 jam terakhir"), supaya batch harian tidak menumpuk.
  const window = since
    ? `AND o.updated_at <= '${since}'`
    : `AND TIMESTAMPDIFF(HOUR, o.updated_at, NOW()) BETWEEN ${minHours} AND ${maxHours}`;

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
      ${window}
    ORDER BY hours_stuck DESC
  `.trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export async function fetchStalePickItems(
  minHours: number,
  maxHours: number,
  since: string | null = null
): Promise<StalePickItem[]> {
  const config = metabaseConfig();
  if (!config) {
    throw new Error("Metabase belum dikonfigurasi (METABASE_URL/EMAIL/PASSWORD).");
  }

  const { columns, rows } = await fetchNativeQueryWithPagination(config, buildQuery(minHours, maxHours, since));
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

const CHOICE_HINT = "🕒 Masih antri pick · 💔 Barang rusak · 🔍 Belum ketemu";

function buildLeadEmbed(shownCount: number, overflow: number, windowLabel: string): EmbedBuilder {
  const jakartaNow = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  return new EmbedBuilder()
    .setTitle(`🔴 ${shownCount} barang nyangkut di PICK (${windowLabel})`)
    .setDescription(
      "Belum di-pick padahal sudah lewat batas. Tiap barang di bawah ini ada dropdown-nya — pilih status lalu isi deskripsi:\n" +
        `${CHOICE_HINT}` +
        (overflow > 0 ? `\n\n*Menampilkan ${shownCount} terlama; **${overflow} barang lagi** tidak ditampilkan.*` : "")
    )
    .setColor(EMBED_COLOR)
    .setFooter({ text: `Sumber: Metabase (DB ${env.METABASE_DATABASE_ID}) · ${jakartaNow} WIB` });
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

/** Hapus pesan-pesan run sebelumnya supaya channel tidak numpuk. */
async function deletePreviousMessages(client: Client): Promise<void> {
  const prev = getSentMessages();
  if (!prev || prev.messageIds.length === 0) return;

  const channel = await client.channels.fetch(prev.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) return;

  for (const id of prev.messageIds) {
    await (channel as TextChannel).messages.delete(id).catch(() => {});
  }
  console.log(`[pick-triage] hapus ${prev.messageIds.length} pesan run sebelumnya.`);
}

export async function sendPickTriageDigest(client: Client): Promise<void> {
  const channelId = env.PICK_TRIAGE_CHANNEL_ID;
  if (!channelId) {
    console.warn("[pick-triage] PICK_TRIAGE_CHANNEL_ID kosong — skip.");
    return;
  }

  const minHours = env.PICK_TRIAGE_MIN_HOURS;
  const maxHours = env.PICK_TRIAGE_MAX_HOURS;
  const since = normalizeSince(env.PICK_TRIAGE_SINCE);
  if (since) {
    console.log(`[pick-triage] pakai cutoff absolut updated_at <= '${since}' (mode contoh).`);
  }

  let items: StalePickItem[];
  try {
    items = await fetchStalePickItems(minHours, maxHours, since);
  } catch (error) {
    console.error("[pick-triage] gagal ambil data dari Metabase:", error);
    return;
  }

  // Buang yang sudah pernah dijawab + yang tanpa itemId valid.
  const pending = items.filter((it) => it.itemId && !isResolved(it.itemId));

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.error("[pick-triage] channel tidak ditemukan / bukan text:", channelId);
    return;
  }
  const textChannel = channel as TextChannel;

  // Bersihkan dulu pesan run sebelumnya (kirim ulang bersih tiap run).
  await deletePreviousMessages(client);

  const windowLabel = since ? `sejak ${since}` : `${minHours}-${maxHours} jam terakhir`;
  const sentIds: string[] = [];

  if (pending.length === 0) {
    const msg = await textChannel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`✅ Tidak ada barang nyangkut di PICK (${windowLabel})`)
          .setDescription("Semua barang yang sudah di-print sudah dipick dalam batas waktu, atau sisanya sudah ditriase.")
          .setColor(0x2f8f5b)
      ]
    });
    setSentMessages(channelId, [msg.id]);
    console.log("[pick-triage] tidak ada barang nyangkut — pesan kosong terkirim.");
    return;
  }

  const shown = pending.slice(0, env.PICK_TRIAGE_MAX_ITEMS);
  const overflow = pending.length - shown.length;

  const lead = await textChannel.send({ embeds: [buildLeadEmbed(shown.length, overflow, windowLabel)] });
  sentIds.push(lead.id);

  // Satu pesan per barang: 1 embed + 1 dropdown.
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
    sentIds.push(message.id);
  }

  setSentMessages(channelId, sentIds);
  console.log(`[pick-triage] terkirim — ${shown.length} barang (1 pesan/barang), ${overflow} overflow.`);
}

export function startPickTriageScheduler(client: Client): void {
  if (!env.PICK_TRIAGE_ENABLED) {
    console.log("[pick-triage] scheduler nonaktif (PICK_TRIAGE_ENABLED=false).");
    return;
  }

  cron.schedule(
    "0 9 * * *",
    () => {
      console.log("[pick-triage] menjalankan triase harian 09:00 WIB...");
      sendPickTriageDigest(client).catch((err) =>
        console.error("[pick-triage] gagal kirim digest:", err)
      );
    },
    { timezone: "Asia/Jakarta" }
  );
  console.log("[pick-triage] scheduler aktif — harian 09:00 WIB.");

  if (env.PICK_TRIAGE_RUN_ON_START) {
    console.log("[pick-triage] RUN_ON_START aktif — kirim digest sekarang...");
    sendPickTriageDigest(client).catch((err) =>
      console.error("[pick-triage] gagal kirim digest (run-on-start):", err)
    );
  }
}
