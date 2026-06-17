import type { IncomingMessage, ServerResponse } from "node:http";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { addWsInboxProof } from "./wsInboxStore.js";

const WS_CHANNEL_ID = "1501899831268868106";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readRequestBody(request: IncomingMessage, maxBytes = 5 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Payload terlalu besar.");
  }
  return body;
}

export async function handleWsInboxIntake(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>
) {
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed", ok: false });

  if (request.headers.authorization !== "Bearer kyou-machitan-secret-2026") {
    return sendJson(response, 401, { error: "Unauthorized", ok: false });
  }

  try {
    const bodyStr = await readRequestBody(request);
    const body = JSON.parse(bodyStr);

    if (!body.actor || !Array.isArray(body.items)) {
      return sendJson(response, 400, { error: "Missing required fields (actor, items)", ok: false });
    }

    const items = body.items.map((it: any) => ({
      itemId: String(it.itemId || "-"),
      productName: String(it.productName || "Item"),
      expectedQty: Number(it.expectedQty || 0),
      actualQty: Number(it.actualQty || 0),
      delta: Number(it.delta || 0),
    }));

    const actor = String(body.actor);
    const notes = body.notes ? String(body.notes) : undefined;
    const isPartial = Boolean(body.isPartial);

    await addWsInboxProof({ timestamp: new Date().toISOString(), actor, items, notes, isPartial });

    // Send embed to Discord
    sendWsEmbed(client, actor, items, notes, isPartial).catch(e =>
      console.error("[WsInboxIntake] Embed error:", e)
    );

    return sendJson(response, 200, { message: "WS Inbox log saved", ok: true });
  } catch (error) {
    console.error("WS Inbox Intake Error:", error);
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}

async function sendWsEmbed(
  client: Client<true>,
  actor: string,
  items: Array<{ itemId: string; productName: string; expectedQty: number; actualQty: number; delta: number }>,
  notes: string | undefined,
  isPartial: boolean
) {
  const channel = await client.channels.fetch(WS_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const itemLines = items.map(it => {
    const deltaStr = it.delta > 0 ? `+${it.delta}` : String(it.delta);
    const emoji = it.delta === 0 ? "✅" : it.delta > 0 ? "⬆️" : "⬇️";
    return `${emoji} **${it.productName}** (ID: ${it.itemId})\n   Ekspektasi: ${it.expectedQty} → Aktual: ${it.actualQty} (${deltaStr})`;
  }).join("\n");

  const embed = new EmbedBuilder()
    .setColor(isPartial ? 0xFFA726 : 0x43A047)
    .setTitle(`🏭 WS Opname${isPartial ? " (Partial)" : ""} — ${actor}`)
    .setDescription(itemLines || "-")
    .setTimestamp();

  if (notes) embed.addFields({ name: "Catatan", value: notes });

  await (channel as TextChannel).send({ embeds: [embed] });
}
