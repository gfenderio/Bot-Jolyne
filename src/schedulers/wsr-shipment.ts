import {
  AnyThreadChannel,
  Client,
  EmbedBuilder,
  MessageCreateOptions,
  TextChannel
} from "discord.js";
import { env } from "../config/env.js";
import { fetchNativeQueryWithPagination, type MetabaseConfig } from "../services/metabase.js";
import {
  getOrInitWatermark,
  getReported,
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
 * Keputusan 9 Sep 2026: PENGINGAT SUSULAN DIHAPUS. Daftar "sudah diingatkan"
 * hidup di berkas tanpa volume, jadi tiap redeploy ia hilang dan seluruh
 * kiriman yang menggantung diingatkan ULANG — dua kali pada 9 Sep, karena
 * proses lama dan baru sempat hidup bersamaan. Sejak ada thread per kiriman,
 * kirimannya juga sudah punya tempatnya sendiri yang tidak tenggelam, jadi
 * pesan susulan di channel cuma menambah kebisingan pada tag yang sama.
 *
 * Keputusan 28 Jul: Excel DIHAPUS. Daftar barangnya sudah ada di PDA — lengkap
 * dengan urutan rak dan centang per barang — jadi berkas kedua di Discord cuma
 * jadi salinan yang bisa basi begitu ada yang dicentang. Peran Jolyne tinggal
 * dua: (1) menepuk pundak orang gudang saat ada kiriman baru,
 * (2) melapor balik setelah dikerjakan — siapa yang mengerjakan, berapa yang jadi
 * dikirim, dan berapa yang tidak (biasanya karena barangnya belum ada).
 *
 * Sumber data: tabel `wsr_batches` + `wsr_batch_items` via Metabase (readonly).
 * Skema hasil normalisasi review Shanieulle: nama barang/gudang/rak/orang
 * TIDAK disalin ke tabel batch — di-JOIN dari `items`/`item_sources`/`racks`/
 * `users` (string hanya hidup di tabel asalnya).
 */

export interface ShipmentRow {
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

export interface ShipmentItem {
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
// Alamat layar kerja gudang. Sempat tertulis /warehouse/rotasi-stok — alamat
// yang tidak pernah ada, jadi tiap orang yang menekannya mendarat di halaman
// kosong lalu menyimpulkan kirimannya belum masuk.
const WEB_GUDANG = "<https://team.kyou.id/warehouse/stock-rotation>";

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

/**
 * Jumlah pcs per gudang, di sisi asal atau sisi tujuan. Urut dari yang paling
 * banyak — yang paling banyak itu yang paling lama disiapkan orangnya.
 */
function qtyPerWarehouse(items: ShipmentItem[], sisi: "source" | "destination"): [string, number][] {
  const per = new Map<string, number>();
  for (const item of items) {
    const nama = (sisi === "source" ? item.source : item.destination).trim().toUpperCase();
    if (!nama) continue;
    per.set(nama, (per.get(nama) ?? 0) + item.qty);
  }
  return [...per.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Toko yang dilayani unit ini. Nama unit selalu dimulai nama tokonya
 * (`ALPHA`, `BETA`, `GAMMA_LAMBDA` → toko Gamma, gudang pasangannya Lambda).
 */
function storeOfUnit(unit: string): string {
  return unit.trim().toUpperCase().split("_")[0] ?? "";
}

/**
 * Kalimat arah — DIPERIKSA ULANG ke isi kirimannya, bukan dipercaya begitu saja
 * dari kolom `direction`.
 *
 * Enum `direction` di hanayo cuma tiga (request/return/event) dan sengaja tidak
 * ditambah. Akibatnya "Minta dari Bekasi" — Omega/SS mengirim ke GUDANG Lambda,
 * bukan ke toko mana pun — ikut tersimpan sebagai `request`, dan arah aslinya
 * cuma hidup di Postgres kakera yang tidak bisa dilihat dari sini. Kalimat
 * "Gudang → Toko (isi toko)" untuk kiriman seperti itu bukan kurang tepat, tapi
 * salah: yang menerima gudang, dan yang harus menyiapkan orang kota lain.
 *
 * Terjadi 8 Sep 2026 di WSR-GAMMA_LAMBDA-19 — 78 pcs dari lima gudang Bekasi
 * ke Lambda, diumumkan sebagai "isi toko".
 *
 * Yang membedakannya ada di barangnya sendiri: kalau tujuannya BUKAN toko unit
 * ini, kirimannya memang bukan pengisian toko.
 */
function directionSentence(shipment: ShipmentRow, asal: string[], tujuan: string[]): string {
  const bawaan = ARAH[shipment.direction] ?? shipment.direction;
  const toko = storeOfUnit(shipment.unit);
  if (!toko) return bawaan;
  if (shipment.direction === "request" && tujuan.length > 0 && !tujuan.includes(toko)) {
    return `Gudang → Gudang (isi gudang ${tujuan.join("/")})`;
  }
  if (shipment.direction === "return" && asal.length > 0 && !asal.includes(toko)) {
    return `Gudang → Gudang (pulangkan ke ${tujuan.join("/")})`;
  }
  return bawaan;
}

/**
 * Rute sebenarnya, dan sekaligus cara menyebut penerimanya tanpa menepuk
 * pundaknya: yang di-tag cuma sisi yang mengambil barang dari rak, sedangkan
 * yang menerima perlu disebut supaya kirimannya tidak terbaca "entah ke mana".
 */
function routeSentence(asal: string[], tujuan: string[]): string {
  if (asal.length === 0 || tujuan.length === 0) return "";
  return `Diambil dari **${asal.join("/")}**, diterima **${tujuan.join("/")}**.`;
}

export function openingEmbed(shipment: ShipmentRow, items: ShipmentItem[]): EmbedBuilder {
  const perAsal = qtyPerWarehouse(items, "source");
  const perTujuan = qtyPerWarehouse(items, "destination");
  const asal = perAsal.map(([nama]) => nama);
  const tujuan = perTujuan.map(([nama]) => nama);

  /*
    DIPECAH PER ASAL kalau tujuannya cuma satu tempat.

    Rinciannya dulu selalu per tujuan, dan untuk pengisian toko itu memang yang
    dicari. Tapi untuk kiriman yang tujuannya satu gudang, barisnya jadi
    "LAMBDA 78 pcs" — mengulang satu-satunya tujuan yang sudah disebut di
    kalimat rutenya, dan tidak memberi tahu apa pun. Yang menentukan siapa
    berdiri di rak mana justru ASALNYA.
  */
  const pecahPerAsal = tujuan.length === 1 && asal.length > 1;
  const angka = pecahPerAsal ? perAsal : perTujuan;
  const rincian =
    angka.length === 0
      ? ""
      : `${pecahPerAsal ? "Dari" : "Untuk"} ${angka.map(([nama, qty]) => `**${nama}** ${qty} pcs`).join(" · ")}`;
  const rute = routeSentence(asal, tujuan);

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
      `${directionSentence(shipment, asal, tujuan)}\n` +
        (rute ? `${rute}\n` : "") +
        // Kiriman yang rincian barangnya gagal dibaca tidak meninggalkan baris
        // kosong menganga di tengah pesan — yang hilang cuma rinciannya.
        `\n**${shipment.totalItems} barang · ${shipment.totalQty} pcs**\n` +
        (rincian ? `${rincian}\n` : "") +
        `\n` +
        `Diminta oleh **${shipment.createdBy}** dari **${shipment.unit}**.\n\n` +
        penutup
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
 *
 * `items` WAJIB diisi, dan penutup `= []` yang dulu ada di sini sengaja dicabut:
 * jalur "umumkan seketika" memanggilnya tanpa daftar barang, jatuh ke aturan
 * lama tanpa satu pun peringatan, dan itu membuat perbaikan 3 Sep 2026 tidak
 * pernah benar-benar jalan — hampir semua pengumuman lahir dari jalur itu.
 * Ketahuannya baru 9 Sep dari keluhan orang toko yang kirimannya ditepuk ke
 * kota yang salah. Pemanggil yang tidak punya daftar barangnya harus menulis
 * `[]` sendiri, supaya jatuhnya ke aturan lama itu disengaja.
 */
/**
 * Peran Discord tiap toko, dibaca saat dipakai — bukan dibekukan saat modul
 * dimuat, supaya env yang diisi belakangan langsung berlaku tanpa deploy ulang.
 *
 * Cuma toko. Gudang (Omega, SS, Sigma, OP, Lambda) tetap memakai tag Bekasi /
 * Surabaya yang sudah ada, dan itu sengaja tidak disentuh.
 */
const PERAN_TOKO: Record<string, () => string> = {
  ALPHA: () => env.WSR_SHIPMENT_MENTION_TOKO_ALPHA_ID?.trim() ?? "",
  BETA: () => env.WSR_SHIPMENT_MENTION_TOKO_BETA_ID?.trim() ?? "",
  GAMMA: () => env.WSR_SHIPMENT_MENTION_TOKO_GAMMA_ID?.trim() ?? "",
};

/**
 * Ubah isi env peran toko jadi id yang bisa ditag.
 *
 * Isinya boleh id (deretan angka) atau NAMA peran. Nama dicari di daftar peran
 * server, tanpa peduli besar-kecil huruf dan spasi berlebih — nama yang diketik
 * orang jarang persis sama dengan yang tersimpan.
 *
 * Tidak ketemu = kembalikan kosong, bukan menebak. Tag yang menunjuk id karangan
 * tampil sebagai teks mentah tanpa memberi tahu siapa pun, dan itu lebih buruk
 * daripada tidak menandai sama sekali karena kelihatan seolah sudah bekerja.
 */
/*
  Pastikan daftar peran server sudah terbaca.

  Pencarian peran — baik menurut nama maupun untuk menentukan bentuk tag-nya —
  membaca cache, dan cache itu TIDAK dijamin terisi di jalur biasa: ia diisi
  saat bot menyambung, dan sambungan yang baru pulih setelah putus bisa
  meninggalkannya kosong. Cache kosong berarti tag-nya diam-diam hilang, dan
  kegagalannya tidak muncul di mana pun.

  Sekali per pengiriman, dan cuma kalau cache-nya memang kosong. Gagalnya
  ditelan: tag yang hilang tidak boleh menahan pengumuman kirimannya.
*/
async function siapkanPeran(channel: TextChannel): Promise<void> {
  try {
    if ((channel.guild?.roles.cache.size ?? 0) === 0) await channel.guild?.roles.fetch();
  } catch {
    // sengaja diam — lihat catatan di atas
  }
}

function idPeran(isi: string, channel: TextChannel): string {
  const v = isi.trim();
  if (!v) return "";
  if (/^\d+$/.test(v)) return v;
  const cari = v.toLowerCase();
  const peran = channel.guild?.roles.cache.find((r) => r.name.trim().toLowerCase() === cari);
  return peran?.id ?? "";
}

function mentionIdsUntuk(shipment: ShipmentRow, items: ShipmentItem[], channel: TextChannel): string[] {
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

  /*
    Kalau yang mengerjakan tokonya sendiri, peran tokonya ikut ditag.

    Kiriman antar toko — Beta minta barang yang ada di Alpha — yang mengambilnya
    dari rak orang toko Alpha. Tag gudang di atas tidak diganti, cuma ditambah:
    satu kiriman bisa mencampur barang dari toko DAN dari gudang, dan memilih
    salah satu berarti separuhnya tidak ada yang tahu.

    Yang ditag PERAN, bukan orang. Peran bertahan waktu orangnya ganti shift
    atau keluar; id orang berhenti berarti tanpa ada yang sadar.
  */
  for (const g of pengerja) {
    const isi = PERAN_TOKO[g]?.();
    if (!isi) continue;
    const idToko = idPeran(isi, channel);
    if (idToko) ids.push(idToko);
  }

  return [...new Set(ids)];
}

/**
 * Tag orang gudang; kosong kalau env-nya sengaja dikosongkan.
 *
 * Bentuk tag-nya ditentukan saat kirim, bukan dihafal: id yang sama bisa milik
 * role (`<@&id>`) atau orang (`<@id>`), dan salah bentuk bikin tag-nya tampil
 * sebagai teks mentah tanpa notifikasi ke siapa pun.
 */
function mention(shipment: ShipmentRow, channel: TextChannel, items: ShipmentItem[]): string {
  const ids = mentionIdsUntuk(shipment, items, channel);
  if (ids.length === 0) return "";
  return ids.map((id) => (channel.guild?.roles.cache.has(id) ? `<@&${id}> ` : `<@${id}> `)).join("");
}

/*
SATU KIRIMAN, SATU THREAD (permintaan Gilang, 9 Sep 2026).

Sampai sekarang tiap kiriman menaruh tiga pesan terpisah di channel yang sama:
pengumuman dan laporan selesainya. Untuk satu kiriman itu masih terbaca; untuk
beberapa kiriman yang berjalan bersamaan, keduanya
berselang-seling dengan kiriman lain, dan orang yang mau tahu "kiriman saya
sampai mana" harus menyusuri channel sambil mencocokkan kodenya sendiri.

THREAD-NYA DICARI DARI DISCORD, BUKAN DISIMPAN. Store bot ini hidup di berkas
biasa tanpa volume persisten — tiap redeploy ia hilang (lihat wsrShipmentStore).
Id thread yang disimpan di sana akan ikut hilang, dan laporannya diam-diam
balik lagi ke channel. Nama thread = kode kirimannya, jadi thread-nya bisa
dikenali dari Discord sendiri, sumber yang tidak ikut hilang saat deploy.
Cara yang sama sudah dipakai penjaga anti-dobel (kodeSudahDiumumkan).

KALAU THREAD-NYA TIDAK KETEMU, pesannya tetap dikirim ke channel. Kiriman lama
(sebelum hari ini) memang tidak punya thread, dan laporan selesai yang batal
terkirim gara-gara itu jauh lebih buruk daripada yang mendarat di channel.
*/

/** Umur thread sebelum ditutup sendiri kalau tidak ada yang bicara: 7 hari. */
const THREAD_ARSIP_MENIT = 10080;

/**
 * Thread kiriman yang sudah ada di channel ini, dikunci nama = kode kiriman.
 * Ditarik SEKALI per putaran, bukan per kiriman: dua panggilan Discord untuk
 * seluruh daftar, bukan dua dikali jumlah kiriman.
 */
async function petaThreadKiriman(channel: TextChannel): Promise<Map<string, AnyThreadChannel>> {
  const out = new Map<string, AnyThreadChannel>();
  const aktif = await channel.threads.fetchActive().catch(() => null);
  for (const t of aktif?.threads.values() ?? []) {
    if (t.name.startsWith("WSR-")) out.set(t.name, t);
  }
  // Yang sudah diarsipkan ikut dicari: kiriman yang selesai thread-nya ditutup,
  // dan laporan susulan untuknya tetap harus mendarat di tempat yang sama.
  const arsip = await channel.threads.fetchArchived({ limit: 100 }).catch(() => null);
  for (const t of arsip?.threads.values() ?? []) {
    if (t.name.startsWith("WSR-") && !out.has(t.name)) out.set(t.name, t);
  }
  return out;
}

/**
 * Kirim satu pesan susulan ke thread kirimannya — atau ke channel kalau
 * thread-nya tidak ada. Mengembalikan thread yang dipakai, supaya pemanggilnya
 * bisa menutup thread yang kirimannya sudah beres.
 */
async function kirimSusulan(
  channel: TextChannel,
  peta: Map<string, AnyThreadChannel>,
  code: string,
  payload: MessageCreateOptions
): Promise<AnyThreadChannel | null> {
  const thread = peta.get(code);
  if (!thread) {
    await channel.send(payload);
    return null;
  }
  // Thread yang sudah diarsipkan menolak pesan baru; dibuka dulu, dan yang
  // menutupnya lagi cuma laporan selesai.
  if (thread.archived) await thread.setArchived(false).catch(() => undefined);
  await thread.send(payload);
  return thread;
}

/**
 * Pengumuman pembuka + thread-nya — SATU tempat untuk ketiga jalur yang
 * mengumumkan (poller, dorongan kakera, kirim ulang manual).
 *
 * Disatukan justru karena cacat yang sedang diperbaiki: ketiganya dulu menyusun
 * `channel.send` sendiri-sendiri, dan waktu aturan tag diperbaiki 3 Sep 2026,
 * dua ikut diperbaiki dan satu tidak. Selama pesannya dirakit di tiga tempat,
 * cacat seperti itu pasti lahir lagi.
 */
async function kirimPengumuman(
  channel: TextChannel,
  shipment: ShipmentRow,
  items: ShipmentItem[],
  opsi: { selaluTag?: boolean; threadYangAda?: Map<string, AnyThreadChannel> } = {}
): Promise<void> {
  // Tag ditaruh di isi pesan, bukan di embed: mention di dalam embed TIDAK
  // memicu notifikasi Discord — orangnya tak akan tahu.
  //
  // Kiriman yang saat diumumkan sudah selesai/dibatalkan tetap dikabarkan (biar
  // ada jejak "kiriman ini pernah dibuat"), tapi TANPA tag dan TANPA thread:
  // menepuk pundak orang untuk kerjaan yang sudah beres cuma bikin tag-nya
  // berhenti dipercaya, dan thread kosong yang langsung ditutup cuma sampah.
  const perluDikerjakan = shipment.status === "pending" || shipment.status === "running";
  const code = shipmentCode(shipment);
  await siapkanPeran(channel);
  const pesan = await channel.send({
    content: perluDikerjakan || opsi.selaluTag ? mention(shipment, channel, items) : undefined,
    embeds: [openingEmbed(shipment, items)]
  });
  if (!perluDikerjakan) return;

  const peta = opsi.threadYangAda ?? (await petaThreadKiriman(channel));
  // Kirim ulang pengumuman yang telanjur salah TIDAK membuat thread kedua
  // dengan nama yang sama — Discord mengizinkannya, dan hasilnya dua tempat
  // untuk satu kiriman.
  if (peta.has(code)) return;

  try {
    const thread = await pesan.startThread({ name: code, autoArchiveDuration: THREAD_ARSIP_MENIT });
    peta.set(code, thread);
  } catch (err) {
    // Gagal membuat thread (izin belum ada, Discord sedang rewel) BUKAN alasan
    // untuk menganggap pengumumannya gagal — pengumumannya sudah terkirim, dan
    // susulannya akan mendarat di channel seperti sebelum ada thread.
    console.error(`[wsr-shipment] gagal membuka thread ${code}:`, err);
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

  const peta = await petaThreadKiriman(channel);
  const terkirim: number[] = [];
  for (const shipment of belum) {
    const angka = hitung.get(shipment.id) ?? { dipindah: 0, tidak: 0 };
    // Dibatalkan tanpa satu pun barang berpindah = tidak ada yang perlu dilaporkan
    // ke orang toko selain "batal"; tetap dikabarkan, tapi nadanya beda.
    const utuh = shipment.status === "done";

    try {
      const thread = await kirimSusulan(channel, peta, shipmentCode(shipment), {
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
      // Kiriman ini sudah tidak menunggu apa-apa lagi, jadi thread-nya ditutup.
      // Ditutup, BUKAN dikunci: kalau ada yang perlu ditanyakan soal barang yang
      // tidak jadi dikirim, orangnya masih bisa membukanya dengan membalas.
      if (thread && !thread.archived) await thread.setArchived(true).catch(() => undefined);
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
  await kirimPengumuman(channel, shipment, items);
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
      // Daftar thread ditarik sekali untuk seluruh putaran, lalu ikut terisi
      // sendiri tiap ada thread baru dibuka.
      const threadYangAda = await petaThreadKiriman(channel);

      let terkirim = 0;
      for (const shipment of shipments) {
        try {
          const items = itemsByBatch.get(shipment.id) ?? [];
          await kirimPengumuman(channel, shipment, items, { threadYangAda });
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

  // Selalu dijalankan, termasuk saat tidak ada kiriman baru: kiriman bisa
  // selesai dikerjakan tanpa ada kiriman baru yang lahir di putaran yang sama.
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
  await kirimPengumuman(channel, shipment, items, { selaluTag: opsi.selaluTag });
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
