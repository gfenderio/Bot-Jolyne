import fs from "fs";
import path from "path";
import { env } from "../config/env.js";

/**
 * Catatan "tautan cetak gudang mana yang dibuka, jam berapa".
 *
 * MASALAH YANG DISELESAIKAN. `admin_logs` mencatat BAHWA sebuah order dicetak,
 * tapi tidak mencatat BAGIAN MANA yang dicetak — `packGroupId` dikirim ke
 * halaman cetak tapi tidak ikut disimpan. Jadi selama ini bot menebaknya dari
 * lokasi kerja si pencetak (`users.office_location`). Tebakan itu meleset
 * begitu orang gudang lain yang mengklik, begitu pencetaknya tidak punya
 * lokasi (19 admin), atau begitu ada orang pindah gudang — karena lokasi
 * dibaca SEKARANG, bukan lokasi saat dia mencetak dulu.
 *
 * CARA KERJANYA. Tautan cetak di pesan Discord tidak lagi menunjuk langsung ke
 * old.kyou.id, tapi ke `/print/<order>/<grup>` di server bot ini. Bot mencatat
 * kliknya lalu membelokkan ke halaman cetak yang sama seperti dulu.
 *
 * KLIK BUKAN BUKTI CETAK. Ini yang paling penting di berkas ini. Membuka
 * tautan belum tentu menghasilkan label: sesi bisa habis dan orangnya mendarat
 * di halaman login. Kalau klik dianggap bukti, gudang itu berhenti dipanggil
 * padahal labelnya tidak pernah keluar — persis kesalahan yang paling mahal,
 * karena diamnya tidak kelihatan oleh siapa pun.
 *
 * Jadi klik cuma dipakai sebagai PENUNJUK: bukti tetap dicari di `admin_logs`.
 * Kalau ada catatan cetak yang jatuh di jendela sesudah klik, catatan itu
 * dihubungkan ke gudang yang diklik. Kalau tidak ada catatan sama sekali,
 * kliknya tidak berarti apa-apa dan gudang itu tetap dipanggil.
 *
 * JAM. Nilai `at` disimpan dalam WIB dan format DATETIME MySQL, supaya bisa
 * dibandingkan apa adanya dengan `admin_logs.created_at` — kolom itu memang
 * berisi jam WIB, sementara sesi MySQL berjalan di UTC. Membandingkannya lewat
 * `Date` JS akan menggeser tujuh jam dan tidak akan pernah cocok.
 *
 * Sama seperti store split-print lainnya: berkas JSON biasa. Kalau hilang saat
 * redeploy, yang terjadi cuma kembali ke tebakan lama — tidak ada yang rusak.
 */

export interface PrintClick {
  orderId: string;
  packGroupId: number;
  /** WIB, "2026-08-06 09:16:23" — sebanding langsung dengan admin_logs.created_at. */
  at: string;
}

interface ClickStore {
  clicks: PrintClick[];
}

/**
 * Klik yang lebih tua dari ini dibuang. Order yang catatan cetaknya belum
 * muncul setelah tiga hari sudah bukan urusan pencocokan lagi — dan tanpa
 * pembuangan, berkasnya tumbuh selamanya.
 */
const SIMPAN_HARI = 3;

/**
 * Berapa lama sesudah klik sebuah catatan cetak masih dianggap berasal dari
 * klik itu. Cukup longgar untuk orang yang harus login dulu, cukup sempit
 * supaya cetakan orang lain di order yang sama tidak ikut terklaim.
 */
export const JENDELA_KLIK_MENIT = 15;

function storePath(): string {
  return env.SPLIT_PRINT_CLICK_STORE_PATH;
}

function readStore(): ClickStore {
  const file = storePath();
  if (!fs.existsSync(file)) return { clicks: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { clicks: Array.isArray(parsed.clicks) ? parsed.clicks : [] };
  } catch {
    return { clicks: [] };
  }
}

function writeStore(store: ClickStore) {
  const dir = path.dirname(storePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), "utf-8");
}

/** Jam WIB sekarang dalam format DATETIME MySQL. */
export function nowWib(): string {
  // `sv-SE` memberi "2026-08-06 09:16:23" apa adanya — tidak perlu dirakit
  // sendiri dari potongan tanggal, dan tidak ada risiko bulan/hari tertukar.
  return new Date()
    .toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" })
    .replace("T", " ")
    .slice(0, 19);
}

/** Geser DATETIME MySQL sekian menit, tetap sebagai teks WIB. */
export function geserMenit(datetime: string, menit: number): string {
  const [tanggal, jam] = datetime.split(" ");
  if (!tanggal || !jam) return datetime;
  // Dihitung sebagai UTC lalu ditulis balik sebagai teks: nilainya diperlakukan
  // sebagai angka jam, BUKAN sebagai waktu di zona tertentu — jadi tidak ada
  // pergeseran zona yang menyelinap masuk.
  const dasar = new Date(`${tanggal}T${jam}Z`);
  if (Number.isNaN(dasar.getTime())) return datetime;
  return new Date(dasar.getTime() + menit * 60_000).toISOString().replace("T", " ").slice(0, 19);
}

export function catatKlik(orderId: string, packGroupId: number): PrintClick {
  const store = readStore();
  const klik: PrintClick = { orderId, packGroupId, at: nowWib() };

  const batas = geserMenit(klik.at, -SIMPAN_HARI * 24 * 60);
  store.clicks = store.clicks.filter((c) => c.at >= batas);
  store.clicks.push(klik);

  writeStore(store);
  return klik;
}

/** Semua klik yang masih tersimpan, terurut dari yang paling lama. */
export function daftarKlik(): PrintClick[] {
  return readStore().clicks.slice().sort((a, b) => a.at.localeCompare(b.at));
}
