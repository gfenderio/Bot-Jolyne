import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, type Client, EmbedBuilder } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { fitImageToLimit, DISCORD_BOT_ATTACHMENT_LIMIT_BYTES } from "./imageFit.js";

// #sns-arrival-works. Bisa dioverride lewat env ARRIVAL_PROOF_CHANNEL_ID.
const ARRIVAL_PROOF_CHANNEL_ID = process.env.ARRIVAL_PROOF_CHANNEL_ID || "1511674279958417449";

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

    const channel = await client.channels.fetch(ARRIVAL_PROOF_CHANNEL_ID);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Tidak bisa kirim ke channel ${ARRIVAL_PROOF_CHANNEL_ID}`);
    }

    const attachments = buffers.map(
      (buf, i) => new AttachmentBuilder(buf, { name: i === 0 ? "arrival_proof.jpg" : `arrival_proof_${i + 1}.jpg` }),
    );

    const embed = new EmbedBuilder()
      .setColor(0xfc4c02)
      .setTitle(`📦 Bukti Bongkar — ${shippingNo}`.slice(0, 256))
      .addFields(
        { name: "Invoice", value: shippingNo, inline: true },
        { name: "Dibongkar oleh", value: staff, inline: true },
        { name: "Jumlah foto", value: String(buffers.length), inline: true },
        ...(batchName ? [{ name: "Batch", value: batchName.slice(0, 1024), inline: false }] : []),
        ...(body.itemCount ? [{ name: "Barang", value: `${body.itemCount} item`, inline: true }] : []),
        ...(notes ? [{ name: "Catatan", value: notes.slice(0, 1024), inline: false }] : []),
      )
      .setImage("attachment://arrival_proof.jpg")
      .setTimestamp();

    // Discord maks 10 file/pesan — chunk.
    const chunks: (typeof attachments)[] = [];
    for (let i = 0; i < attachments.length; i += 10) chunks.push(attachments.slice(i, i + 10));
    await channel.send({ embeds: [embed], files: chunks[0] });
    for (let i = 1; i < chunks.length; i++) await channel.send({ files: chunks[i] });

    return sendJson(response, 200, { ok: true, message: "Bukti bongkar terkirim ke Discord", photos: buffers.length });
  } catch (error) {
    console.error("Arrival proof intake error:", error);
    if (error instanceof PayloadTooLargeError) return sendJson(response, 413, { ok: false, error: error.message });
    return sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : "Internal error" });
  }
}
