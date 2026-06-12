import type { IncomingMessage, ServerResponse } from "node:http";
import { addWsInboxProof } from "./wsInboxStore.js";

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

export async function handleWsInboxIntake(
  request: IncomingMessage,
  response: ServerResponse
) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed", ok: false });
  }

  const authHeader = request.headers.authorization;
  if (authHeader !== "Bearer kyou-machitan-secret-2026") {
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

    await addWsInboxProof({
      timestamp: new Date().toISOString(),
      actor: String(body.actor),
      items: items,
      notes: body.notes ? String(body.notes) : undefined,
    });

    return sendJson(response, 200, { message: "WS Inbox log saved to local store", ok: true });
  } catch (error) {
    console.error("WS Inbox Intake Error:", error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}
