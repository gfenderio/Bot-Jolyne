import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, Client, EmbedBuilder } from "discord.js";
import { env } from "../config/env.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { fitImageToLimit } from "./imageFit.js";

// Helper for sending JSON response
function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

class PayloadTooLargeError extends Error {}

// Discord bot API upload limit ~8MB per attachment (beda dari limit user biasa/boosted server).
const DISCORD_BOT_ATTACHMENT_LIMIT_BYTES = 8 * 1024 * 1024;

// Shipping bisa bawa banyak foto sekaligus (array `images`, bukan 1 foto per submit
// kayak pick-proof), jadi cap-nya perlu longgar; oversize per-foto ditangani
// fitImageToLimit (resize server-side), bukan ditolak 413.
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

export async function handleMachitanShipping(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>
) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed", ok: false });
  }

  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    return sendJson(response, 401, { error: "Unauthorized", ok: false });
  }

  try {
    const bodyStr = await readRequestBody(request);
    const body = JSON.parse(bodyStr);

    if (!body.actor || !body.orderIds) {
      return sendJson(response, 400, { error: "Missing required fields: actor, orderIds", ok: false });
    }

    // Support both old single imageBase64 and new images[]
    const rawImages: string[] = Array.isArray(body.images)
      ? body.images.map(String)
      : body.imageBase64
      ? [String(body.imageBase64)]
      : [];

    if (rawImages.length === 0) {
      return sendJson(response, 400, { error: "Missing required field: images", ok: false });
    }

    // Discord bot dibatasi ~8MB per attachment. Foto oversize di-resize bertahap
    // server-side (fitImageToLimit) sampai muat, bukan ditolak — foto yang sudah
    // muat lewat utuh tanpa re-encode. 413 tinggal fallback ekstrem.
    const imageBuffers = await Promise.all(
      rawImages.map((b64) =>
        fitImageToLimit(Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ""), "base64"))
      )
    );
    for (const buf of imageBuffers) {
      if (buf.length > DISCORD_BOT_ATTACHMENT_LIMIT_BYTES) {
        throw new PayloadTooLargeError("Salah satu foto terlalu besar untuk diupload ke Discord (maks ~8MB).");
      }
    }

    const orderIdsArr = Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)];
    const orderCount = orderIdsArr.length;
    const actorName = String(body.actor);
    const notes = body.notes ? String(body.notes) : "-";

    const requestedChannelId = body.channelId ?? body.channel_id;
    const targetChannelId = requestedChannelId ? String(requestedChannelId) : "1441739180043669595"; // shipping-today default

    // Decode images
    const attachments = imageBuffers.map((buf, i) =>
      new AttachmentBuilder(buf, { name: `shipping-proof-${i + 1}.jpg` })
    );
    // Format List of Orders
    let orderDescription = orderIdsArr.join("\n");
    if (orderDescription.length > 1900) {
      orderDescription = orderDescription.slice(0, 1890) + "\n...";
    }

    const photoCount = attachments.length;
    const photoLabel = photoCount > 1 ? ` · ${photoCount} foto` : "";

    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return sendJson(response, 404, { error: `Channel ${targetChannelId} not found or not a text channel`, ok: false });
    }

    const ch = channel as import("discord.js").TextChannel;

    // Foto ditata sebagai GALERI, bukan lampiran berserakan.
    //
    // Discord menggabungkan beberapa embed jadi satu kisi gambar kalau embed-nya
    // berbagi `url` yang sama persis — maksimal 4 gambar per kisi. Sebelumnya
    // cuma foto pertama yang masuk embed, sisanya menggantung sebagai lampiran
    // polos di bawahnya, dan foto ke-11 dan seterusnya dikirim sebagai pesan
    // telanjang tanpa keterangan apa pun.
    //
    // `url` ini tidak pernah diklik orang; ia cuma penanda pengelompokan.
    const GALLERY_URL = "https://kyou.id/#shipping-out";
    const PHOTOS_PER_GALLERY = 4;

    const groups: typeof attachments[] = [];
    for (let i = 0; i < attachments.length; i += PHOTOS_PER_GALLERY) {
      groups.push(attachments.slice(i, i + PHOTOS_PER_GALLERY));
    }

    for (let g = 0; g < groups.length; g++) {
      const group = groups[g];
      const isFirst = g === 0;
      const from = g * PHOTOS_PER_GALLERY + 1;
      const to = from + group.length - 1;

      const embeds = group.map((att, i) => {
        const embed = new EmbedBuilder()
          .setURL(GALLERY_URL)
          .setColor("#3498db")
          .setImage(`attachment://${att.name as string}`);

        // Keterangan hanya di embed pertama tiap kisi — kalau ditulis di
        // semuanya, Discord memajangnya berulang di atas tiap gambar.
        if (i === 0) {
          if (isFirst) {
            embed
              .setTitle(`📦 Shipping Out — ${notes !== "-" ? notes : `${orderCount} Order(s)`}${photoLabel}`)
              .setDescription(`**Total:** ${orderCount} Order(s)\n\n**List Order ID:**\n\`\`\`\n${orderDescription}\n\`\`\``)
              .setFooter({ text: `Shipped by ${actorName}` })
              .setTimestamp(new Date());
          } else {
            // Lanjutan tetap diberi judul supaya jelas ini kiriman yang sama,
            // bukan pengiriman lain yang kebetulan menyusul.
            embed.setTitle(`📦 Lanjutan foto ${from}–${to} dari ${photoCount}`);
          }
        }
        return embed;
      });

      await ch.send({ embeds, files: group });
    }

    return sendJson(response, 200, { message: "Shipping proof sent to Discord", ok: true });

  } catch (err: any) {
    console.error("Error processing shipping payload", err);
    if (err instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { error: err.message, ok: false });
    }
    return sendJson(response, 500, { error: err.message || "Internal server error", ok: false });
  }
}
