import type { IncomingMessage, ServerResponse } from "node:http";
import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { fetchIncomingStock } from "./wsrIncoming.js";
import {
  closureSummaries,
  countPrep,
  getClosure,
  getPrep,
  getPrepLog,
  setClosure,
  setPrep,
  type ClosureItem
} from "./wsrPrepStore.js";

/**
 * Semua endpoint /machitan/wsr/* — dipakai PDA untuk dua hal yang sengaja TIDAK
 * dititipkan ke hanayo (keputusan 27 Jul):
 *
 *   GET  /machitan/wsr/incoming?source=ALPHA   barang yang belum benar-benar sampai
 *   GET  /machitan/wsr/prep?batch=12           centangan + catatan penutupan
 *   POST /machitan/wsr/prep                    centang / lepas satu barang
 *   GET  /machitan/wsr/prep-count?batches=1,2  ringkasan buat layar daftar
 *   POST /machitan/wsr/close                   catatan "yang pindah cuma N, sisanya kenapa"
 *
 * Stok tetap dipindah lewat endpoint hanayo yang sudah ada — bot tidak pernah
 * menyentuh stok. Yang disimpan di sini murni catatan kerja orang.
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

/** Barang yang tidak jadi dikirim, dibersihkan & dibatasi panjangnya. */
function parseClosureItems(raw: unknown, wajibAlasan: boolean): ClosureItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 500).map((row) => {
    const item = (row ?? {}) as Record<string, unknown>;
    return {
      itemId: String(item.itemId ?? "").slice(0, 30),
      name: String(item.name ?? "").slice(0, 200),
      destination: String(item.destination ?? "").toUpperCase().slice(0, 50),
      qty: Number(item.qty ?? 0) || 0,
      reason: wajibAlasan ? String(item.reason ?? "").slice(0, 300) : ""
    };
  });
}

/**
 * Kabar balik ke channel gudang SETIAP kali kiriman selesai dikerjakan
 * (permintaan 28 Jul). Yang menunggu barangnya orang toko: dia harus tahu
 * siapa yang mengerjakan, apa yang jadi dikirim, dan apa yang kurang beserta
 * alasannya — tanpa perlu bertanya ke siapa pun.
 *
 * Dua rasa: lengkap (hijau, sekadar tanda beres) dan tidak lengkap (oranye,
 * memuat daftar barang yang tidak ikut + keterangannya).
 */
async function kabarkanPenutupan(
  client: Client,
  batchId: number,
  by: string,
  moved: ClosureItem[],
  skipped: ClosureItem[]
): Promise<void> {
  const channel = (await client.channels.fetch(env.WSR_SHIPMENT_CHANNEL_ID).catch(() => null)) as TextChannel | null;
  if (!channel?.isTextBased()) return;

  const total = moved.length + skipped.length;
  const pcs = moved.reduce((sum, item) => sum + item.qty, 0);
  const lengkap = skipped.length === 0;

  const daftarKurang = skipped
    .slice(0, 20)
    .map((item) => `• **${item.name || item.itemId}** (${item.qty} pcs → ${item.destination}) — ${item.reason || "tanpa keterangan"}`)
    .join("\n");
  const sisa = skipped.length > 20 ? `\n…dan ${skipped.length - 20} barang lagi.` : "";

  const embed = new EmbedBuilder()
    .setColor(lengkap ? 0x2e7d32 : 0xef6c00)
    .setTitle(
      lengkap
        ? `✅ Kiriman #${batchId} selesai — ${moved.length} barang dikirim`
        : `📦 Kiriman #${batchId} ditutup — ${moved.length} dari ${total} barang dikirim`
    )
    .setDescription(
      `Dikerjakan **${by}**.\n\n` +
        `Stok yang berpindah: **${moved.length} barang · ${pcs} pcs**.\n\n` +
        (lengkap
          ? "Semua barang di kiriman ini sudah dipindah, tidak ada yang tertinggal."
          : `Yang **tidak** ikut dikirim:\n${daftarKurang}${sisa}\n\n` +
            "Barang yang tidak ikut masih di gudang asal — buat kiriman baru dari PDA kalau tetap dibutuhkan.")
    )
    .setTimestamp();

  await channel
    .send({ embeds: [embed] })
    .catch((error) => console.error(`[wsr-close] gagal kirim kabar penutupan #${batchId}:`, error));
}

export async function handleWsrRequest(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client
) {
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
    const [marks, log, closure] = await Promise.all([
      getPrep(batchId),
      getPrepLog(batchId),
      getClosure(batchId)
    ]);
    return sendJson(response, 200, { ok: true, data: { batch: batchId, marks, log, closure } });
  }

  if (method === "GET" && pathname === "/machitan/wsr/prep-count") {
    const ids = (url.searchParams.get("batches") ?? "")
      .split(",")
      .map((raw) => Number(raw.trim()))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 100);
    const [counts, closures] = ids.length === 0
      ? [{}, {}]
      : await Promise.all([countPrep(ids), closureSummaries(ids)]);
    return sendJson(response, 200, { ok: true, data: { counts, closures } });
  }

  // Kiriman ditutup dari PDA: catat apa yang jadi pindah dan apa yang tidak.
  if (method === "POST" && pathname === "/machitan/wsr/close") {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(await readBody(request));
    } catch {
      return sendJson(response, 400, { ok: false, error: "Body bukan JSON yang sah." });
    }

    const batchId = Number(payload.batchId);
    const by = String(payload.by ?? "").trim();
    if (!Number.isInteger(batchId) || batchId <= 0 || by === "") {
      return sendJson(response, 422, { ok: false, error: "batchId & by wajib diisi." });
    }

    const moved = parseClosureItems(payload.moved, false);
    const skipped = parseClosureItems(payload.skipped, true);
    // Barang yang tidak jadi dikirim TANPA keterangan ditolak: seluruh gunanya
    // catatan ini adalah menjawab "kenapa cuma segini".
    const tanpaAlasan = skipped.filter((item) => item.reason.trim() === "");
    if (tanpaAlasan.length > 0) {
      return sendJson(response, 422, {
        ok: false,
        error: `${tanpaAlasan.length} barang yang tidak dikirim belum diberi keterangan.`
      });
    }

    const closure = { by: by.slice(0, 60), at: new Date().toISOString(), moved, skipped };
    await setClosure(batchId, closure);
    // Kabar ke Discord best-effort — catatannya sudah tersimpan, kegagalan kirim
    // pesan tidak boleh membuat PDA mengira penutupannya gagal.
    void kabarkanPenutupan(client, batchId, closure.by, moved, skipped);
    return sendJson(response, 200, { ok: true, data: { batch: batchId, closure } });
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
