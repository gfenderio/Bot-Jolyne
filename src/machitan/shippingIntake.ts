import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, Client, EmbedBuilder } from "discord.js";
import { env } from "../config/env.js";

// Helper for sending JSON response
function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readRequestBody(request: IncomingMessage, maxBytes = 5 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("Payload terlalu besar.");
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

  // Very simple auth check
  const authHeader = request.headers.authorization;
  if (authHeader !== "Bearer kyou-machitan-secret-2026") {
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

    const orderIdsArr = Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)];
    const orderCount = orderIdsArr.length;
    const actorName = String(body.actor);
    const notes = body.notes ? String(body.notes) : "-";

    const requestedChannelId = body.channelId ?? body.channel_id;
    const targetChannelId = requestedChannelId ? String(requestedChannelId) : "1441739180043669595"; // shipping-today default

    // Decode images
    const attachments = rawImages.map((b64, i) => {
      const base64Data = b64.replace(/^data:image\/\w+;base64,/, "");
      return new AttachmentBuilder(Buffer.from(base64Data, "base64"), {
        name: `shipping-proof-${i + 1}.jpg`,
      });
    });
    const firstAttachmentName = attachments[0].name as string;

    // Format List of Orders
    let orderDescription = orderIdsArr.join("\n");
    if (orderDescription.length > 1900) {
      orderDescription = orderDescription.slice(0, 1890) + "\n...";
    }

    const photoLabel = rawImages.length > 1 ? ` · ${rawImages.length} foto` : "";
    const embed = new EmbedBuilder()
      .setTitle(`📦 Shipping Out — ${notes !== "-" ? notes : `${orderCount} Order(s)`}${photoLabel}`)
      .setDescription(`**Total:** ${orderCount} Order(s)\n\n**List Order ID:**\n\`\`\`\n${orderDescription}\n\`\`\``)
      .setColor("#3498db")
      .setImage(`attachment://${firstAttachmentName}`)
      .setFooter({ text: `Shipped by ${actorName}` })
      .setTimestamp(new Date());

    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return sendJson(response, 404, { error: `Channel ${targetChannelId} not found or not a text channel`, ok: false });
    }

    const ch = channel as import("discord.js").TextChannel;
    const chunks: (typeof attachments)[] = [];
    for (let i = 0; i < attachments.length; i += 10) {
      chunks.push(attachments.slice(i, i + 10));
    }

    await ch.send({ embeds: [embed], files: chunks[0] });
    for (let i = 1; i < chunks.length; i++) {
      await ch.send({ files: chunks[i] });
    }

    return sendJson(response, 200, { message: "Shipping proof sent to Discord", ok: true });

  } catch (err: any) {
    console.error("Error processing shipping payload", err);
    return sendJson(response, 500, { error: err.message || "Internal server error", ok: false });
  }
}
