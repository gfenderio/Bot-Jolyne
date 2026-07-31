import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, type Client, EmbedBuilder } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { fitImageToLimit, DISCORD_BOT_ATTACHMENT_LIMIT_BYTES } from "./imageFit.js";

// #sns-arrival-works. Bisa dioverride lewat env ARRIVAL_PROOF_CHANNEL_ID.
const ARRIVAL_PROOF_CHANNEL_ID = process.env.ARRIVAL_PROOF_CHANNEL_ID || "1511674279958417449";

// Kanal uji coba. Dipakai hanya kalau pengirim menyertakan `test: true` —
// supaya contoh embed bisa dilihat utuh tanpa mengotori kanal kerja gudang,
// dan tanpa perlu menaruh id kanal di badan permintaan (yang berarti siapa pun
// pemegang token bisa memposting ke kanal mana saja).
const ARRIVAL_PROOF_TEST_CHANNEL_ID = process.env.ARRIVAL_PROOF_TEST_CHANNEL_ID || "1501899831268868106";

class PayloadTooLargeError extends Error {}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readBody(request: IncomingMessage, maxBytes = 40 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new PayloadTooLargeError("Payload terlalu besar.");
  }
  return body;
}

/**
 * POST /machitan/arrival-proof — Foto bukti bongkar barang datang (Arrival) dari
 * kakera. Diteruskan sebagai embed rapih + foto ke channel #sns-arrival-works.
 *
 * Body JSON:
 *   { shippingNo, staff, images: [base64...], itemCount?, notes?, batchName? }
 * Auth: Bearer (MACHITAN_INTAKE_TOKENS), sama dengan intake Machitan lain.
 */
export async function handleArrivalProof(request: IncomingMessage, response: ServerResponse, client: Client<true>) {
  if (request.method !== "POST") return sendJson(response, 405, { ok: false, error: "Method not allowed" });
  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    return sendJson(response, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const body = JSON.parse(await readBody(request));
    const shippingNo = String(body.shippingNo ?? body.shipping_no ?? body.invoice ?? "-").trim();
    const staff = String(body.staff ?? body.by ?? body.picker ?? "-").trim() || "-";
    const notes = body.notes ? String(body.notes).trim() : "";
    const batchName = body.batchName ? String(body.batchName).trim() : "";
    const imagesBase64: string[] = Array.isArray(body.images) ? body.images.map(String).filter(Boolean) : [];
    if (!shippingNo || shippingNo === "-" || imagesBase64.length === 0) {
      return sendJson(response, 400, { ok: false, error: "shippingNo & images wajib" });
    }

    // Resize server-side sampai muat limit bot Discord (~8MB/attachment).
    const buffers = await Promise.all(imagesBase64.map((b64) => fitImageToLimit(Buffer.from(b64, "base64"))));
    for (const buf of buffers) {
      if (buf.length > DISCORD_BOT_ATTACHMENT_LIMIT_BYTES) {
        throw new PayloadTooLargeError("Salah satu foto terlalu besar untuk Discord (maks ~8MB).");
      }
    }

    const uji = body.test === true || body.test === "true";
    const channelId = uji ? ARRIVAL_PROOF_TEST_CHANNEL_ID : ARRIVAL_PROOF_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Tidak bisa kirim ke channel ${channelId}`);
    }

    // SATU lampiran saja, yang tampil di dalam embed. Sisanya sengaja tidak
    // diposting: lampiran berjejer di bawah embed membuat kanal ini tak terbaca
    // sekilas, padahal itu gunanya. Foto yang lain sudah tersimpan di arsip
    // (R2 + warehouse.arrival_photos) untuk penelusuran belakangan.
    const utama = new AttachmentBuilder(buffers[0], { name: "arrival_proof.jpg" });

    // photoCount ikut dikirim kakera (berapa foto yang sebenarnya diunggah) tapi
    // tidak ditampilkan: yang dicari orang di kanal ini isi kirimannya, bukan
    // administrasi fotonya. Angkanya tetap ada di log kakera dan di tabel arsip.

    // Angka rupiah dari kakera dikirim sebagai bilangan bulat; pemformatannya di
    // sini supaya yang membaca di Discord melihat "Rp9.839.654", bukan 9839654.
    const rupiah = (n: unknown) => {
      const v = Number(n);
      return Number.isFinite(v) && v > 0 ? `Rp${v.toLocaleString("id-ID")}` : "";
    };
    const arrivalValue = rupiah(body.totalIdr);

    // Tanggal submit, WIB. Pakai jam server saat pesan dibuat, bukan yang
    // dikirim pengirim: yang dicatat kanal ini adalah kapan laporannya masuk.
    const tanggal = new Date().toLocaleDateString("id-ID", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Jakarta",
    });

    // Koli = kardus fisik, dihitung orang saat bongkar. Kalau ada, jumlah barang
    // ditulis sekalian per koli — itu ukuran yang dipakai gudang untuk menakar
    // seberapa berat kerjaannya, bukan totalnya saja.
    const koli = Number(body.koli);
    const barang = Number(body.itemCount);
    const adaKoli = Number.isFinite(koli) && koli > 0;
    const adaBarang = Number.isFinite(barang) && barang > 0;
    const ipDominan = body.ipDominan ? String(body.ipDominan).trim() : "";

    const embed = new EmbedBuilder()
      .setColor(0xfc4c02)
      .setTitle(`${uji ? "🧪 [UJI COBA] " : "📦 "}Arrival Works — ${tanggal}`.slice(0, 256))
      .addFields(
        // Nomor invoice sengaja tidak ditampilkan: yang membaca kanal ini bukan
        // yang mengurus kiriman JSUB. Nama batch tetap ada karena itu nama yang
        // dipakai orang menyebut kirimannya.
        ...(batchName ? [{ name: "Batch", value: batchName.slice(0, 256), inline: true }] : []),
        { name: "Disubmit oleh", value: staff, inline: true },
        ...(adaKoli ? [{ name: "Koli", value: `${koli.toLocaleString("id-ID")} koli`, inline: true }] : []),
        ...(adaBarang ? [{ name: "Barang", value: `${barang.toLocaleString("id-ID")} barang`, inline: true }] : []),
        ...(arrivalValue ? [{ name: "Arrival value", value: arrivalValue, inline: true }] : []),
        ...(ipDominan ? [{ name: "IP dominant", value: ipDominan.slice(0, 1024), inline: false }] : []),
        ...(notes ? [{ name: "Catatan", value: notes.slice(0, 1024), inline: false }] : []),
      )
      .setImage("attachment://arrival_proof.jpg")
      .setTimestamp();

    await channel.send({ embeds: [embed], files: [utama] });

    return sendJson(response, 200, { ok: true, message: "Bukti bongkar terkirim ke Discord", photos: 1 });
  } catch (error) {
    console.error("Arrival proof intake error:", error);
    if (error instanceof PayloadTooLargeError) return sendJson(response, 413, { ok: false, error: error.message });
    return sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "Internal error" });
  }
}
