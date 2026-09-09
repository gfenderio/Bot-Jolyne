import type { IncomingMessage, ServerResponse } from "node:http";
import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";

/**
 * POST /machitan/opname-kor-sweep — hasil sapuan selisih opname jam 2 pagi.
 *
 * Hanayo memindahkan selisih KURANG opname event yang tak kunjung dibereskan ke
 * kantong {GUDANG}-KOR, lalu mengirim hasilnya ke sini. Selisih itu tidak muncul
 * di layar mana pun, jadi Excel ini SATU-SATUNYA permukaan laporannya — dipakai
 * saat settlement untuk tahu barang apa yang hilang malam itu dan siapa yang
 * menghitungnya.
 *
 * Beda dengan /machitan/ws-inbox yang menumpuk ke berkas lalu dilaporkan
 * terjadwal: kiriman ini SUDAH satu laporan utuh untuk satu malam, jadi langsung
 * dikirim begitu diterima. Tidak ada yang perlu ditumpuk.
 */

const TARGET_CHANNEL_ID = "1501899831268868106"; // channel pick pack / machitan update

/**
 * Hasil penyisir pending WS, dititipkan hanayo di kiriman yang sama.
 *
 * Tidak menambah kartu kedua: dua kartu berturut-turut tiap malam membuat yang
 * kedua terlewat dibaca. Isinya masuk ke Excel yang memang sudah jadi tempat
 * rincian, dan kartunya cuma menyebut jumlahnya.
 */
type WsSisir = {
  sisir_at?: string;
  ditutup?: WsDitutup[];
  nyangkut?: WsNyangkut[];
};

type WsDitutup = {
  item_id?: string;
  nama?: string;
  source?: string;
  rak?: string;
  hitungan?: number;
  seharusnya?: number;
  selisih?: number;
  oleh?: string;
};

type WsNyangkut = {
  item_id?: string;
  nama?: string;
  source?: string;
  sebab?: string;
  umur_hari?: number;
  oleh?: string;
};

const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/**
 * "2026-08-31 02:00:13" jadi "31 Agustus 2026, 02:00".
 *
 * Hanayo mengirim waktu Jakarta apa adanya, jadi teksnya dipotong langsung
 * tanpa lewat Date — membungkusnya jadi Date akan menggesernya tujuh jam dan
 * laporan jam 2 pagi terbaca sebagai kemarin sore.
 */
/**
 * Umur baris paling tua, dalam hari. null kalau hanayo belum mengirim `umur_hari`
 * — versi lamanya memang tidak punya kolom itu, dan angka karangan lebih buruk
 * daripada kalimat tanpa angka.
 */
function umurTertua(items: SweptItem[]): number | null {
  let tertua: number | null = null;
  for (const it of items) {
    const n = Number((it as { umur_hari?: unknown }).umur_hari);
    if (Number.isFinite(n) && (tertua === null || n > tertua)) tertua = n;
  }
  return tertua;
}

function waktuManusiawi(sweptAt: string): string {
  const cocok = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(sweptAt);
  if (!cocok) return sweptAt;
  const [, tahun, bulan, tanggal, jam, menit] = cocok;
  const namaBulan = BULAN[Number(bulan) - 1] ?? bulan;
  return `${Number(tanggal)} ${namaBulan} ${tahun}, ${jam}:${menit}`;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

class PayloadTooLargeError extends Error {}

// Metadata murni tanpa foto. Sapuan terburuk pun ratusan baris, jauh di bawah 5MB.
async function readRequestBody(request: IncomingMessage, maxBytes = 5 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new PayloadTooLargeError("Payload terlalu besar.");
  }
  return body;
}

type SweptItem = {
  item_id?: string;
  item_name?: string | null;
  source?: string;
  kor_source?: string;
  system_stock?: number;
  counted_stock?: number;
  qty_to_kor?: number;
  counted_by?: string | null;
  counted_at?: string | null;
};

/**
 * Kelebihan hitungan yang belum dijelaskan. Ini TIDAK pernah disapu — menambah
 * stok dari nol bukan wewenang lantai gudang — jadi baris di sini murni laporan
 * supaya ada yang memutuskan, bukan catatan sesuatu yang sudah terjadi.
 */
type SurplusItem = {
  item_id?: string;
  item_name?: string | null;
  source?: string;
  system_stock?: number;
  counted_stock?: number;
  surplus?: number;
  /** Isi kantong KOR gudang yang menghitung — cuma ini yang bisa diambil sendiri. */
  kor_tersedia?: number;
  /**
   * Isi kantong KOR gudang LAIN, dan nama kantongnya.
   *
   * Dulu dua-duanya dijumlah jadi satu angka `kor_tersedia`, dan kartunya bilang
   * "ada di KOR gudang itu" untuk barang yang unitnya duduk di KOR global —
   * petugasnya berdiri di depan kantong kosong. Dipisah supaya kalimatnya bisa
   * menyebut kantong yang benar.
   */
  kor_lain?: number;
  kor_lain_kantong?: string;
  admin_name?: string | null;
  counted_at?: string | null;
};

export function buildOpnameKorSweepWorkbook(
  items: SweptItem[],
  needsHuman: string[],
  sweptAt: string,
  surplus: SurplusItem[] = [],
  ws: WsSisir | null = null,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();

  const sheet = workbook.addWorksheet("Pindah ke KOR");
  sheet.columns = [
    { header: "Item ID", key: "itemId", width: 12 },
    { header: "Nama Barang", key: "name", width: 46 },
    { header: "Gudang", key: "source", width: 14 },
    { header: "KOR Tujuan", key: "kor", width: 18 },
    { header: "Stok Sistem", key: "system", width: 13 },
    { header: "Hasil Hitung", key: "counted", width: 13 },
    { header: "Masuk KOR", key: "qty", width: 12 },
    { header: "Dihitung Oleh", key: "by", width: 22 },
    { header: "Waktu Hitung", key: "at", width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const it of items) {
    sheet.addRow({
      itemId: it.item_id ?? "-",
      name: it.item_name ?? "-",
      source: it.source ?? "-",
      kor: it.kor_source ?? "-",
      system: Number(it.system_stock ?? 0),
      counted: Number(it.counted_stock ?? 0),
      qty: Number(it.qty_to_kor ?? 0),
      // Yang menghitung, BUKAN yang menyapu. Penyapunya selalu akun sistem dan
      // itu tidak berguna buat siapa pun yang membaca laporan ini.
      by: it.counted_by ?? "-",
      at: it.counted_at ?? "-",
    });
  }

  // Sheet kedua hanya dibuat kalau memang ada isinya, supaya lampiran yang
  // bersih tidak menyisakan tab kosong yang bikin orang mengira ada masalah.
  if (needsHuman.length > 0) {
    const manual = workbook.addWorksheet("Tidak Bisa Dipindah");
    manual.columns = [{ header: "Keterangan", key: "note", width: 90 }];
    manual.getRow(1).font = { bold: true };
    for (const note of needsHuman) manual.addRow({ note });
  }

  if (surplus.length > 0) {
    const lebih = workbook.addWorksheet("Hitungan Lebih");
    lebih.columns = [
      { header: "Item ID", key: "itemId", width: 12 },
      { header: "Nama Barang", key: "name", width: 46 },
      { header: "Gudang", key: "source", width: 14 },
      { header: "Stok Sistem", key: "system", width: 13 },
      { header: "Hasil Hitung", key: "counted", width: 13 },
      { header: "Lebih", key: "surplus", width: 10 },
      // Pembeda yang menentukan tindakannya: kalau KOR ada isinya, kelebihan ini
      // sebenarnya bisa ditutup lewat PDA dan cuma terlewat. Kalau nol, barangnya
      // memang tidak tercatat di mana pun — itu tidak bisa diselesaikan dengan
      // transfer, harus diputuskan orang.
      { header: "Isi KOR", key: "kor", width: 10 },
      // Kantong gudang lain ditulis lengkap dengan namanya. Barang yang
      // ketemunya di KOR global tetap bisa dibereskan, cuma bukan oleh gudang
      // yang menghitung — dan tanpa nama kantongnya tidak ada yang tahu ke mana.
      { header: "Ada di KOR Lain", key: "korLain", width: 24 },
      { header: "Dihitung Oleh", key: "by", width: 22 },
      { header: "Waktu Hitung", key: "at", width: 20 },
    ];
    lebih.getRow(1).font = { bold: true };
    lebih.views = [{ state: "frozen", ySplit: 1 }];

    for (const it of surplus) {
      lebih.addRow({
        itemId: it.item_id ?? "-",
        name: it.item_name ?? "-",
        source: it.source ?? "-",
        system: Number(it.system_stock ?? 0),
        counted: Number(it.counted_stock ?? 0),
        surplus: Number(it.surplus ?? 0),
        kor: Number(it.kor_tersedia ?? 0),
        korLain: it.kor_lain_kantong ?? "-",
        by: it.admin_name ?? "-",
        at: it.counted_at ?? "-",
      });
    }
  }

  const wsDitutup = ws?.ditutup ?? [];
  const wsNyangkut = ws?.nyangkut ?? [];

  if (wsDitutup.length > 0) {
    const tutup = workbook.addWorksheet("WS Pending Ditutup");
    tutup.columns = [
      { header: "Item ID", key: "itemId", width: 12 },
      { header: "Nama Barang", key: "name", width: 46 },
      { header: "Gudang", key: "source", width: 14 },
      { header: "Rak", key: "rak", width: 14 },
      { header: "Stok Sistem", key: "system", width: 13 },
      { header: "Hasil Hitung", key: "counted", width: 13 },
      { header: "Selisih", key: "delta", width: 10 },
      { header: "Dihitung Oleh", key: "by", width: 22 },
    ];
    tutup.getRow(1).font = { bold: true };
    tutup.views = [{ state: "frozen", ySplit: 1 }];
    for (const it of wsDitutup) {
      tutup.addRow({
        itemId: it.item_id ?? "-",
        name: it.nama ?? "-",
        source: it.source ?? "-",
        rak: it.rak ?? "-",
        system: Number(it.seharusnya ?? 0),
        counted: Number(it.hitungan ?? 0),
        delta: Number(it.selisih ?? 0),
        by: it.oleh ?? "-",
      });
    }
  }

  if (wsNyangkut.length > 0) {
    // Sheet yang paling perlu dibaca orang: barang di sini TIDAK bisa
    // diselesaikan mesin dan akan menggantung sampai ada yang mengerjakannya.
    const nyangkut = workbook.addWorksheet("WS Pending Nyangkut");
    nyangkut.columns = [
      { header: "Item ID", key: "itemId", width: 12 },
      { header: "Nama Barang", key: "name", width: 46 },
      { header: "Gudang", key: "source", width: 14 },
      { header: "Kenapa belum ditutup", key: "sebab", width: 30 },
      { header: "Sudah menggantung (hari)", key: "umur", width: 24 },
      { header: "Terakhir Dikerjakan", key: "by", width: 22 },
    ];
    nyangkut.getRow(1).font = { bold: true };
    nyangkut.views = [{ state: "frozen", ySplit: 1 }];
    for (const it of wsNyangkut) {
      nyangkut.addRow({
        itemId: it.item_id ?? "-",
        name: it.nama ?? "-",
        source: it.source ?? "-",
        sebab: it.sebab ?? "-",
        umur: Number(it.umur_hari ?? 0),
        by: it.oleh ?? "-",
      });
    }
  }

  const info = workbook.addWorksheet("Info");
  info.columns = [
    { header: "Keterangan", key: "k", width: 28 },
    { header: "Nilai", key: "v", width: 50 },
  ];
  info.getRow(1).font = { bold: true };
  info.addRow({ k: "Waktu pemeriksaan", v: sweptAt });
  info.addRow({ k: "Barang pindah ke KOR", v: items.length });
  info.addRow({ k: "Total unit", v: items.reduce((sum, it) => sum + Number(it.qty_to_kor ?? 0), 0) });
  info.addRow({ k: "Tidak bisa dipindah", v: needsHuman.length });
  info.addRow({ k: "Hitungan lebih", v: surplus.length });
  info.addRow({ k: "WS pending ditutup", v: wsDitutup.length });
  info.addRow({ k: "WS pending nyangkut", v: wsNyangkut.length });

  return workbook;
}

export async function handleOpnameKorSweepIntake(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>,
) {
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed", ok: false });

  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    return sendJson(response, 401, { error: "Unauthorized", ok: false });
  }

  try {
    const body = JSON.parse(await readRequestBody(request));

    const items: SweptItem[] = Array.isArray(body.items) ? body.items : [];
    const needsHuman: string[] = Array.isArray(body.needs_human) ? body.needs_human.map(String) : [];
    const surplus: SurplusItem[] = Array.isArray(body.surplus) ? body.surplus : [];
    const sweptAt = String(body.swept_at ?? new Date().toISOString());
    const ws: WsSisir | null = body.ws ?? null;
    const wsDitutup = ws?.ditutup ?? [];
    const wsNyangkut = ws?.nyangkut ?? [];
    const totalUnits = Number(body.total_units ?? items.reduce((s, it) => s + Number(it.qty_to_kor ?? 0), 0));
    /*
     * MODE "TERTAHAN" — sejak 3 Sep 2026, hanayo tidak lagi memindahkan selisih
     * kurang ke KOR sendiri (keputusan Gilang sesudah sesi WSR Re:try dengan tim
     * toko). Sapuan malam berubah jadi laporan: "ini yang masih menggantung, dan
     * sudah berapa lama".
     *
     * Kalimatnya WAJIB ikut berubah. Laporan yang menyebut "sudah dipindah ke
     * KOR" padahal tidak ada yang pindah membuat orang gudang berhenti mencari
     * barang yang sebenarnya masih di rak mereka — kerusakan yang lebih besar
     * daripada laporan yang tidak terkirim sama sekali.
     *
     * Payload lama (tanpa `mode`) tetap dibaca sebagai "pindah", jadi bot ini
     * boleh tayang lebih dulu daripada hanayo tanpa mengubah apa pun.
     */
    const tertahan = String(body.mode ?? "pindah") === "tertahan";

    // Sapuan yang tidak menemukan apa-apa TIDAK dilaporkan. Lampiran kosong tiap
    // malam melatih orang mengabaikan laporan ini, dan yang penting justru malam
    // ketika isinya tidak kosong.
    if (
      items.length === 0 && needsHuman.length === 0 && surplus.length === 0
      && wsDitutup.length === 0 && wsNyangkut.length === 0
    ) {
      return sendJson(response, 200, { message: "Tidak ada yang dilaporkan", ok: true });
    }

    const workbook = buildOpnameKorSweepWorkbook(items, needsHuman, sweptAt, surplus, ws);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const tanggal = sweptAt.slice(0, 10);
    const attachment = new AttachmentBuilder(buffer, { name: `opname-kor-${tanggal}.xlsx` });

    // Dikelompokkan menurut SIAPA YANG HARUS BERTINDAK, bukan menurut apa yang
    // dikerjakan robot. Versi lamanya melaporkan tiga angka mentah dengan
    // bahasa mesin ("tidak disapu", "belum dijelaskan", "isi baris gudangnya"),
    // dan yang paling perlu ditindaklanjuti justru ditaruh paling bawah dengan
    // kalimat paling samar. Orang gudang membacanya tanpa tahu mana yang
    // urusannya dan mana yang bukan.
    //
    // Kolom kor_tersedia yang memisahkan dua golongan yang kelihatannya sama:
    // kelebihan yang barangnya ADA di KOR gudang itu bisa dibereskan petugas
    // sendiri lewat PDA, sedangkan yang KOR-nya kosong memang tidak punya asal
    // di mana pun dan harus diputuskan orang kantor.
    const lebihAdaDiKor = surplus.filter((it) => Number(it.kor_tersedia ?? 0) > 0);
    // Golongan tengah: barangnya ADA di kantong KOR, tapi bukan kantong gudang
    // yang menghitung. Bukan pekerjaan petugas lantai dan bukan pula perkara
    // yang buntu — cuma perlu orang yang memegang kantong itu.
    const lebihDiKorLain = surplus.filter(
      (it) => Number(it.kor_tersedia ?? 0) <= 0 && Number(it.kor_lain ?? 0) > 0,
    );
    const lebihTanpaAsal = surplus.filter(
      (it) => Number(it.kor_tersedia ?? 0) <= 0 && Number(it.kor_lain ?? 0) <= 0,
    );
    const perluDicek = needsHuman.length + surplus.length;

    const embed = new EmbedBuilder()
      .setTitle(
        perluDicek > 0
          ? `Hasil hitung stok semalam — ${perluDicek} barang perlu dicek`
          : tertahan && items.length > 0
            ? `Hasil hitung stok semalam — ${items.length} barang masih menggantung`
            : "Hasil hitung stok semalam",
      )
      .setDescription(
        [
          waktuManusiawi(sweptAt),
          "",
          items.length > 0
            ? tertahan
              // Umur diambil dari baris paling tua: satu barang yang menggantung
              // tiga minggu jauh lebih penting daripada dua puluh barang yang
              // baru semalam, dan rata-rata akan menyembunyikannya.
              ? `**${items.length} barang** hasil hitungnya kurang dan **masih menggantung** — belum ada yang menyatakan ketemu atau hilang${umurTertua(items) !== null ? `, yang terlama sudah **${umurTertua(items)} hari**` : ""}. Stoknya sengaja TIDAK dipindah ke KOR.`
              : `**${items.length} barang** (${totalUnits} unit) hasil hitungnya kurang dan sudah dipindah ke KOR gudangnya. Tidak perlu ditindaklanjuti.`
            : tertahan
              ? "Tidak ada hitungan yang menggantung semalam."
              : "Tidak ada stok yang berpindah semalam.",
          needsHuman.length > 0
            // Sebabnya TIDAK diketahui di sini. Yang diperiksa hanayo cuma
            // "kekurangan lebih besar dari isi baris gudang", dan itu bisa lahir
            // dari beberapa keadaan yang berbeda: unitnya duduk di kantong
            // reservasi, stoknya bergerak sesudah dihitung, atau gudangnya sudah
            // ditutup dan isinya dipulangkan — yang terakhir inilah yang menahan
            // 17 barang AFA ID 2026 selama 24 malam.
            //
            // Jadi kartunya BERHENTI menebak. Kalimat lamanya menyebut dua sebab
            // seolah cuma ada dua, dan orang gudang mencari ke tempat yang salah
            // lebih dulu sebelum tahu tebakannya meleset.
            ? `**${needsHuman.length} barang** hasil hitungnya kurang, tapi kurangnya lebih banyak daripada stok yang tercatat di gudang itu, jadi tidak bisa dipindah otomatis. Sebabnya beda-beda per barang dan perlu ditengok satu per satu — rinciannya di berkas.`
            : null,
          lebihAdaDiKor.length > 0
            ? `**${lebihAdaDiKor.length} barang** hasil hitungnya lebih, dan barangnya ada di KOR gudang itu. Bisa dibereskan sendiri: scan ulang barangnya di menu Opname, lalu ambil dari KOR.`
            : null,
          lebihDiKorLain.length > 0
            ? `**${lebihDiKorLain.length} barang** hasil hitungnya lebih, dan barangnya ada di kantong KOR gudang lain — bukan kantong gudang yang menghitung. Nama kantongnya ada di berkas.`
            : null,
          lebihTanpaAsal.length > 0
            ? `**${lebihTanpaAsal.length} barang** hasil hitungnya lebih dan belum ketahuan asalnya. Stoknya sengaja belum ditambah — menunggu keputusan orang kantor.`
            : null,
          wsDitutup.length > 0
            ? `**${wsDitutup.length} barang WS** yang tertinggal di Pending ditutup otomatis; selisihnya lewat KOR seperti penutupan biasa.`
            : null,
          wsNyangkut.length > 0
            ? `**${wsNyangkut.length} barang WS** masih menggantung di Pending dan tidak bisa ditutup sendiri — raknya kosong, belum dihitung, atau sedang dipegang orang. Daftarnya di berkas.`
            : null,
          "",
          "Isi KOR tiap gudang bisa ditengok kapan saja di https://team.kyou.id/warehouse/kor",
          "Daftar lengkap malam ini ada di berkas terlampir.",
        ]
          .filter((baris) => baris !== null)
          .join("\n"),
      )
      .setColor(
        needsHuman.length > 0 || lebihTanpaAsal.length > 0 || wsNyangkut.length > 0
          ? 0xd9ac5c
          : 0x1f6f5c,
      )
      .setTimestamp(new Date());

    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error("Channel laporan sapuan KOR tidak ditemukan atau bukan text channel");
      return sendJson(response, 500, { error: "Target channel unavailable", ok: false });
    }
    await (channel as TextChannel).send({ embeds: [embed], files: [attachment] });

    return sendJson(response, 200, { message: "Laporan sapuan KOR terkirim", ok: true });
  } catch (error) {
    console.error("Opname KOR Sweep Intake Error:", error);
    if (error instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { error: error.message, ok: false });
    }
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}
