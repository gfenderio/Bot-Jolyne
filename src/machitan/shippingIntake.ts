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

    if (!body.actor || !body.imageBase64 || !body.orderIds) {
      return sendJson(response, 400, { error: "Missing required fields: actor, imageBase64, orderIds", ok: false });
    }

    const orderIdsArr = Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)];
    const orderCount = orderIdsArr.length;
    const actorName = String(body.actor);
    const notes = body.notes ? String(body.notes) : "-";
    const imageBase64 = String(body.imageBase64);

    const requestedChannelId = body.channelId ?? body.channel_id;
    const targetChannelId = requestedChannelId ? String(requestedChannelId) : "1441739180043669595"; // shipping-today default

    // Decode image
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const imageBuffer = Buffer.from(base64Data, "base64");
    const attachmentName = `shipping-proof-${Date.now()}.jpg`;
    const attachment = new AttachmentBuilder(imageBuffer, { name: attachmentName });

    // Format List of Orders
    const chunkSize = 15;
    const orderChunks = [];
    for (let i = 0; i < orderIdsArr.length; i += chunkSize) {
      orderChunks.push(orderIdsArr.slice(i, i + chunkSize));
    }
    
    let orderDescription = "";
    orderChunks.forEach(chunk => {
      orderDescription += chunk.join("\n") + "\n\n";
    });

    if (orderDescription.length > 2000) {
      orderDescription = orderDescription.slice(0, 1990) + "\n...";
    }

    const embed = new EmbedBuilder()
      .setTitle(`📦 Shipping Out — ${notes !== "-" ? notes : `${orderCount} Orders`}`)
      .setDescription(`**Total:** ${orderCount} Order(s)\n\n**List Order ID:**\n\`\`\`\n${orderDescription.trim()}\n\`\`\``)
      .setColor("#3498db")
      .setImage(`attachment://${attachmentName}`)
      .setFooter({ text: `Shipped by ${actorName}` })
      .setTimestamp(new Date());

    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return sendJson(response, 404, { error: `Channel ${targetChannelId} not found or not a text channel`, ok: false });
    }

    await (channel as import("discord.js").TextChannel).send({
      embeds: [embed],
      files: [attachment]
    });

    return sendJson(response, 200, { message: "Shipping proof sent to Discord", ok: true });

  } catch (err: any) {
    console.error("Error processing shipping payload", err);
    return sendJson(response, 500, { error: err.message || "Internal server error", ok: false });
  }
}
