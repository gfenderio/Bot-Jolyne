import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, Client, EmbedBuilder } from "discord.js";
import { env } from "../config/env.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { DISCORD_BOT_ATTACHMENT_LIMIT_BYTES, fitImageToLimit } from "./imageFit.js";
import { adminOrderUrl } from "../services/kyouLinks.js";

/**
 * Bukti foto saat paket order pickup toko DITERIMA di toko.
 *
 * PDA memanggil ini setelah POST /pickup/{orderId}/received di hanayo berhasil.
 * Bot hanya memposting bukti ke Discord — status order sepenuhnya urusan hanayo,
 * jadi kegagalan di sini tidak boleh membatalkan penerimaan paket.
 */

export class PayloadTooLargeError extends Error {}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

// Sama seperti pick-proof: multi-foto base64 (+33%) bisa besar; oversize per-foto
// ditangani fitImageToLimit, jadi limit body cukup longgar.
async function readRequestBody(request: IncomingMessage, maxBytes = 40 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new PayloadTooLargeError("Payload terlalu besar.");
    }
  }
  return body;
}

/** Terima base64 mentah maupun data URI ("data:image/jpeg;base64,…"). */
function decodeBase64Image(raw: string): Buffer {
  const cleaned = raw.replace(/^data:[^;]+;base64,/, "");
  return Buffer.from(cleaned, "base64");
}


export async function handleMachitanPickupProof(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>
) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { ok: false, error: "Method not allowed" });
  }

  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    return sendJson(response, 401, { ok: false, error: "Unauthorized" });
  }

  try {
    const body = JSON.parse(await readRequestBody(request));

    const orderId = String(body.orderId ?? "").trim();
    const store = String(body.store ?? "").trim();
    const staff = String(body.staff ?? "").trim();
    if (!orderId || !store || !staff) {
      return sendJson(response, 400, { ok: false, error: "orderId, store, staff wajib diisi" });
    }

    const imagesBase64: string[] = Array.isArray(body.images)
      ? body.images.map(String).filter(Boolean)
      : body.imageBase64
      ? [String(body.imageBase64)]
      : [];

    if (imagesBase64.length === 0) {
      return sendJson(response, 400, { ok: false, error: "Minimal satu foto bukti" });
    }

    const imageBuffers = await Promise.all(
      imagesBase64.map((b64) => fitImageToLimit(decodeBase64Image(b64)))
    );
    for (const buf of imageBuffers) {
      if (buf.length > DISCORD_BOT_ATTACHMENT_LIMIT_BYTES) {
        throw new PayloadTooLargeError("Foto terlalu besar untuk diupload ke Discord (maks ~8MB).");
      }
    }

    const channelId = env.MACHITAN_PICKUP_PROOF_CHANNEL_ID;
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) {
      throw new Error(`Cannot send to channel ${channelId}`);
    }

    const attachments = imageBuffers.map(
      (buf, i) => new AttachmentBuilder(buf, { name: i === 0 ? `pickup_${orderId}.jpg` : `pickup_${orderId}_${i + 1}.jpg` })
    );

    const embed = new EmbedBuilder()
      .setTitle(`📦 Paket Pickup Diterima — Order ${orderId}`)
      .setURL(adminOrderUrl(orderId))
      .setColor(0x2e7d32)
      .addFields(
        { name: "Toko", value: store, inline: true },
        { name: "Diterima oleh", value: staff, inline: true }
      )
      .setImage(`attachment://${attachments[0].name}`)
      .setTimestamp(new Date());

    if (body.customerName) {
      embed.addFields({ name: "Pelanggan", value: String(body.customerName), inline: true });
    }
    if (body.pickupCode) {
      embed.addFields({ name: "Pickup Code", value: String(body.pickupCode), inline: true });
    }
    if (body.itemCount) {
      embed.addFields({ name: "Jumlah item", value: String(body.itemCount), inline: true });
    }
    if (body.notes) {
      embed.addFields({ name: "Catatan", value: String(body.notes).slice(0, 1024) });
    }

    const message = await channel.send({ embeds: [embed], files: attachments });

    return sendJson(response, 200, {
      ok: true,
      channelId,
      messageId: message.id,
      photos: attachments.length
    });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { ok: false, error: error.message });
    }
    console.error("Gagal memproses Machitan pickup-proof", error);
    if (!response.headersSent) {
      return sendJson(response, 500, { ok: false, error: "Internal server error handling pickup proof" });
    }
  }
}
