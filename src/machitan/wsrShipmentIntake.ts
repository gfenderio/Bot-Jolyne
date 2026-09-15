import type { IncomingMessage, ServerResponse } from "node:http";
import type { Client } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { laporkanDitutupSekarang, umumkanKirimanSekarang } from "../schedulers/wsr-shipment.js";

/**
 * POST /kakera/wsr-shipment — kabar satu kiriman dari kakera.
 *
 * Badan permintaannya sependek mungkin: `{ "batchId": 12, "event": "created" }`.
 *   - `created` (bawaan, juga kalau `event` tidak ada): kiriman baru dibuat →
 *     umumkan sekarang.
 *   - `closed`: kiriman selesai dipindah atau dibatalkan → laporan penutupan.
 * Isi pesannya dibaca Jolyne sendiri dari database, jadi kakera tidak perlu tahu
 * bentuk pesannya dan tidak ada dua tempat yang harus diubah kalau pesannya berubah.
 *
 * SATU-SATUNYA JALUR (15 Sep 2026). Poller lima menitan sudah dicabut; yang
 * gagal di sini tercatat di log kakera dan diumumkan ulang manual.
 */

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readBody(request: IncomingMessage, maxBytes = 16 * 1024): Promise<string> {
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
  try {
    const parsed = JSON.parse((await readBody(request)) || "{}");
    batchId = Number(parsed.batchId ?? parsed.batch_id ?? 0);
    event = String(parsed.event ?? "created").trim().toLowerCase() || "created";
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

  const hasil =
    event === "closed"
      ? await laporkanDitutupSekarang(client, batchId)
      : await umumkanKirimanSekarang(client, batchId);
  // "sudah-ada" BUKAN kegagalan: kabar yang sama sudah pernah dikirim. Yang
  // dijawab 404 cuma id yang memang tidak ada.
  if (hasil === "tidak-ketemu") {
    sendJson(response, 404, { ok: false, error: `Kiriman #${batchId} tidak ada di wsr_batches` });
    return;
  }
  sendJson(response, 200, { ok: true, status: hasil });
}
