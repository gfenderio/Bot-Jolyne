import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import { getOrInitWatermark, getReminded, markReminded, setWatermark } from "../services/wsrShipmentStore.js";

/**
 * Kiriman WSR → PENGINGAT ke channel gudang. Titik.
 *
 * Keputusan 22 Jul: Jolyne TIDAK berperan sebagai tiket — sistem tiket (thread,
 * claim/close, rating) seluruhnya milik Mornye dan tidak ditiru dari luar.
 *
 * Keputusan 27 Jul: rencana "dikerjakan lewat tiket /wh-ticket" DIBATALKAN.
 * Kiriman dibuat anak toko di PDA, dikerjakan anak gudang di PDA juga (menu
 * Kiriman: centang barang yang sudah disiapkan, lalu Pindahkan stok).
 *
 * Keputusan 28 Jul: Excel DIHAPUS. Daftar barangnya sudah ada di PDA — lengkap
 * dengan urutan rak dan centang per barang — jadi berkas kedua di Discord cuma
 * jadi salinan yang bisa basi begitu ada yang dicentang. Peran Jolyne tinggal
 * dua: (1) menepuk pundak orang gudang saat ada kiriman baru & saat menggantung,
 * (2) melapor balik setelah dikerjakan — siapa yang mengerjakan, apa yang jadi
 * dikirim, apa yang kurang dan kenapa.
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

/**
 * Kode kiriman — PENGGANTI "nama sheet" Google Sheet WSR yang lama. Dipakai
 * sebagai nama berkas Excel dan judul pengingat, sama persis dengan yang tampil
 * di menu Kiriman PDA, supaya orang gudang tahu pesan ini kiriman yang mana.
 * Deterministik dari unit + id (id AUTO_INCREMENT, unik selamanya).
 */
function shipmentCode(shipment: ShipmentRow): string {
  return `WSR-${shipment.unit}-${shipment.id}`;
}

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

/**
 * Kiriman yang masih menunggu padahal sudah lewat sekian jam. 'running' ikut:
 * eksekusi yang mati di tengah jalan juga barang yang belum sampai tujuan.
 *
 * Batas waktunya dihitung di sini (Node), BUKAN `NOW() - INTERVAL n HOUR`.
 * Alasannya jebakan yang sudah pernah kena di fitur split-print: kolom created_at
 * ditulis Laravel dengan timezone Asia/Jakarta, sedangkan NOW() server DB belum
 * tentu WIB — selisih 7 jam bikin pengingat datang kepagian atau tak datang sama
 * sekali. Kirim tanggalnya apa adanya dalam WIB, tidak ada yang perlu ditebak.
 */
const staleShipmentsQuery = (batasWib: string) => `
  ${batchSelect}
  WHERE b.status IN ('pending', 'running')
    AND b.created_at < '${batasWib}'
  ORDER BY b.id ASC
`;

/** "YYYY-MM-DD HH:MM:SS" WIB, sekian jam ke belakang dari sekarang. */
function batasWaktuWib(jam: number): string {
  const wib = new Date(Date.now() - jam * 3_600_000 + 7 * 3_600_000);
  return wib.toISOString().slice(0, 19).replace("T", " ");
}

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

function openingEmbed(shipment: ShipmentRow, items: ShipmentItem[]): EmbedBuilder {
  const perTujuan = new Map<string, number>();
  for (const item of items) {
    perTujuan.set(item.destination, (perTujuan.get(item.destination) ?? 0) + item.qty);
  }
  const rincian = [...perTujuan.entries()].map(([t, q]) => `**${t}** ${q} pcs`).join(" · ");

  const code = shipmentCode(shipment);
  return new EmbedBuilder()
    .setColor(0x00897b)
    .setTitle(`📦 ${code} — Kiriman WSR #${shipment.id}`)
    .setDescription(
      `${ARAH[shipment.direction] ?? shipment.direction}\n\n` +
        `**${shipment.totalItems} barang · ${shipment.totalQty} pcs**\n${rincian}\n\n` +
        `Diminta oleh **${shipment.createdBy}** dari **${shipment.unit}**.\n\n` +
        `**Cara mengerjakan — semuanya di PDA, tidak perlu tiket:**\n` +
        `1. Buka menu **Kiriman**, cari **${code}**.\n` +
        `2. Siapkan barangnya sesuai daftar terlampir (urut rak), **centang** tiap barang yang sudah diambil.\n` +
        `3. Kalau sudah semua, tekan **Pindahkan stok**.\n\n` +
        `Stok **belum** berpindah sampai langkah 3. Siapa yang mencentang dan siapa ` +
        `yang memindahkan tercatat otomatis.`
    )
    .setFooter({ text: `Dibuat ${shipment.createdAt} WIB` })
    .setTimestamp();
}

/**
 * Pengingat susulan untuk kiriman yang masih menggantung. Sekali saja per
 * kiriman (lihat markReminded) — poller jalan tiap 5 menit, tanpa itu orang
 * gudang di-tag terus-terusan dan pengingatnya jadi diabaikan.
 */
function reminderEmbed(shipment: ShipmentRow, jam: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xef6c00)
    .setTitle(`⏰ ${shipmentCode(shipment)} belum dikerjakan`)
    .setDescription(
      `Kiriman ini dibuat **${shipment.createdBy}** lebih dari **${jam} jam** lalu dan ` +
        `stoknya masih belum berpindah.\n\n` +
        `${shipment.totalItems} barang · ${shipment.totalQty} pcs · ` +
        `${ARAH[shipment.direction] ?? shipment.direction}\n\n` +
        `Buka menu **Kiriman** di PDA. Kalau barangnya memang tidak bisa dikirim, ` +
        `batalkan kirimannya dari sana biar tidak menggantung.`
    )
    .setFooter({ text: `Dibuat ${shipment.createdAt} WIB` })
    .setTimestamp();
}

/** Tag orang gudang; kosong kalau env-nya sengaja dikosongkan. */
function mention(): string {
  const id = env.WSR_SHIPMENT_MENTION_USER_ID?.trim();
  return id ? `<@${id}> ` : "";
}

/**
 * Kiriman lama yang masih menggantung → satu pengingat, sekali saja.
 * Dijalankan setelah pengumuman kiriman baru, memakai koneksi Metabase yang sama.
 */
async function kirimPengingat(config: MetabaseConfig, channel: TextChannel): Promise<void> {
  const jam = env.WSR_SHIPMENT_REMINDER_HOURS;
  const res = await fetchNativeQueryWithPagination(config, staleShipmentsQuery(batasWaktuWib(jam)));
  const stale = rowsToShipments(res.columns, res.rows);
  if (stale.length === 0) return;

  const sudah = new Set(getReminded());
  const belum = stale.filter((s) => !sudah.has(s.id));
  if (belum.length === 0) return;

  const terkirim: number[] = [];
  for (const shipment of belum) {
    try {
      await channel.send({ content: mention(), embeds: [reminderEmbed(shipment, jam)] });
      terkirim.push(shipment.id);
    } catch (err) {
      console.error(`[wsr-shipment] gagal kirim pengingat #${shipment.id}:`, err);
    }
  }
  // Hanya yang benar-benar terkirim yang ditandai — yang gagal dicoba lagi nanti.
  markReminded(terkirim);
  if (terkirim.length > 0) {
    console.log(`[wsr-shipment] ${terkirim.length} pengingat kiriman menggantung dikirim.`);
  }
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

  const channel = (await client.channels.fetch(env.WSR_SHIPMENT_CHANNEL_ID).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    console.error(
      `[wsr-shipment] channel ${env.WSR_SHIPMENT_CHANNEL_ID} tidak ketemu — watermark TIDAK digeser supaya tidak ada kiriman yang hilang.`
    );
    return;
  }

  if (maxId > sejakId) {
    const res = await fetchNativeQueryWithPagination(config, newShipmentsQuery(sejakId));
    const shipments = rowsToShipments(res.columns, res.rows);
    if (shipments.length === 0) {
      setWatermark(maxId);
    } else {
      const itemsByBatch = await fetchItems(config, shipments.map((s) => s.id));

      let terkirim = 0;
      for (const shipment of shipments) {
        try {
          const items = itemsByBatch.get(shipment.id) ?? [];
          // Tag ditaruh di isi pesan, bukan di embed: mention di dalam embed
          // TIDAK memicu notifikasi Discord — orangnya tak akan tahu.
          await channel.send({
            content: mention(),
            embeds: [openingEmbed(shipment, items)]
          });
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
  }

  // Selalu dijalankan, termasuk saat tidak ada kiriman baru — justru kiriman
  // yang sudah lama diam itulah yang perlu diingatkan.
  await kirimPengingat(config, channel);
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
