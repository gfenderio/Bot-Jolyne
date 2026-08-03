import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import {
  getOrInitWatermark,
  getReminded,
  getReported,
  markReminded,
  markReported,
  setWatermark
} from "../services/wsrShipmentStore.js";

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
 * (2) melapor balik setelah dikerjakan — siapa yang mengerjakan, berapa yang jadi
 * dikirim, dan berapa yang tidak (biasanya karena barangnya belum ada).
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

/**
 * SENGAJA tanpa saringan status. Poller ini berjalan tiap beberapa menit, dan
 * kiriman bisa selesai dikerjakan di dalam sela itu (toko membuat kiriman saat
 * orang gudang sudah berdiri di raknya). Versi lama menyaring `status =
 * 'pending'`, jadi kiriman seperti itu tidak pernah diumumkan SAMA SEKALI --
 * watermark tetap digeser, dan pengumumannya hilang selamanya. Terbukti 30 Jul:
 * WSR-GAMMA_LAMBDA-5 dibuat 14:54:54, dipindahkan 14:57:12, dan yang sampai ke
 * Discord cuma laporan selesainya.
 *
 * Yang menentukan perlu-tidaknya orang di-tag adalah status kiriman SAAT
 * diumumkan, bukan apakah dia masuk daftar ini (lihat pemanggilnya).
 */
const newShipmentsQuery = (sejakId: number) => `
  ${batchSelect}
  WHERE b.id > ${sejakId}
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
    AND NOT EXISTS (
      SELECT 1 FROM wsr_batch_items i WHERE i.batch_id = b.id AND i.status = 'done'
    )
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

/**
 * Kiriman yang sudah selesai dikerjakan: 'done' = semuanya pindah, 'cancelled' =
 * sisanya dibatalkan (barang yang terlanjur pindah tetap pindah).
 */
const doneShipmentsQuery = () => `
  ${batchSelect}
  WHERE b.status IN ('done', 'cancelled')
  ORDER BY b.id ASC
`;

/** Berapa barang yang benar-benar pindah vs tidak, untuk laporan penyelesaian. */
const closingCountsQuery = (ids: number[]) => `
  SELECT i.batch_id,
         SUM(i.status = 'done') AS dipindah,
         SUM(i.status <> 'done') AS tidak_dipindah
  FROM wsr_batch_items i
  WHERE i.batch_id IN (${ids.join(",")})
  GROUP BY i.batch_id
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
  const sudahBeres = shipment.status === "done" || shipment.status === "cancelled";
  return new EmbedBuilder()
    .setColor(sudahBeres ? 0x9e9e9e : 0x00897b)
    .setTitle(`📦 ${code} — Kiriman WSR #${shipment.id}${sudahBeres ? " (sudah dikerjakan)" : ""}`)
    .setDescription(
      `${ARAH[shipment.direction] ?? shipment.direction}\n\n` +
        `**${shipment.totalItems} barang · ${shipment.totalQty} pcs**\n${rincian}\n\n` +
        `Diminta oleh **${shipment.createdBy}** dari **${shipment.unit}**.\n\n` +
        `**Cara mengerjakan — semuanya di PDA, tidak perlu tiket:**\n` +
        `1. Buka menu **Kiriman**, cari **${code}**.\n` +
        `2. Siapkan barangnya sesuai daftar **di PDA** — sudah urut rak dan selalu kondisi terbaru. **Centang** tiap barang yang sudah diambil dari rak.\n` +
        `3. Tekan **Pindahkan N barang** — yang berpindah HANYA yang kamu centang; sisanya tetap menunggu di kiriman ini.\n\n` +
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

/**
 * Tag per unit. Unit-nya cuma tiga (lihat PdaController: GAMMA_LAMBDA, ALPHA,
 * BETA), dan GAMMA_LAMBDA — toko Gamma minta barang ke gudang Lambda, dua-duanya
 * Surabaya — dikerjakan orang Surabaya. Menepuk pundak orang gudang default
 * (Bekasi) untuk kiriman itu cuma bikin tag-nya berhenti dipercaya.
 */
function mentionIdUntuk(unit: string): string {
  const khusus =
    unit.trim().toUpperCase() === "GAMMA_LAMBDA" ? env.WSR_SHIPMENT_MENTION_GAMMA_LAMBDA_ID : undefined;
  return (khusus?.trim() || env.WSR_SHIPMENT_MENTION_USER_ID?.trim()) ?? "";
}

/**
 * Tag orang gudang; kosong kalau env-nya sengaja dikosongkan.
 *
 * Bentuk tag-nya ditentukan saat kirim, bukan dihafal: id yang sama bisa milik
 * role (`<@&id>`) atau orang (`<@id>`), dan salah bentuk bikin tag-nya tampil
 * sebagai teks mentah tanpa notifikasi ke siapa pun.
 */
function mention(shipment: ShipmentRow, channel: TextChannel): string {
  const id = mentionIdUntuk(shipment.unit);
  if (!id) return "";
  return channel.guild?.roles.cache.has(id) ? `<@&${id}> ` : `<@${id}> `;
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
      await channel.send({ content: mention(shipment, channel), embeds: [reminderEmbed(shipment, jam)] });
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

/**
 * Laporan balik SETELAH kiriman dikerjakan (permintaan 28 Jul): orang toko yang
 * menunggu barangnya harus tahu siapa yang mengerjakan, apa yang jadi dikirim,
 * dan apa yang kurang — tanpa perlu bertanya.
 *
 * Sumbernya tabel kiriman itu sendiri, bukan titipan dari PDA: kalau PDA keburu
 * mati setelah stok berpindah, laporannya tetap terkirim di putaran berikutnya.
 */
async function laporkanSelesai(config: MetabaseConfig, channel: TextChannel): Promise<void> {
  const res = await fetchNativeQueryWithPagination(config, doneShipmentsQuery());
  const selesai = rowsToShipments(res.columns, res.rows);
  if (selesai.length === 0) return;

  const sudah = new Set(getReported());
  // Putaran pertama (store kosong / hilang saat deploy ulang): tandai semua yang
  // sudah selesai sebagai "sudah dilapor" TANPA mengirim apa pun. Tanpa ini,
  // kiriman lama diblast ke channel begitu fitur ini naik.
  if (sudah.size === 0) {
    markReported(selesai.map((s) => s.id));
    return;
  }

  const belum = selesai.filter((s) => !sudah.has(s.id));
  if (belum.length === 0) return;

  // Hitungan per kiriman ditarik sekali untuk semua yang mau dilapor.
  const hitung = new Map<number, { dipindah: number; tidak: number }>();
  const countRes = await fetchNativeQueryWithPagination(config, closingCountsQuery(belum.map((s) => s.id)));
  const idx = (name: string) => countRes.columns.indexOf(name);
  for (const row of countRes.rows) {
    hitung.set(Number(row[idx("batch_id")] ?? 0), {
      dipindah: Number(row[idx("dipindah")] ?? 0),
      tidak: Number(row[idx("tidak_dipindah")] ?? 0)
    });
  }

  const terkirim: number[] = [];
  for (const shipment of belum) {
    const angka = hitung.get(shipment.id) ?? { dipindah: 0, tidak: 0 };
    // Dibatalkan tanpa satu pun barang berpindah = tidak ada yang perlu dilaporkan
    // ke orang toko selain "batal"; tetap dikabarkan, tapi nadanya beda.
    const utuh = shipment.status === "done";

    try {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(utuh ? 0x2e7d32 : 0xef6c00)
            .setTitle(
              utuh
                ? `✅ ${shipmentCode(shipment)} selesai — ${angka.dipindah} barang dikirim`
                : `📦 ${shipmentCode(shipment)} ditutup — ${angka.dipindah} dari ${shipment.totalItems} barang dikirim`
            )
            .setDescription(
              `Dikerjakan **${shipment.executedBy}**.\n` +
                `Diminta **${shipment.createdBy}** dari **${shipment.unit}**.\n\n` +
                (utuh
                  ? "Semua barang di kiriman ini sudah dipindah, tidak ada yang tertinggal."
                  : `**${angka.tidak} barang tidak jadi dikirim** — biasanya karena barangnya belum ada ` +
                    "di gudang asal. Barang itu masih di tempatnya; buat kiriman baru dari PDA kalau tetap dibutuhkan.")
            )
            .setFooter({ text: `Dikerjakan ${shipment.executedAt} WIB` })
            .setTimestamp()
        ]
      });
      terkirim.push(shipment.id);
    } catch (err) {
      console.error(`[wsr-shipment] gagal kirim laporan selesai #${shipment.id}:`, err);
    }
  }

  // Hanya yang benar-benar terkirim yang ditandai — sisanya dicoba lagi nanti.
  markReported(terkirim);
  if (terkirim.length > 0) {
    console.log(`[wsr-shipment] ${terkirim.length} laporan kiriman selesai dikirim.`);
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
          //
          // Kiriman yang saat diumumkan sudah selesai/dibatalkan tetap dikabarkan
          // (biar ada jejak "kiriman ini pernah dibuat"), tapi TANPA tag: menepuk
          // pundak orang untuk kerjaan yang sudah beres cuma bikin tag-nya
          // berhenti dipercaya.
          const perluDikerjakan = shipment.status === "pending" || shipment.status === "running";
          await channel.send({
            content: perluDikerjakan ? mention(shipment, channel) : undefined,
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
  await laporkanSelesai(config, channel);
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
