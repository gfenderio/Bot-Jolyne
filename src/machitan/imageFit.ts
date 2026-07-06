import sharp from "sharp";

// Discord bot API upload limit ~8MB per attachment (beda dari limit user biasa/boosted server).
export const DISCORD_BOT_ATTACHMENT_LIMIT_BYTES = 8 * 1024 * 1024;

// Ladder kualitas/dimensi — HANYA dipakai kalau foto melebihi limit. Foto yang
// sudah muat dikembalikan utuh byte-per-byte (kualitas proof penting untuk tracing).
// Turun kualitas dulu sebelum turun dimensi supaya detail (label resi, barcode)
// bertahan selama mungkin.
const FIT_STEPS: Array<{ quality: number; maxSide?: number }> = [
  { quality: 85 },
  { quality: 75 },
  { quality: 70, maxSide: 2000 },
  { quality: 65, maxSide: 1600 },
  { quality: 60, maxSide: 1280 },
];

/**
 * Pastikan buffer gambar muat di bawah limitBytes. Oversize → re-encode JPEG
 * bertahap sampai muat; kalau semua step masih oversize (praktis mustahil),
 * kembalikan hasil terkecil — caller yang memutuskan mau tetap menolak atau tidak.
 */
export async function fitImageToLimit(
  input: Buffer,
  limitBytes = DISCORD_BOT_ATTACHMENT_LIMIT_BYTES
): Promise<Buffer> {
  if (input.length <= limitBytes) return input;
  let best = input;
  for (const step of FIT_STEPS) {
    let img = sharp(input, { failOn: "none" }).rotate();
    if (step.maxSide) {
      img = img.resize({
        width: step.maxSide,
        height: step.maxSide,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    const out = await img.jpeg({ quality: step.quality, mozjpeg: true }).toBuffer();
    if (out.length <= limitBytes) return out;
    if (out.length < best.length) best = out;
  }
  return best;
}
