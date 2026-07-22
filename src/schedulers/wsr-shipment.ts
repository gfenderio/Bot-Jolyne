import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel, ThreadChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import {
  getOrInitWatermark,
  setWatermark,
  trackShipment,
  getTracked,
  updateTracked,
  untrack
} from "../services/wsrShipmentStore.js";

/**
 * Kiriman WSR → "tiket" thread Discord, diurus penuh oleh Jolyne.
 *
 * Alur (permintaan 22 Jul, pengganti isi form /wh-ticket manual):
 *   staf tekan "Siapkan kiriman" di PDA  → Jolyne MEMBUKA THREAD di channel
 *   gudang (judul, isi kiriman, Excel per-rak, mention specialist)
 *   → gudang menyiapkan barang → eksekusi dari PDA
 *   → Jolyne otomatis post "selesai/dibatalkan/gagal sebagian" di thread yang
 *   sama lalu MENUTUP (archive) thread-nya. Tidak ada form yang perlu diisi.
 *
 * Sengaja BUKAN tiket Mornye (purchasing_tickets): sistem itu milik bot lain —
 * tombol claim/close, arsip shiro, dan format barisnya semua hidup di sana.
 * Membuat baris tiruan dari luar = tiket yatim tanpa tombol. Thread Jolyne
 * berdiri sendiri dan status aslinya selalu dari DB (menu Kiriman PDA).
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

const trackedStatusQuery = (ids: number[]) => `
  ${batchSelect}
  WHERE b.id IN (${ids.join(",")})
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
        `Thread ini ditutup otomatis begitu kirimannya selesai/dibatalkan.`
    )
    .setFooter({ text: `Dibuat ${shipment.createdAt} WIB` })
    .setTimestamp();
}

/** Ambil thread; null kalau sudah dihapus / bot kehilangan akses. */
async function fetchThread(client: Client, threadId: string): Promise<ThreadChannel | null> {
  const ch = await client.channels.fetch(threadId).catch(() => null);
  return ch && ch.isThread() ? ch : null;
}

export async function runWsrShipmentCheck(client: Client): Promise<void> {
  const config = metabaseConfig();
  if (!config) {
    console.warn("[wsr-shipment] Metabase belum dikonfigurasi — lewati.");
    return;
  }

  // ── 1. Kiriman BARU → buka thread tiket ─────────────────────────────────
  const max = await fetchNativeQueryWithPagination(config, maxIdQuery());
  const maxId = Number(max.rows[0]?.[0] ?? 0);
  if (!Number.isFinite(maxId)) return;

  const sejakId = getOrInitWatermark(maxId);
  if (maxId > sejakId) {
    const res = await fetchNativeQueryWithPagination(config, newShipmentsQuery(sejakId));
    const shipments = rowsToShipments(res.columns, res.rows);
    const itemsByBatch = await fetchItems(config, shipments.map((s) => s.id));

    const channel = (await client.channels.fetch(env.WSR_SHIPMENT_CHANNEL_ID).catch(() => null)) as TextChannel | null;
    if (!channel?.isTextBased()) {
      console.error(
        `[wsr-shipment] channel ${env.WSR_SHIPMENT_CHANNEL_ID} tidak ketemu — watermark TIDAK digeser supaya tidak ada kiriman yang hilang.`
      );
      return;
    }

    for (const shipment of shipments) {
      try {
        const items = itemsByBatch.get(shipment.id) ?? [];
        const buffer = await buildShipmentWorkbook(shipment, items);
        const attachment = new AttachmentBuilder(buffer, {
          name: `Kiriman_WSR_${shipment.id}_${shipment.unit}.xlsx`
        });
        const mentionId = env.WSR_TICKET_MENTION_USER_ID;
        // Pola text-channel: kirim pesan pembuka (embed + Excel + mention) lalu
        // jadikan thread dari pesan itu — tampilannya persis tiket yang menempel
        // di channel.
        const starter = await channel.send({
          content: mentionId ? `<@${mentionId}>` : undefined,
          embeds: [openingEmbed(shipment, items)],
          files: [attachment],
          allowedMentions: { users: mentionId ? [mentionId] : [] }
        });
        const thread = await starter.startThread({
          name: `Kiriman WSR #${shipment.id} — ${shipment.unit} (${shipment.direction})`.slice(0, 100),
          autoArchiveDuration: 4320 // 3 hari; ditutup manual oleh bot saat selesai
        });
        trackShipment(shipment.id, {
          threadId: thread.id,
          lastStatus: "pending",
          lastFailed: 0,
          unit: shipment.unit
        });
      } catch (err) {
        console.error(`[wsr-shipment] gagal buka thread kiriman #${shipment.id}:`, err);
      }
    }
    // Digeser SETELAH thread terbuka — kegagalan buka thread tidak membuat
    // kiriman hilang dari pantauan.
    setWatermark(maxId);
  }

  // ── 2. Kiriman yang DIPANTAU → update & tutup thread saat status berubah ─
  const tracked = getTracked();
  const trackedIds = Object.keys(tracked).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (trackedIds.length === 0) return;

  const res = await fetchNativeQueryWithPagination(config, trackedStatusQuery(trackedIds));
  const shipments = rowsToShipments(res.columns, res.rows);
  // failed dihitung dari tabel anak — status kolom asli, tinggal COUNT.
  const itemsByBatch = await fetchItems(config, trackedIds);

  for (const shipment of shipments) {
    const info = tracked[String(shipment.id)];
    if (!info) continue;
    const items = itemsByBatch.get(shipment.id) ?? [];
    const failedNow = items.filter((i) => i.status === "failed");

    try {
      if (shipment.status === "done" || shipment.status === "cancelled") {
        const thread = await fetchThread(client, info.threadId);
        if (thread) {
          const doneMsg =
            shipment.status === "done"
              ? `✅ **Selesai** — ${shipment.totalItems} barang dipindah oleh **${shipment.executedBy}** (${shipment.executedAt} WIB).`
              : `❌ **Dibatalkan** oleh **${shipment.executedBy}**. Stok tidak pernah tersentuh.`;
          await thread.send(doneMsg);
          await thread.setArchived(true, "Kiriman WSR selesai").catch(() => undefined);
        }
        untrack(shipment.id);
        continue;
      }

      // Masih pending/running: laporkan gagal-sebagian sekali per perubahan jumlah,
      // supaya gudang tahu harus mengulang tanpa menunggu dicek manual.
      if (failedNow.length > 0 && failedNow.length !== info.lastFailed) {
        const thread = await fetchThread(client, info.threadId);
        if (thread) {
          const daftar = failedNow
            .slice(0, 5)
            .map((f) => `- ${f.name.slice(0, 60)}: ${f.error || "gagal"}`)
            .join("\n");
          const lebih = failedNow.length > 5 ? `\n(+${failedNow.length - 5} lagi)` : "";
          await thread.send(
            `⚠️ **${failedNow.length} barang gagal dipindah** — sisanya sudah masuk. ` +
              `Cek lalu ulangi dari menu Kiriman:\n${daftar}${lebih}`
          );
        }
        updateTracked(shipment.id, { lastFailed: failedNow.length, lastStatus: shipment.status });
      } else if (shipment.status !== info.lastStatus) {
        updateTracked(shipment.id, { lastStatus: shipment.status });
      }
    } catch (err) {
      console.error(`[wsr-shipment] gagal update thread kiriman #${shipment.id}:`, err);
    }
  }
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
