import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { getOrInitWatermark, setWatermark } from "../services/wsrShipmentStore.js";

/**
 * Kiriman WSR → Excel ke Discord.
 *
 * Alur yang diminta di meeting 20 Jul: staf toko memilih barang di PDA lalu
 * menekan "Siapkan kiriman" — stok BELUM pindah. Gudang perlu daftar barangnya
 * dalam bentuk yang bisa dicetak/dibawa keliling rak, makanya dikirim sebagai
 * Excel ke Discord. Setelah barangnya siap, kiriman dieksekusi dari PDA dan
 * barulah stok berpindah.
 *
 * Bot TIDAK dipanggil oleh hanayo — ia memantau tabel `wsr_batches` lewat
 * Metabase (readonly), pola yang sama dengan split-print. Alasannya: hanayo
 * tidak punya jalur keluar ke Discord, dan menambahkannya berarti menaruh
 * kredensial bot di aplikasi yang tidak membutuhkannya.
 */

interface ShipmentRow {
  id: number;
  unit: string;
  direction: string;
  totalItems: number;
  totalQty: number;
  createdBy: string;
  createdAt: string;
  items: ShipmentItem[];
}

interface ShipmentItem {
  itemId: string;
  name: string;
  barcode: string;
  source: string;
  destination: string;
  qty: number;
  rack: string;
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

/**
 * Hanya kiriman yang masih menunggu. Yang sudah dieksekusi atau dibatalkan
 * sebelum bot sempat melihatnya memang tidak perlu dikirim — daftarnya sudah
 * tidak berguna buat gudang.
 */
const shipmentQuery = (sejakId: number) => `
  SELECT id, unit, direction, total_items, total_qty,
         COALESCE(created_by_name, '-') AS created_by, created_at, items
  FROM wsr_batches
  WHERE id > ${sejakId} AND status = 'pending'
  ORDER BY id ASC
`;

function parseItems(raw: unknown): ShipmentItem[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((it) => ({
      itemId: String(it?.item_id ?? ""),
      name: String(it?.name ?? ""),
      barcode: String(it?.barcode ?? ""),
      source: String(it?.source ?? ""),
      destination: String(it?.destination ?? ""),
      qty: Number(it?.qty ?? 0),
      rack: String(it?.rack ?? "")
    }));
  } catch {
    return [];
  }
}

async function fetchShipments(config: MetabaseConfig, sejakId: number): Promise<ShipmentRow[]> {
  const { columns, rows } = await fetchNativeQueryWithPagination(config, shipmentQuery(sejakId));
  const idx = (name: string) => columns.indexOf(name);
  return rows.map((row) => ({
    id: Number(row[idx("id")] ?? 0),
    unit: String(row[idx("unit")] ?? ""),
    direction: String(row[idx("direction")] ?? ""),
    totalItems: Number(row[idx("total_items")] ?? 0),
    totalQty: Number(row[idx("total_qty")] ?? 0),
    createdBy: String(row[idx("created_by")] ?? "-"),
    createdAt: String(row[idx("created_at")] ?? ""),
    items: parseItems(row[idx("items")])
  }));
}

/** Satu kiriman = satu sheet siap cetak; kolomnya urut sesuai cara orang jalan di rak. */
export async function buildShipmentWorkbook(shipment: ShipmentRow): Promise<Buffer> {
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

  // Sengaja TANPA `header`: ExcelJS menulis header dari `columns` ke baris 1,
  // dan baris 1 di sini sudah dipakai judul (merge A1:G1) — hasilnya judulnya
  // ketimpa jadi "Qty". Judul kolom diisi manual di baris 4 di bawah.
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

  // Urut per rak: gudang mengambil barang sambil jalan sekali lewat, bukan
  // bolak-balik mengikuti urutan prioritas yang dipakai di layar PDA.
  const sorted = [...shipment.items].sort((a, b) => (a.rack || "￿").localeCompare(b.rack || "￿"));
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

function embedFor(shipment: ShipmentRow): EmbedBuilder {
  // Tujuan dirangkum: satu kiriman bisa terbelah ke beberapa gudang.
  const perTujuan = new Map<string, number>();
  for (const item of shipment.items) {
    perTujuan.set(item.destination, (perTujuan.get(item.destination) ?? 0) + item.qty);
  }
  const rincian = [...perTujuan.entries()].map(([tujuan, qty]) => `**${tujuan}** ${qty} pcs`).join(" · ");

  return new EmbedBuilder()
    .setColor(0x00897b)
    .setTitle(`[Kiriman WSR #${shipment.id}] — ${shipment.unit}`)
    .setDescription(
      `${ARAH[shipment.direction] ?? shipment.direction}\n\n` +
        `**${shipment.totalItems} barang · ${shipment.totalQty} pcs**\n${rincian}\n\n` +
        `Disiapkan oleh **${shipment.createdBy}**.\n` +
        `Stok **belum** berpindah. Siapkan barangnya sesuai daftar terlampir, ` +
        `lalu buka menu **Kiriman** di PDA dan tekan *Pindahkan sekarang*.`
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

  const shipments = await fetchShipments(config, sejakId);
  if (shipments.length === 0) {
    setWatermark(maxId);
    return;
  }

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
      const buffer = await buildShipmentWorkbook(shipment);
      const attachment = new AttachmentBuilder(buffer, {
        name: `Kiriman_WSR_${shipment.id}_${shipment.unit}.xlsx`
      });
      await channel.send({ embeds: [embedFor(shipment)], files: [attachment] });
      terkirim++;
    } catch (err) {
      console.error(`[wsr-shipment] gagal kirim #${shipment.id}:`, err);
    }
  }

  // Digeser SETELAH terkirim — sama alasannya dengan split-print: kalau digeser
  // duluan lalu pengiriman gagal, kirimannya hilang selamanya dari pantauan.
  setWatermark(maxId);
  console.log(`[wsr-shipment] ${terkirim} kiriman dikirim ke channel.`);
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
  console.log(`[wsr-shipment] poller aktif — cek tiap ${env.WSR_SHIPMENT_POLL_MINUTES} menit.`);
}
