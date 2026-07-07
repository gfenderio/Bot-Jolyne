import cron from "node-cron";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";

/**
 * Digest harian "order belum diproses > N hari" di fulfillment kyou.id.
 *
 * Sumber data: Metabase (native query, DB id dari METABASE_DATABASE_ID) — pola
 * sama dengan machitan/ecommercePickRequestPoller. Logika stage "nyangkut"
 * (PRINT -> PICK -> PACK -> RESI) SENGAJA dibuat identik dengan
 * App\Support\FulfillmentStale di repo kyou.id; kalau salah satu diubah,
 * samakan yang lain supaya badge UI & digest ini tidak berbeda.
 *
 * Angka yang ditampilkan = orders.order_id (nomor yang sama di admin), satu
 * baris per order (di-rollup, bukan per item).
 */

type StaleStage = "PRINT" | "PICK" | "PACK" | "RESI";

type StaleOrder = {
  orderId: string;
  days: number;
  stage: StaleStage;
  items: string;
  user: string;
  shipping: string;
};

// Urutan tampil + label per stage (urut lifecycle fulfillment).
const STAGE_META: Record<StaleStage, { emoji: string; label: string }> = {
  PRINT: { emoji: "🔵", label: "Nyangkut di PRINT" },
  PICK: { emoji: "🔴", label: "Nyangkut di PICK" },
  PACK: { emoji: "🟡", label: "Nyangkut di PACK" },
  RESI: { emoji: "🚚", label: "Nyangkut di RESI" },
};

const STAGE_ORDER: StaleStage[] = ["PRINT", "PICK", "PACK", "RESI"];

const EMBED_COLOR = 0xf0ad4e;
const MAX_FIELD_CHARS = 1000; // batas aman < 1024 (limit Discord)
// Cap jumlah order yang ditampilkan: prod punya ratusan order paid lama
// (abandoned) yang literal "belum diproses" tapi bukan actionable. Tampilkan
// yang paling lama saja + ringkasan sisanya, sekaligus jaga limit embed
// (max 25 field / 6000 char).
const MAX_ORDERS_SHOWN = 40;

function metabaseConfig(): MetabaseConfig | null {
  if (!env.METABASE_URL || !env.METABASE_EMAIL || !env.METABASE_PASSWORD) {
    return null;
  }
  return {
    url: env.METABASE_URL,
    email: env.METABASE_EMAIL,
    password: env.METABASE_PASSWORD,
    databaseId: env.METABASE_DATABASE_ID,
  };
}

function buildQuery(thresholdDays: number, maxDays: number): string {
  // Tanpa LIMIT — fetchNativeQueryWithPagination yang menambah LIMIT/OFFSET.
  return `
    SELECT
      o.order_id AS order_id,
      DATEDIFF(NOW(), o.updated_at) AS days_stuck,
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM admin_logs al
          WHERE al.order_id = o.order_id
            AND al.action IN ('print_order_address', 'print_order_address_manual')
        ) THEN 'PRINT'
        WHEN EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi.order_id = o.order_id AND (oi.is_picked = 0 OR oi.is_picked IS NULL)
        ) OR EXISTS (
          SELECT 1 FROM order_bo ob
          WHERE ob.order_id = o.order_id AND (ob.is_picked = 0 OR ob.is_picked IS NULL)
        ) THEN 'PICK'
        WHEN o.pack_status = 0 THEN 'PACK'
        ELSE 'RESI'
      END AS stuck_stage,
      (
        SELECT GROUP_CONCAT(oi2.item_name SEPARATOR ' | ')
        FROM order_items oi2 WHERE oi2.order_id = o.order_id
      ) AS items,
      u.name AS user_name,
      o.shipping_type AS shipping_type
    FROM orders o
    JOIN users u ON u.user_id = o.user_id
    WHERE o.status = 'paid'
      AND DATEDIFF(NOW(), o.updated_at) BETWEEN ${thresholdDays} AND ${maxDays}
    ORDER BY days_stuck DESC
  `.trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export async function fetchStaleOrders(
  thresholdDays: number,
  maxDays: number
): Promise<StaleOrder[]> {
  const config = metabaseConfig();
  if (!config) {
    throw new Error("Metabase belum dikonfigurasi (METABASE_URL/EMAIL/PASSWORD).");
  }

  const { columns, rows } = await fetchNativeQueryWithPagination(config, buildQuery(thresholdDays, maxDays));
  const idx = (name: string) => columns.indexOf(name);
  const iOrder = idx("order_id");
  const iDays = idx("days_stuck");
  const iStage = idx("stuck_stage");
  const iItems = idx("items");
  const iUser = idx("user_name");
  const iShip = idx("shipping_type");

  return rows.map((row): StaleOrder => {
    const stageRaw = String(row[iStage] ?? "").toUpperCase();
    const stage = (STAGE_ORDER as string[]).includes(stageRaw) ? (stageRaw as StaleStage) : "PICK";
    return {
      orderId: String(row[iOrder] ?? "-").trim(),
      days: Number(row[iDays] ?? 0),
      stage,
      items: String(row[iItems] ?? "-").trim() || "-",
      user: String(row[iUser] ?? "-").trim() || "-",
      shipping: String(row[iShip] ?? "-").trim() || "-",
    };
  });
}

function formatLine(order: StaleOrder): string {
  return `\`#${order.orderId}\` ${truncate(order.items, 60)} — **${order.days} hari** · ${order.user} · ${order.shipping}`;
}

/** Pecah baris jadi beberapa field <= MAX_FIELD_CHARS (limit value Discord 1024). */
function chunkLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > MAX_FIELD_CHARS) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildDigestEmbed(
  orders: StaleOrder[],
  thresholdDays: number,
  maxDays: number
): EmbedBuilder {
  const jakartaNow = new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  const window = `${thresholdDays}-${maxDays} hari`;

  if (orders.length === 0) {
    return new EmbedBuilder()
      .setTitle(`✅ Tidak ada order nyangkut ${window}`)
      .setDescription("Semua order fulfillment sudah diproses dalam batas waktu. Mantap.")
      .setColor(0x2f8f5b)
      .setFooter({ text: `Rekap ${jakartaNow} WIB · anchor updated_at` });
  }

  // Urut paling lama dulu, lalu batasi jumlah yang ditampilkan.
  const sorted = [...orders].sort((a, b) => b.days - a.days);
  const shown = sorted.slice(0, MAX_ORDERS_SHOWN);
  const overflow = orders.length - shown.length;

  const embed = new EmbedBuilder()
    .setTitle(`⏳ Order nyangkut ${window} — ${orders.length} order`)
    .setDescription(
      `Belum tuntas diproses ${window} sejak update terakhir (anchor \`updated_at\`). Order > ${maxDays} hari dianggap abandoned & tidak dihitung.` +
        (overflow > 0 ? `\nMenampilkan ${shown.length} paling lama; **${overflow} order lagi** tidak ditampilkan.` : "")
    )
    .setColor(EMBED_COLOR)
    .setFooter({ text: `Sumber: Metabase (DB ${env.METABASE_DATABASE_ID}) · rekap ${jakartaNow} WIB` });

  for (const stage of STAGE_ORDER) {
    const group = shown.filter((o) => o.stage === stage);
    if (group.length === 0) continue;

    const meta = STAGE_META[stage];
    const chunks = chunkLines(group.map(formatLine));
    chunks.forEach((chunk, i) => {
      const name = i === 0
        ? `${meta.emoji} ${meta.label} · ${group.length}`
        : `${meta.emoji} ${meta.label} (lanjutan)`;
      embed.addFields({ name, value: chunk });
    });
  }

  return embed;
}

export async function sendFulfillmentStaleDigest(client: Client): Promise<void> {
  const channelId = env.FULFILLMENT_STALE_CHANNEL_ID;
  if (!channelId) {
    console.warn("[fulfillment-stale] FULFILLMENT_STALE_CHANNEL_ID kosong — skip.");
    return;
  }

  const thresholdDays = env.FULFILLMENT_STALE_THRESHOLD_DAYS;
  const maxDays = env.FULFILLMENT_STALE_MAX_DAYS;
  let orders: StaleOrder[];
  try {
    orders = await fetchStaleOrders(thresholdDays, maxDays);
  } catch (error) {
    console.error("[fulfillment-stale] gagal ambil data dari Metabase:", error);
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    console.error("[fulfillment-stale] channel tidak ditemukan / bukan text:", channelId);
    return;
  }

  await (channel as TextChannel).send({ embeds: [buildDigestEmbed(orders, thresholdDays, maxDays)] });
  console.log(`[fulfillment-stale] digest terkirim — ${orders.length} order nyangkut.`);
}

export function startFulfillmentStaleScheduler(client: Client): void {
  if (!env.FULFILLMENT_STALE_ENABLED) {
    console.log("[fulfillment-stale] scheduler nonaktif (FULFILLMENT_STALE_ENABLED=false).");
    return;
  }

  // Setiap hari 09:00 WIB.
  cron.schedule(
    "0 9 * * *",
    () => {
      console.log("[fulfillment-stale] menjalankan digest harian 09:00 WIB...");
      sendFulfillmentStaleDigest(client).catch((err) =>
        console.error("[fulfillment-stale] gagal kirim digest:", err)
      );
    },
    { timezone: "Asia/Jakarta" }
  );
  console.log("[fulfillment-stale] scheduler aktif — harian 09:00 WIB.");
}
