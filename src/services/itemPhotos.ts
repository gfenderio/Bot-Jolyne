import { AttachmentBuilder } from "discord.js";
import sharp from "sharp";

/**
 * Foto barang untuk embed triase PICK — SATU BARANG SATU FOTO.
 *
 * Fotonya sengaja TIDAK digabung jadi satu kolase: barang yang digabung jadi
 * kecil-kecil dan susah dikenali di rak. Jadi tiap barang dikirim sebagai foto
 * sendiri. Foto barang pertama dipasang sebagai gambar utama embed; kalau
 * ordernya berisi lebih dari satu barang, foto sisanya ikut dilampirkan dan
 * tampil sebagai foto tambahan di bawah embed.
 *
 * Tiap foto diberi badge nomor di pojok kiri-atas, cocok dengan nomor di daftar
 * "Barang" pada embed — jadi baris teks dan fotonya bisa dicocokkan.
 *
 * Fotonya di-UNGGAH sebagai lampiran, bukan ditempel sebagai URL: kalau nanti
 * kyoucdn.id dipindah/dibatasi, embed lama tidak ikut kehilangan gambarnya.
 *
 * Gagal itu wajar dan tidak fatal: barang tanpa gambar / gambar yang gagal
 * diunduh cukup DILEWATI (tidak ada foto kosong yang dikirim) — badge nomornya
 * yang menjaga foto tetap bisa dicocokkan ke barang yang benar.
 */

/** Batas lampiran per pesan di Discord. Order dgn barang lebih banyak: sisanya dilewati. */
export const MAX_PHOTOS = 10;

const MAX_SIDE = 512;
const BG = { r: 255, g: 255, b: 255, alpha: 1 };
const FETCH_TIMEOUT_MS = 8_000;

export type ItemPhoto = {
  /** Nomor barang (1-based), sama dgn nomor di daftar "Barang". */
  index: number;
  attachment: AttachmentBuilder;
  /** Nama file, dipakai embed lewat `attachment://<name>`. */
  name: string;
};

async function downloadImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.warn(`[item-photos] gagal unduh ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Badge nomor urut, biar foto cocok dgn baris di daftar barang. */
function badgeSvg(index: number, size: number): Buffer {
  const r = Math.round(size * 0.09);
  const c = r + 8;
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
       <circle cx="${c}" cy="${c}" r="${r}" fill="#d9534f"/>
       <text x="${c}" y="${c}" fill="#ffffff" font-family="DejaVu Sans, Arial, sans-serif"
             font-size="${Math.round(r * 1.15)}" font-weight="bold"
             text-anchor="middle" dominant-baseline="central">${index}</text>
     </svg>`
  );
}

/** Satu foto barang: dikecilkan seperlunya (tidak dipotong) + badge nomor. */
async function buildPhoto(raw: Buffer, index: number): Promise<Buffer> {
  const square = await sharp(raw, { failOn: "none" })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "contain", background: BG })
    .toBuffer();

  return sharp(square)
    .composite([{ input: badgeSvg(index, MAX_SIDE), top: 0, left: 0 }])
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

/**
 * Siapkan foto tiap barang. `imageUrls` sejajar dengan daftar barang: index ke-i
 * = barang ke-(i+1) di embed. Barang tanpa gambar dilewati, tapi NOMOR barang
 * yang lain tidak ikut bergeser.
 *
 * Return [] kalau tidak ada satu pun foto yang berhasil — pemanggil mengirim
 * embed tanpa gambar seperti sebelumnya.
 */
export async function buildItemPhotos(imageUrls: Array<string | undefined>): Promise<ItemPhoto[]> {
  const wanted = imageUrls
    .map((url, i) => ({ url, index: i + 1 }))
    .filter((x): x is { url: string; index: number } => Boolean(x.url))
    .slice(0, MAX_PHOTOS);

  const built = await Promise.all(
    wanted.map(async ({ url, index }): Promise<ItemPhoto | null> => {
      const raw = await downloadImage(url);
      if (!raw) return null;

      try {
        const buffer = await buildPhoto(raw, index);
        const name = `barang-${index}.jpg`;
        return { index, name, attachment: new AttachmentBuilder(buffer, { name }) };
      } catch (err) {
        console.warn(`[item-photos] gagal olah foto barang ${index}:`, err);
        return null;
      }
    })
  );

  return built.filter((photo): photo is ItemPhoto => photo !== null);
}
