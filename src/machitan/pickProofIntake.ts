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

export async function handleMachitanPickProof(
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

    if (!body.orderIds || !body.picker || !body.imageBase64) {
      return sendJson(response, 400, { error: "Missing required fields", ok: false });
    }

    const orderIdsStr = Array.isArray(body.orderIds) ? body.orderIds.join(", ") : String(body.orderIds);
    const picker = String(body.picker);
    const notes = body.notes ? String(body.notes) : "-";
    const imageBase64 = String(body.imageBase64);

    // Convert Base64 back to buffer
    const imageBuffer = Buffer.from(imageBase64, "base64");
    
    // Create Attachment
    const attachment = new AttachmentBuilder(imageBuffer, { name: "pick_proof.jpg" });

    // Create Embed
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle(`📸 Pick Proof: Order #${orderIdsStr}`)
      .addFields(
        { name: "Order ID", value: orderIdsStr, inline: true },
        { name: "Picker", value: picker, inline: true },
        { name: "Notes", value: notes, inline: false }
      )
      .setImage("attachment://pick_proof.jpg")
      .setTimestamp();

    // Use MACHITAN_PICK_PROOF_CHANNEL_ID if configured, otherwise fallback to DELIVEREE_ALERT_CHANNEL_ID
    const targetChannelId = env.MACHITAN_PICK_PROOF_CHANNEL_ID || env.DELIVEREE_ALERT_CHANNEL_ID;
    const channel = await client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Cannot send to channel ${targetChannelId}`);
    }

    await channel.send({
      embeds: [embed],
      files: [attachment]
    });

    sendJson(response, 200, { message: "Photo received and sent to Discord", ok: true });
  } catch (error) {
    console.error("Machitan Pick Proof Intake Error:", error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}
