import type { IncomingMessage, ServerResponse } from "node:http";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { fetchIncomingStock } from "./wsrIncoming.js";
import { countPrep, getPrep, getPrepLog, setPrep } from "./wsrPrepStore.js";

/**
 * Semua endpoint /machitan/wsr/* — dipakai PDA untuk dua hal yang sengaja TIDAK
 * dititipkan ke hanayo (keputusan 27 Jul):
 *
 *   GET  /machitan/wsr/incoming?source=ALPHA   barang yang belum benar-benar sampai
 *   GET  /machitan/wsr/prep?batch=12           centangan penyiapan satu kiriman
 *   POST /machitan/wsr/prep                    centang / lepas satu barang
 *   GET  /machitan/wsr/prep-count?batches=1,2  jumlah tercentang buat layar daftar
 *
 * Stok tetap dipindah lewat endpoint hanayo yang sudah ada — bot tidak pernah
 * menyentuh stok.
 */

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

/** Body centang kecil (beberapa ratus byte); cap-nya sekadar penahan. */
async function readBody(request: IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Payload terlalu besar.");
  }
  return body;
}

export async function handleWsrRequest(request: IncomingMessage, response: ServerResponse) {
  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    return sendJson(response, 401, { ok: false, error: "Unauthorized" });
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = request.method ?? "GET";

  // Barang yang stoknya sudah tercatat tapi fisiknya belum diterima gudang.
  if (method === "GET" && pathname === "/machitan/wsr/incoming") {
    const source = (url.searchParams.get("source") ?? "").trim();
    if (source === "") return sendJson(response, 422, { ok: false, error: "source wajib diisi." });
    try {
      const items = await fetchIncomingStock(source);
      return sendJson(response, 200, { ok: true, data: { source: source.toUpperCase(), items } });
    } catch (error) {
      // Sengaja 503, bukan 200 dengan daftar kosong: daftar kosong terbaca PDA
      // sebagai "tidak ada yang nyusul" dan barang hantu ikut lolos diam-diam.
      console.error("[wsr-incoming] gagal ambil daftar barang nyusul:", error);
      return sendJson(response, 503, {
        ok: false,
        error: "Daftar barang belum sampai tidak bisa diambil sekarang."
      });
    }
  }

  if (method === "GET" && pathname === "/machitan/wsr/prep") {
    const batchId = Number(url.searchParams.get("batch"));
    if (!Number.isInteger(batchId) || batchId <= 0) {
      return sendJson(response, 422, { ok: false, error: "batch tidak valid." });
    }
    const [marks, log] = await Promise.all([getPrep(batchId), getPrepLog(batchId)]);
    return sendJson(response, 200, { ok: true, data: { batch: batchId, marks, log } });
  }

  if (method === "GET" && pathname === "/machitan/wsr/prep-count") {
    const ids = (url.searchParams.get("batches") ?? "")
      .split(",")
      .map((raw) => Number(raw.trim()))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 100);
    const counts = ids.length === 0 ? {} : await countPrep(ids);
    return sendJson(response, 200, { ok: true, data: { counts } });
  }

  if (method === "POST" && pathname === "/machitan/wsr/prep") {
    let payload: {
      batchId?: number;
      itemId?: string;
      destination?: string;
      checked?: boolean;
      by?: string;
    };
    try {
      payload = JSON.parse(await readBody(request));
    } catch {
      return sendJson(response, 400, { ok: false, error: "Body bukan JSON yang sah." });
    }

    const batchId = Number(payload.batchId);
    const itemId = String(payload.itemId ?? "").trim();
    const destination = String(payload.destination ?? "").trim();
    const by = String(payload.by ?? "").trim();
    if (!Number.isInteger(batchId) || batchId <= 0 || itemId === "" || destination === "") {
      return sendJson(response, 422, { ok: false, error: "batchId, itemId, destination wajib diisi." });
    }
    if (by === "") {
      // Tanpa nama, centangan tidak ada gunanya — seluruh tujuan fitur ini
      // adalah tahu siapa yang mengerjakan.
      return sendJson(response, 422, { ok: false, error: "Nama petugas (by) wajib diisi." });
    }

    const marks = await setPrep({
      batchId,
      itemId,
      destination,
      checked: payload.checked !== false,
      by: by.slice(0, 60)
    });
    return sendJson(response, 200, { ok: true, data: { batch: batchId, marks } });
  }

  return sendJson(response, 404, { ok: false, error: "Not found" });
}
