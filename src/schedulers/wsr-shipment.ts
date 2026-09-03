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

/*
DUA JALAN MENGERJAKAN, dan pesannya harus menyebut dua-duanya.

Sampai Agustus 2026 kiriman ini cuma bisa dikerjakan dari PDA, jadi pengumumannya
menulis "semuanya di PDA". Sekarang layar Kiriman ada juga di team.kyou.id, dan
ia membaca tabel `wsr_batches` yang SAMA — yang dicentang di satu sisi langsung
terlihat di sisi lain. Pesan yang cuma menyebut PDA menyuruh orang yang sedang
duduk di depan komputer mengambil HP untuk pekerjaan yang ada di layarnya.

Alamatnya ditulis utuh, bukan "buka team.kyou.id lalu cari sendiri": yang membaca
pesan ini sedang berdiri di depan rak, bukan sedang menjelajah menu. Dibungkus
kurung siku supaya Discord tidak menempelkan pratinjau tautan di tiap pengumuman.

NAMA YANG DIBACA ORANG "Stock Rotation", bukan "WSR" (permintaan Gilang, 26 Agu
2026). Kode kirimannya sendiri TETAP `WSR-UNIT-ID`: itu penanda yang sama persis
dipakai PDA, team.kyou.id, dan kolom Batch tiket gudang — menggantinya berarti
dua nama untuk satu kiriman, dan yang mencarinya di dua layar tidak menemukan
apa-apa.
*/
const WEB_NAMA = "team.kyou.id";
const WEB_GUDANG = "<https://team.kyou.id/warehouse/rotasi-stok>";

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
/*
WATERMARK BUKAN LAGI SATU-SATUNYA PENJAGA, dan itu memperbaiki lubang yang sudah
menelan pengumuman.

Store watermark hidup di berkas biasa tanpa volume persisten (lihat
wsrShipmentStore.ts): tiap redeploy ia hilang, lalu dipatok ulang ke id
TERTINGGI saat itu supaya riwayat lama tidak diblast. Konsekuensinya yang tidak
disadari: kiriman yang dibuat tepat sebelum redeploy — atau selagi bot mati —
ikut terlewat, DIAM-DIAM dan selamanya. Tidak ada error, tidak ada log; cuma
channel yang sepi.

Terjadi 26 Agu 2026: WSR-ALPHA-9 dan -10 ada di wsr_batches berstatus pending,
tapi pesan terakhir di channel tanggal 19 Agustus.

Sekarang daftar calonnya = yang lebih baru dari watermark ATAU yang dibuat dalam
`jamTengok` terakhir. Yang menjaga supaya tidak dobel bukan watermark, melainkan
ISI CHANNEL ITU SENDIRI: kode kiriman yang sudah pernah diumumkan dibaca dari
pesan yang ada di sana (lihat kodeSudahDiumumkan). Watermark tetap dipakai —
ia yang membuat putaran biasa tidak perlu menyisir apa pun — tapi kehilangannya
tidak lagi berarti kehilangan pengumuman.
*/
const newShipmentsQuery = (sejakId: number, batasWib: string) => `
  ${batchSelect}
  WHERE b.id > ${sejakId} OR b.created_at >= '${batasWib}'
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
/**
 * Kode kiriman yang pengumumannya SUDAH ada di channel.
 *
 * Dibaca dari pesan yang benar-benar terkirim, bukan dari catatan kita sendiri —
 * dan itu seluruh gunanya: catatan bisa hilang saat redeploy, pesan di Discord
 * tidak. Yang dihitung hanya embed pembuka (judulnya diawali 📦); laporan
 * "selesai" dan pengingat memuat kode yang sama tapi bukan pengumuman, dan
 * menghitungnya berarti kiriman yang keburu dikerjakan tidak pernah diumumkan.
 *
 * Seratus pesan terakhir sudah lebih dari cukup: channel ini isinya beberapa
 * pesan per kiriman, dan jendela tengoknya cuma dua hari.
 */
async function kodeSudahDiumumkan(channel: TextChannel): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const pesan = await channel.messages.fetch({ limit: 100 });
    for (const m of pesan.values()) {
      for (const e of m.embeds) {
        const judul = e.title ?? "";
        if (!judul.startsWith("📦 ")) continue;
        const kode = judul.slice(2).trim().split(/\s+/)[0];
        if (kode) out.add(kode);
      }
    }
  } catch (err) {
    // Gagal membaca channel BUKAN alasan untuk diam: yang terburuk dari
    // melanjutkan adalah satu pengumuman dobel, sedangkan berhenti berarti
    // kiriman yang tidak pernah sampai ke gudang.
    console.error("[wsr-shipment] gagal membaca pesan channel — lanjut tanpa pengecekan dobel:", err);
  }
  return out;
}

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
  /*
    TIGA KEADAAN, BUKAN DUA — dan bedanya bukan soal rapi.

    Kiriman yang saat diumumkan sudah selesai (atau dibatalkan) tetap dikabarkan,
    biar ada jejak "kiriman ini pernah dibuat". Tapi isinya dulu sama persis
    dengan kiriman yang menunggu: tiga langkah cara mengerjakan, lengkap dengan
    "Stok belum berpindah sampai langkah 3" — kalimat yang JUSTRU TERBALIK untuk
    kiriman yang stoknya sudah pindah. Orang gudang yang membacanya berangkat ke
    rak untuk pekerjaan yang sudah tidak ada.

    Dan "dibatalkan" dipisah dari "sudah dikerjakan": dua-duanya berarti tidak
    ada yang perlu disiapkan, tapi yang satu barangnya sampai dan yang satu
    tidak. Menyebut kiriman batal sebagai "sudah dikerjakan" itu salah kabar,
    bukan singkatan.
  */
  const dibatalkan = shipment.status === "cancelled";
  const sudahBeres = shipment.status === "done" || dibatalkan;
  const penutup = dibatalkan
    ? `Kiriman ini **dibatalkan** — tidak ada yang perlu disiapkan. Diumumkan ` +
      `supaya ada jejak bahwa kirimannya pernah dibuat.`
    : sudahBeres
      ? `Kiriman ini **sudah dikerjakan** — stoknya sudah berpindah, tidak ada ` +
        `yang perlu disiapkan lagi. Rinciannya di menu **Kiriman**, di PDA atau ` +
        `di ${WEB_NAMA}: ${WEB_GUDANG}`
      : `**Cara mengerjakan — di PDA atau di ${WEB_NAMA}, tidak perlu tiket:**\n` +
        `1. Buka menu **Kiriman**, cari **${code}**. Di web: ${WEB_GUDANG}\n` +
        `2. Siapkan barangnya sesuai daftarnya — sudah urut rak dan selalu kondisi terbaru. **Centang** tiap barang yang sudah diambil dari rak.\n` +
        `3. Tekan **Pindahkan N barang** — yang berpindah HANYA yang kamu centang; sisanya tetap menunggu di kiriman ini.\n\n` +
        `Stok **belum** berpindah sampai langkah 3. Siapa yang mencentang dan siapa ` +
        `yang memindahkan tercatat otomatis.\n` +
        `PDA dan web membaca kiriman yang SAMA — dicentang di satu sisi langsung terlihat di sisi lain.`;
  return new EmbedBuilder()
    .setColor(sudahBeres ? 0x9e9e9e : 0x00897b)
    .setTitle(
      `📦 ${code} — Stock Rotation #${shipment.id}` +
        (dibatalkan ? " (dibatalkan)" : sudahBeres ? " (sudah dikerjakan)" : "")
    )
    .setDescription(
      `${ARAH[shipment.direction] ?? shipment.direction}\n\n` +
        `**${shipment.totalItems} barang · ${shipment.totalQty} pcs**\n${rincian}\n\n` +
        `Diminta oleh **${shipment.createdBy}** dari **${shipment.unit}**.\n\n` +
        penutup
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
        `Buka menu **Kiriman** — di PDA, atau di ${WEB_NAMA}: ${WEB_GUDANG}\n` +
        `Kalau barangnya memang tidak bisa dikirim, batalkan kirimannya dari sana ` +
        `biar tidak menggantung.`
    )
    .setFooter({ text: `Dibuat ${shipment.createdAt} WIB` })
    .setTimestamp();
}

/** Gudang Surabaya, dari env. Sisanya dianggap Bekasi. */
function gudangSurabaya(): Set<string> {
  return new Set(
    env.WSR_SHIPMENT_SURABAYA_SOURCES.split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean)
  );
}

/**
 * Gudang mana yang benar-benar mengerjakan kiriman ini.
 *
 * Arah `request` (Gudang → Toko): yang mengambil barang dari rak adalah gudang
 * ASAL. Arah `return`/`event`: yang menerima dan merapikan adalah gudang TUJUAN.
 * Di dua-duanya, yang perlu ditepuk pundaknya adalah sisi gudangnya - channel
 * ini memang channel orang gudang.
 */
function gudangPengerja(shipment: ShipmentRow, items: ShipmentItem[]): string[] {
  const ambilAsal = shipment.direction === "request";
  const nama = items.map((i) => (ambilAsal ? i.source : i.destination));
  return [...new Set(nama.map((x) => (x ?? "").trim().toUpperCase()).filter(Boolean))];
}

/**
 * Tag untuk satu kiriman, dibaca dari GUDANG YANG DIPAKAI - bukan dari nama
 * unitnya.
 *
 * DULU DARI NAMA UNIT, DAN ITU SALAH SEBAGIAN. Unit "GAMMA_LAMBDA" selalu
 * menandai orang Surabaya, padahal unit yang sama juga dipakai saat toko Gamma
 * minta barang ke Omega/SS - dua gudang Bekasi. Kiriman itu menepuk pundak orang
 * Surabaya yang tidak bisa mengerjakannya, dan orang Bekasi yang seharusnya
 * mengerjakan tidak pernah tahu. Sejak 3 Sep 2026 yang dibaca gudangnya.
 *
 * Kiriman yang gudangnya bercampur dua kota menandai KEDUANYA. Memilih salah
 * satu berarti separuh barangnya tidak ada yang tahu.
 *
 * Peran inbound/outbound ikut kalau env-nya diisi (perannya dibuat Sopmod).
 * Selama kosong, hasilnya persis seperti sebelumnya.
 */
function mentionIdsUntuk(shipment: ShipmentRow, items: ShipmentItem[]): string[] {
  const surabaya = gudangSurabaya();
  const pengerja = gudangPengerja(shipment, items);

  const idSurabaya =
    env.WSR_SHIPMENT_MENTION_SURABAYA_ID?.trim() || env.WSR_SHIPMENT_MENTION_GAMMA_LAMBDA_ID?.trim() || "";
  const idBekasi = env.WSR_SHIPMENT_MENTION_USER_ID?.trim() ?? "";

  const ids: string[] = [];
  if (pengerja.length === 0) {
    // Rincian barangnya tidak terbaca (query gagal, atau kirimannya kosong).
    // Jatuh balik ke aturan lama berdasar nama unit: lebih baik menandai
    // menurut tebakan lama daripada tidak menandai siapa pun.
    const lama = shipment.unit.trim().toUpperCase() === "GAMMA_LAMBDA" ? idSurabaya : idBekasi;
    if (lama) ids.push(lama);
  } else {
    if (pengerja.some((g) => surabaya.has(g)) && idSurabaya) ids.push(idSurabaya);
    if (pengerja.some((g) => !surabaya.has(g)) && idBekasi) ids.push(idBekasi);
  }

  const peran =
    shipment.direction === "request"
      ? env.WSR_SHIPMENT_MENTION_OUTBOUND_ID?.trim()
      : env.WSR_SHIPMENT_MENTION_INBOUND_ID?.trim();
  if (peran) ids.push(peran);

  return [...new Set(ids)];
}

/**
 * Tag orang gudang; kosong kalau env-nya sengaja dikosongkan.
 *
 * Bentuk tag-nya ditentukan saat kirim, bukan dihafal: id yang sama bisa milik
 * role (`<@&id>`) atau orang (`<@id>`), dan salah bentuk bikin tag-nya tampil
 * sebagai teks mentah tanpa notifikasi ke siapa pun.
 */
function mention(shipment: ShipmentRow, channel: TextChannel, items: ShipmentItem[] = []): string {
  const ids = mentionIdsUntuk(shipment, items);
  if (ids.length === 0) return "";
  return ids.map((id) => (channel.guild?.roles.cache.has(id) ? `<@&${id}> ` : `<@${id}> `)).join("");
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

  // Rincian barangnya ikut ditarik HANYA untuk yang benar-benar diingatkan
  // (biasanya segelintir). Tanpa ini pengingatnya menandai kota yang berbeda
  // dari pengumuman aslinya, dan yang ditepuk pundaknya jadi dua orang yang
  // sama-sama merasa bukan bagiannya.
  const rincian = await fetchItems(config, belum.map((s) => s.id)).catch(() => new Map<number, ShipmentItem[]>());

  const terkirim: number[] = [];
  for (const shipment of belum) {
    try {
      const items = rincian.get(shipment.id) ?? [];
      await channel.send({ content: mention(shipment, channel, items), embeds: [reminderEmbed(shipment, jam)] });
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

/** Satu kiriman, dicari langsung dari id-nya. Dipakai jalur dorongan kakera. */
const shipmentByIdQuery = (id: number) => `
  ${batchSelect}
  WHERE b.id = ${id}
`;

/**
 * Umumkan SATU kiriman sekarang juga — dipanggil kakera begitu tombol Kirim
 * ditekan, lewat POST /kakera/wsr-shipment.
 *
 * KENAPA DIDORONG, BUKAN DITUNGGU. Poller ini menengok tiap lima menit, dan itu
 * memang cukup untuk pengingat. Tapi orang toko menekan Kirim lalu langsung
 * membuka Discord untuk memastikan gudang tahu — dan channel yang masih sepi
 * terbaca sebagai "kirimannya gagal", bukan "sebentar lagi". Dilaporkan Gilang
 * 29 Agu 2026: WSR-ALPHA-12 dibuat 16:29, pengumumannya sampai 16:32.
 *
 * POLLER-NYA TIDAK DIMATIKAN, dan itu penting. Dorongan bisa gagal — kakera
 * mati, jaringannya putus, bot-nya sedang deploy — dan yang menambal itu justru
 * putaran lima menitan yang sama. Yang menjaga tidak dobel bukan urutan
 * keduanya, melainkan ISI CHANNEL: kode yang sudah diumumkan dibaca dari pesan
 * yang benar-benar ada di sana (lihat kodeSudahDiumumkan).
 *
 * Isinya dibaca ULANG dari database, bukan diambil dari badan permintaan.
 * Kakera cuma menyebut id; nama barang, rak, dan jumlahnya tetap datang dari
 * sumber yang sama dengan pengumuman biasa, jadi tidak ada dua bentuk pesan
 * untuk satu kejadian.
 */
export async function umumkanKirimanSekarang(
  client: Client,
  batchId: number
): Promise<"terkirim" | "sudah-ada" | "tidak-ketemu" | "belum-siap"> {
  const config = metabaseConfig();
  if (!config) {
    console.warn("[wsr-shipment] dorongan kakera datang tapi Metabase belum dikonfigurasi.");
    return "belum-siap";
  }

  const channel = (await client.channels
    .fetch(env.WSR_SHIPMENT_CHANNEL_ID)
    .catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) {
    console.error(`[wsr-shipment] channel ${env.WSR_SHIPMENT_CHANNEL_ID} tidak ketemu — dorongan dilewat.`);
    return "belum-siap";
  }

  const res = await fetchNativeQueryWithPagination(config, shipmentByIdQuery(batchId));
  const shipment = rowsToShipments(res.columns, res.rows)[0];
  if (!shipment) return "tidak-ketemu";

  const sudah = await kodeSudahDiumumkan(channel);
  if (sudah.has(shipmentCode(shipment))) return "sudah-ada";

  const items = (await fetchItems(config, [shipment.id])).get(shipment.id) ?? [];
  const perluDikerjakan = shipment.status === "pending" || shipment.status === "running";
  await channel.send({
    content: perluDikerjakan ? mention(shipment, channel) : undefined,
    embeds: [openingEmbed(shipment, items)]
  });
  console.log(`[wsr-shipment] ${shipmentCode(shipment)} diumumkan seketika (dorongan kakera).`);
  return "terkirim";
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

  {
    /*
      Dijalankan SETIAP putaran, bukan cuma waktu maxId > watermark.

      Syarat lama itu masuk akal selama watermark dipercaya penuh; sekarang yang
      dicari justru kiriman yang watermark-nya sudah telanjur melewati mereka —
      dan untuk kiriman begitu maxId TIDAK pernah lebih besar dari watermark.
      Ongkosnya satu query sempit tiap lima menit.
    */
    const res = await fetchNativeQueryWithPagination(
      config,
      newShipmentsQuery(sejakId, batasWaktuWib(env.WSR_SHIPMENT_LOOKBACK_HOURS))
    );
    const sudah = await kodeSudahDiumumkan(channel);
    const shipments = rowsToShipments(res.columns, res.rows).filter(
      (s) => !sudah.has(shipmentCode(s))
    );
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
            content: perluDikerjakan ? mention(shipment, channel, items) : undefined,
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

/**
 * Kirim ULANG pengumuman satu kiriman — dipakai manual, bukan oleh poller, saat
 * pengumuman aslinya sudah telanjur terkirim dengan isi yang salah (mis. tag-nya
 * menepuk pundak orang yang bukan kotanya). Watermark tidak disentuh, jadi ini
 * tidak mengubah apa pun yang dipantau poller.
 *
 * `selaluTag` untuk mengetes tag pada kiriman yang sudah beres; tanpa itu aturan
 * normal yang berlaku (yang sudah selesai tidak di-tag).
 */
export async function kirimUlangPengumuman(
  client: Client,
  batchId: number,
  opsi: { selaluTag?: boolean } = {}
): Promise<void> {
  const config = metabaseConfig();
  if (!config) throw new Error("Metabase belum dikonfigurasi.");

  const res = await fetchNativeQueryWithPagination(config, `${batchSelect} WHERE b.id = ${batchId}`);
  const shipment = rowsToShipments(res.columns, res.rows)[0];
  if (!shipment) throw new Error(`Kiriman #${batchId} tidak ada di wsr_batches.`);

  const channel = (await client.channels.fetch(env.WSR_SHIPMENT_CHANNEL_ID).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) throw new Error(`Channel ${env.WSR_SHIPMENT_CHANNEL_ID} tidak ketemu.`);
  // Dipanggil dari skrip sekali jalan: role belum tentu sempat masuk cache
  // seperti di bot yang sudah lama hidup, jadi ditarik dulu.
  await channel.guild.roles.fetch();

  const items = (await fetchItems(config, [shipment.id])).get(shipment.id) ?? [];
  const perluDikerjakan = shipment.status === "pending" || shipment.status === "running";
  await channel.send({
    content: perluDikerjakan || opsi.selaluTag ? mention(shipment, channel, items) : undefined,
    embeds: [openingEmbed(shipment, items)]
  });
  console.log(`[wsr-shipment] pengumuman ${shipmentCode(shipment)} dikirim ulang (status ${shipment.status}).`);
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
