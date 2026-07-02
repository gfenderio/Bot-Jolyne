import type { IncomingMessage, ServerResponse } from "node:http";
import { addWsInboxProof } from "./wsInboxStore.js";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

class PayloadTooLargeError extends Error {}

// Payload di sini murni JSON metadata (tanpa foto), 5MB udah lebih dari cukup.
async function readRequestBody(request: IncomingMessage, maxBytes = 5 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new PayloadTooLargeError("Payload terlalu besar.");
  }
  return body;
}

export async function handleWsInboxIntake(
  request: IncomingMessage,
  response: ServerResponse,
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
      qtySent: Number(it.qtySent || 0),
      expectedQty: Number(it.expectedQty || 0),
      actualQty: Number(it.actualQty || 0),
      selisih: Number(it.selisih ?? it.delta ?? 0),
      source: it.source ? String(it.source) : undefined,
      rack: it.rack ? String(it.rack) : undefined,
    }));

    const actor = String(body.actor);
    const notes = body.notes ? String(body.notes) : undefined;
    const isPartial = Boolean(body.isPartial);

    await addWsInboxProof({ timestamp: new Date().toISOString(), actor, items, notes, isPartial });

    return sendJson(response, 200, { message: "WS Inbox log saved", ok: true });
  } catch (error) {
    console.error("WS Inbox Intake Error:", error);
    if (error instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { error: error.message, ok: false });
    }
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}
