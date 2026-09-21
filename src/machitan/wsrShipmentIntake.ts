import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { laporkanDitutupSekarang, umumkanKirimanSekarang } from "../schedulers/wsr-shipment.js";
import type { WsrShipmentPayload } from "../services/kakeraRead.js";

/**
 * POST /kakera/wsr-shipment — kabar satu kiriman dari kakera.
 *
 * Badan permintaannya: `{ "batchId": 12, "event": "created", "shipment": {...},
 * "items": [...], "counts": {...} }` (pkg/rotation/jolyne_payload.go).
 *   - `created` (bawaan, juga kalau `event` tidak ada): kiriman baru dibuat →
 *     umumkan sekarang.
 *   - `closed`: kiriman selesai dipindah atau dibatalkan → laporan penutupan.
 * Kakera mengirim DATANYA, bukan pesannya: pesan tetap dirakit di sini, jadi
 * bentuk pesan cuma dijaga di satu tempat. Bot tidak membaca database untuk WSR.
 *
 * SATU-SATUNYA JALUR (15 Sep 2026). Poller lima menitan sudah dicabut; yang
 * gagal di sini tercatat di log kakera dan diumumkan ulang manual.
 */

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readBody(request: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Payload terlalu besar.");
  }
  return body;
}

export async function handleWsrShipmentPush(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  let batchId = 0;
  let event = "created";
  let payload: WsrShipmentPayload | undefined;
  try {
    const parsed = JSON.parse((await readBody(request)) || "{}");
    batchId = Number(parsed.batchId ?? parsed.batch_id ?? 0);
    event = String(parsed.event ?? "created").trim().toLowerCase() || "created";
    if (parsed.shipment && Array.isArray(parsed.items)) payload = parsed as WsrShipmentPayload;
  } catch {
    sendJson(response, 400, { ok: false, error: "Body bukan JSON yang sah" });
    return;
  }
  if (!Number.isInteger(batchId) || batchId <= 0) {
    sendJson(response, 400, { ok: false, error: "batchId wajib berupa angka" });
    return;
  }

  if (event !== "created" && event !== "closed") {
    sendJson(response, 400, { ok: false, error: "event wajib created atau closed" });
    return;
  }

  // Kakera lama cuma mengirim id. Ditolak dengan jelas — bot sudah tidak bisa
  // membaca isinya sendiri, dan diam-diam tidak mengumumkan apa pun lebih buruk.
  if (!payload || Number(payload.shipment.id) !== batchId) {
    sendJson(response, 400, { ok: false, error: "shipment/items wajib ikut (kakera perlu versi terbaru)" });
    return;
  }

  const hasil =
    event === "closed"
      ? await laporkanDitutupSekarang(client, payload)
      : await umumkanKirimanSekarang(client, payload);
  // "sudah-ada" BUKAN kegagalan: kabar yang sama sudah pernah dikirim.
  sendJson(response, 200, { ok: true, status: hasil });
}
