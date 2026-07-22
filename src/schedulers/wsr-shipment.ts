import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { getOrInitWatermark, setWatermark } from "../services/wsrShipmentStore.js";

/**
 * Kiriman WSR → PENGUMUMAN + Excel ke channel gudang. Titik.
 *
 * Keputusan 22 Jul: Jolyne TIDAK berperan sebagai tiket. Tracking & penilaian
 * kerjaan tim WH tetap lewat tiket Mornye (/wh-ticket) yang diajukan manual
 * seperti biasa — sistem tiket (thread, tombol claim/close, rating di
 * purchasing_ticket_feedbacks, arsip shiro) seluruhnya milik Mornye dan tidak
 * ditiru dari luar. Jolyne cuma memastikan gudang menerima daftar barangnya
 * (Excel urut rak) begitu kiriman dibuat di PDA.
 *
 * Sumber data: tabel `wsr_batches` + `wsr_batch_items` via Metabase (readonly).
 * Skema hasil normalisasi review Shanieulle: nama barang/gudang/rak/orang
 * TIDAK disalin ke tabel batch — di-JOIN dari `items`/`item_sources`/`racks`/
 * `users` (string hanya hidup di tabel asalnya).
 */

interface ShipmentRow {
  id: number;
  unit: string;
  direction: string;
  status: string;
  totalItems: number;
  totalQty: number;
  createdBy: string;
  executedBy: string;
  executedAt: string;
  createdAt: string;
}

interface ShipmentItem {
  batchId: number;
  itemId: string;
  name: string;
  barcode: string;
  source: string;
  destination: string;
  qty: number;
  rack: string;
  status: string;
  error: string;
}

/** Arah internal → kalimat yang dimengerti orang gudang. */
const ARAH: Record<string, string> = {
  request: "Gudang → Toko (isi toko)",
  return: "Toko → Gudang (pulangkan barang lama)",
  event: "Kirim ke lokasi lain"
};

function metabaseConfig(): MetabaseConfig | null {
  if (!env.METABASE_URL || !env.METABASE_EMAIL || !env.METABASE_PASSWORD) return null;
  return {
    url: env.METABASE_URL,
    email: env.METABASE_EMAIL,
    password: env.METABASE_PASSWORD,
    databaseId: env.METABASE_DATABASE_ID
  };
}

const maxIdQuery = () => `SELECT COALESCE(MAX(id), 0) AS max_id FROM wsr_batches`;

// Nama orang di-join dari users (skema normalisasi: created_by = users.user_id).
const batchSelect = `
  SELECT b.id, b.unit, b.direction, b.status, b.total_items, b.total_qty,
         COALESCE(cu.name, '-') AS created_by, COALESCE(eu.name, '-') AS executed_by,
         COALESCE(b.executed_at, '') AS executed_at, b.created_at
  FROM wsr_batches b
  LEFT JOIN users cu ON cu.user_id = b.created_by
  LEFT JOIN users eu ON eu.user_id = b.executed_by
`;

const newShipmentsQuery = (sejakId: number) => `
  ${batchSelect}
  WHERE b.id > ${sejakId} AND b.status = 'pending'
  ORDER BY b.id ASC
`;

// Isi kiriman: semua string di-join dari tabel asalnya (items/item_sources/racks).
const itemsQuery = (ids: number[]) => `
  SELECT i.batch_id, i.item_id, it.name, COALESCE(it.barcode, '') AS barcode,
         ss.name AS source, sd.name AS destination, i.qty,
         COALESCE(r.name, '') AS rack, i.status, COALESCE(i.error, '') AS error
  FROM wsr_batch_items i
  JOIN items it ON it.item_id = i.item_id
  JOIN item_sources ss ON ss.id = i.source_id
  JOIN item_sources sd ON sd.id = i.destination_id
  LEFT JOIN racks r ON r.id = i.rack_id
  WHERE i.batch_id IN (${ids.join(",")})
  ORDER BY i.id ASC
`;

function rowsToShipments(columns: string[], rows: unknown[][]): ShipmentRow[] {
  const idx = (name: string) => columns.indexOf(name);
  return rows.map((row) => ({
    id: Number(row[idx("id")] ?? 0),
    unit: String(row[idx("unit")] ?? ""),
    direction: String(row[idx("direction")] ?? ""),
    status: String(row[idx("status")] ?? ""),
    totalItems: Number(row[idx("total_items")] ?? 0),
    totalQty: Number(row[idx("total_qty")] ?? 0),
    createdBy: String(row[idx("created_by")] ?? "-"),
    executedBy: String(row[idx("executed_by")] ?? "-"),
    executedAt: String(row[idx("executed_at")] ?? ""),
    createdAt: String(row[idx("created_at")] ?? "")
  }));
}

async function fetchItems(config: MetabaseConfig, batchIds: number[]): Promise<Map<number, ShipmentItem[]>> {
  const out = new Map<number, ShipmentItem[]>();
  if (batchIds.length === 0) return out;
  const { columns, rows } = await fetchNativeQueryWithPagination(config, itemsQuery(batchIds));
  const idx = (name: string) => columns.indexOf(name);
  for (const row of rows) {
    const item: ShipmentItem = {
      batchId: Number(row[idx("batch_id")] ?? 0),
      itemId: String(row[idx("item_id")] ?? ""),
      name: String(row[idx("name")] ?? ""),
      barcode: String(row[idx("barcode")] ?? ""),
      source: String(row[idx("source")] ?? ""),
      destination: String(row[idx("destination")] ?? ""),
      qty: Number(row[idx("qty")] ?? 0),
      rack: String(row[idx("rack")] ?? ""),
      status: String(row[idx("status")] ?? "pending"),
      error: String(row[idx("error")] ?? "")
    };
    const list = out.get(item.batchId) ?? [];
    list.push(item);
    out.set(item.batchId, list);
  }
  return out;
}

/** Satu kiriman = satu sheet siap cetak; urut per rak — gudang jalan sekali lewat. */
export async function buildShipmentWorkbook(shipment: ShipmentRow, items: ShipmentItem[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`Kiriman ${shipment.id}`, {
    views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
    pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 22 }
  });

  sheet.mergeCells("A1:G1");
  const title = sheet.getCell("A1");
  title.value = `Kiriman WSR #${shipment.id} — ${shipment.unit}`;
  title.font = { name: "Segoe UI Semibold", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00695C" } };
  sheet.getRow(1).height = 32;

  sheet.mergeCells("A2:G2");
  const subtitle = sheet.getCell("A2");
  subtitle.value =
    `${ARAH[shipment.direction] ?? shipment.direction}    ` +
    `${shipment.totalItems} barang    ${shipment.totalQty} pcs    ` +
    `Dibuat: ${shipment.createdBy}`;
  subtitle.font = { name: "Segoe UI", size: 10, color: { argb: "FF424242" }, italic: true };
  subtitle.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  subtitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0F2F1" } };
  sheet.getRow(2).height = 22;

  sheet.getRow(3).height = 6;

  // Tanpa `header` di columns: ExcelJS menulis header dari `columns` ke baris 1
  // dan menimpa judul yang di-merge (bug yang pernah ketangkap). Header manual
  // di baris 4.
  sheet.columns = [
    { key: "rack", width: 12 },
    { key: "itemId", width: 11 },
    { key: "barcode", width: 16 },
    { key: "name", width: 46 },
    { key: "source", width: 12 },
    { key: "destination", width: 12 },
    { key: "qty", width: 8 }
  ];

  const headerRow = sheet.getRow(4);
  headerRow.values = ["Rak", "Item ID", "Barcode", "Nama Barang", "Dari", "Ke", "Qty"];
  headerRow.eachCell((cell) => {
    cell.font = { name: "Segoe UI Semibold", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF00897B" } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });
  headerRow.height = 24;

  const sorted = [...items].sort((a, b) => (a.rack || "￿").localeCompare(b.rack || "￿"));
  for (const item of sorted) {
    sheet.addRow({
      rack: item.rack || "-",
      itemId: item.itemId,
      barcode: item.barcode || "-",
      name: item.name,
      source: item.source,
      destination: item.destination,
      qty: item.qty
    });
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

function openingEmbed(shipment: ShipmentRow, items: ShipmentItem[]): EmbedBuilder {
  const perTujuan = new Map<string, number>();
  for (const item of items) {
    perTujuan.set(item.destination, (perTujuan.get(item.destination) ?? 0) + item.qty);
  }
  const rincian = [...perTujuan.entries()].map(([t, q]) => `**${t}** ${q} pcs`).join(" · ");

  return new EmbedBuilder()
    .setColor(0x00897b)
    .setTitle(`📦 Kiriman WSR #${shipment.id} — ${shipment.unit}`)
    .setDescription(
      `${ARAH[shipment.direction] ?? shipment.direction}\n\n` +
        `**${shipment.totalItems} barang · ${shipment.totalQty} pcs**\n${rincian}\n\n` +
        `Dibuat oleh **${shipment.createdBy}**.\n` +
        `Stok **belum** berpindah. Siapkan barangnya sesuai daftar terlampir, lalu ` +
        `buka menu **Kiriman** di PDA → **Pindahkan sekarang**. ` +
        `Jangan lupa ajukan tiketnya lewat /wh-ticket seperti biasa.`
    )
    .setFooter({ text: `Dibuat ${shipment.createdAt} WIB` })
    .setTimestamp();
}

export async function runWsrShipmentCheck(client: Client): Promise<void> {
  const config = metabaseConfig();
  if (!config) {
    console.warn("[wsr-shipment] Metabase belum dikonfigurasi — lewati.");
    return;
  }

  const max = await fetchNativeQueryWithPagination(config, maxIdQuery());
  const maxId = Number(max.rows[0]?.[0] ?? 0);
  if (!Number.isFinite(maxId)) return;

  const sejakId = getOrInitWatermark(maxId);
  if (maxId <= sejakId) return; // tak ada kiriman baru

  const res = await fetchNativeQueryWithPagination(config, newShipmentsQuery(sejakId));
  const shipments = rowsToShipments(res.columns, res.rows);
  if (shipments.length === 0) {
    setWatermark(maxId);
    return;
  }
  const itemsByBatch = await fetchItems(config, shipments.map((s) => s.id));

  const channel = (await client.channels.fetch(env.WSR_SHIPMENT_CHANNEL_ID).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    console.error(
      `[wsr-shipment] channel ${env.WSR_SHIPMENT_CHANNEL_ID} tidak ketemu — watermark TIDAK digeser supaya tidak ada kiriman yang hilang.`
    );
    return;
  }

  let terkirim = 0;
  for (const shipment of shipments) {
    try {
      const items = itemsByBatch.get(shipment.id) ?? [];
      const buffer = await buildShipmentWorkbook(shipment, items);
      const attachment = new AttachmentBuilder(buffer, {
        name: `Kiriman_WSR_${shipment.id}_${shipment.unit}.xlsx`
      });
      await channel.send({ embeds: [openingEmbed(shipment, items)], files: [attachment] });
      terkirim++;
    } catch (err) {
      console.error(`[wsr-shipment] gagal kirim kiriman #${shipment.id}:`, err);
    }
  }

  // Digeser SETELAH pesan terkirim — kegagalan kirim tidak membuat kiriman
  // hilang dari pantauan.
  setWatermark(maxId);
  console.log(`[wsr-shipment] ${terkirim} kiriman diumumkan ke channel.`);
}

export function startWsrShipmentScheduler(client: Client): void {
  if (!env.WSR_SHIPMENT_ENABLED) {
    console.log("[wsr-shipment] poller nonaktif (WSR_SHIPMENT_ENABLED=false).");
    return;
  }

  const intervalMs = env.WSR_SHIPMENT_POLL_MINUTES * 60_000;
  let running = false;

  const tick = async () => {
    if (running) {
      console.warn("[wsr-shipment] putaran sebelumnya belum selesai — lewati.");
      return;
    }
    running = true;
    try {
      await runWsrShipmentCheck(client);
    } catch (err) {
      console.error("[wsr-shipment] gagal cek:", err);
    } finally {
      running = false;
    }
  };

  setInterval(tick, intervalMs).unref?.();
  void tick();
  console.log(`[wsr-shipment] poller tiket kiriman aktif — cek tiap ${env.WSR_SHIPMENT_POLL_MINUTES} menit.`);
}
