import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, type Client, EmbedBuilder, type TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import {
  addManualItem,
  getBatch,
  listBatches,
  lockItem,
  submitItem,
  upsertBatch,
  type AbsenBatch,
  type AbsenItem,
} from "./absenStore.js";
import { generateAbsenExport } from "./absenReport.js";

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

class PayloadTooLargeError extends Error {}

// Batch bisa ~300 item metadata → 10MB lebih dari cukup.
async function readRequestBody(request: IncomingMessage, maxBytes = 10 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new PayloadTooLargeError("Payload terlalu besar.");
  }
  return body;
}

// Ringkas item untuk response ke Machitan (buang field lock internal bila perlu).
function publicItem(it: AbsenItem) {
  return it;
}

/**
 * Dispatcher semua endpoint /machitan/absen/*.
 * Dipanggil dari httpServer setelah pathname.startsWith("/machitan/absen").
 */
export async function handleAbsenRequest(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>,
) {
  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    return sendJson(response, 401, { ok: false, error: "Unauthorized" });
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  const nowIso = new Date().toISOString();

  try {
    // GET /machitan/absen/batches
    if (method === "GET" && pathname === "/machitan/absen/batches") {
      const batches = await listBatches();
      return sendJson(response, 200, { ok: true, data: batches });
    }

    // GET /machitan/absen/batch/:id?q=
    if (method === "GET" && pathname.startsWith("/machitan/absen/batch/")) {
      const id = decodeURIComponent(pathname.slice("/machitan/absen/batch/".length));
      const batch = await getBatch(id);
      if (!batch) return sendJson(response, 404, { ok: false, error: "Batch tidak ditemukan." });
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      let items = batch.items;
      if (q) {
        items = items.filter(
          (it) =>
            it.barcode.toLowerCase().includes(q) ||
            it.itemId.toLowerCase().includes(q) ||
            it.name.toLowerCase().includes(q),
        );
      }
      return sendJson(response, 200, {
        ok: true,
        data: { ...batch, items: items.map(publicItem) },
      });
    }

    // POST /machitan/absen/intake
    if (method === "POST" && pathname === "/machitan/absen/intake") {
      const body = JSON.parse(await readRequestBody(request));
      const batchName = String(body.batchName || "").trim();
      const dateStr = String(body.dateStr || "").trim();
      if (!batchName || !Array.isArray(body.items)) {
        return sendJson(response, 400, { ok: false, error: "Wajib ada batchName & items[]." });
      }
      const summary = await upsertBatch(batchName, dateStr, body.items, nowIso);
      return sendJson(response, 200, { ok: true, message: "Batch tersimpan.", data: summary });
    }

    // POST /machitan/absen/submit
    if (method === "POST" && pathname === "/machitan/absen/submit") {
      const body = JSON.parse(await readRequestBody(request));
      const batchId = String(body.batchId || "").trim();
      const key = String(body.barcode || body.itemId || "").trim();
      if (!batchId || !key) {
        return sendJson(response, 400, { ok: false, error: "Wajib ada batchId & barcode/itemId." });
      }
      const item = await submitItem(
        batchId,
        key,
        { qtyDatang: Number(body.qtyDatang || 0), note: body.note, actor: body.actor },
        nowIso,
      );
      if (!item) return sendJson(response, 404, { ok: false, error: "Item/batch tidak ditemukan." });
      return sendJson(response, 200, { ok: true, message: "Absen tersimpan.", data: publicItem(item) });
    }

    // POST /machitan/absen/manual-add
    if (method === "POST" && pathname === "/machitan/absen/manual-add") {
      const body = JSON.parse(await readRequestBody(request));
      const batchId = String(body.batchId || "").trim();
      if (!batchId) return sendJson(response, 400, { ok: false, error: "Wajib ada batchId." });
      const item = await addManualItem(
        batchId,
        {
          barcode: body.barcode,
          itemId: body.itemId,
          name: body.name,
          qtyDatang: Number(body.qtyDatang || 0),
          note: body.note,
          actor: body.actor,
          cogs: body.cogs,
          readyPrice: body.readyPrice,
          status: body.status,
          alloc: body.alloc,
        },
        nowIso,
      );
      if (!item) return sendJson(response, 404, { ok: false, error: "Batch tidak ditemukan." });
      return sendJson(response, 200, { ok: true, message: "Item manual ditambahkan.", data: publicItem(item) });
    }

    // POST /machitan/absen/lock  { batchId, barcode|itemId, actor, action }
    if (method === "POST" && pathname === "/machitan/absen/lock") {
      const body = JSON.parse(await readRequestBody(request));
      const batchId = String(body.batchId || "").trim();
      const key = String(body.barcode || body.itemId || "").trim();
      const actor = String(body.actor || "").trim();
      const action = body.action === "unlock" ? "unlock" : "lock";
      if (!batchId || !key || !actor) {
        return sendJson(response, 400, { ok: false, error: "Wajib ada batchId, barcode/itemId, actor." });
      }
      const res = await lockItem(batchId, key, actor, action, nowIso);
      if (!res) return sendJson(response, 404, { ok: false, error: "Item/batch tidak ditemukan." });
      return sendJson(response, res.ok ? 200 : 409, { ok: res.ok, data: res });
    }

    // POST /machitan/absen/export/:id
    if (method === "POST" && pathname.startsWith("/machitan/absen/export/")) {
      const id = decodeURIComponent(pathname.slice("/machitan/absen/export/".length));
      const batch = await getBatch(id);
      if (!batch) return sendJson(response, 404, { ok: false, error: "Batch tidak ditemukan." });
      const result = await sendAbsenExportToDiscord(client, batch);
      if (!result.ok) return sendJson(response, 500, { ok: false, error: result.error });
      return sendJson(response, 200, {
        ok: true,
        message: "Export terkirim ke Discord.",
        data: {
          resRows: result.resRows,
          convRows: result.convRows,
          manualRows: result.manualRows,
          ledgerRows: result.ledgerRows,
          ledgerQty: result.ledgerQty,
          skipped: result.skipped,
          convWithOp: result.convWithOp,
        },
      });
    }

    return sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error("Absen Arrival Error:", error);
    if (error instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { ok: false, error: error.message });
    }
    return sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "Internal Server Error",
    });
  }
}

async function sendAbsenExportToDiscord(client: Client<true>, batch: AbsenBatch) {
  const exp = await generateAbsenExport(batch);
  const channel = await client.channels.fetch(env.MACHITAN_ABSEN_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) {
    return { ok: false as const, error: "Channel Discord tidak ditemukan / bukan text channel." };
  }

  const safe = batch.dateStr || batch.id;
  const files = [
    new AttachmentBuilder(exp.resBuffer, { name: `RES ${safe}.xlsx` }),
    new AttachmentBuilder(exp.convBuffer, { name: `CONV ${safe}.xlsx` }),
  ];
  if (exp.manualBuffer) {
    files.push(new AttachmentBuilder(exp.manualBuffer, { name: `MANUAL ${safe}.xlsx` }));
  }
  if (exp.ledgerBuffer) {
    files.push(new AttachmentBuilder(exp.ledgerBuffer, { name: `LEDGER ${safe}.xlsx` }));
  }

  // Apa pun yang tidak masuk RES/CONV WAJIB dilaporkan — jangan sampai
  // export terlihat "lengkap" padahal ada item yang diam-diam tidak ikut.
  const skippedText = exp.skipped.length
    ? `\n⏭️ **Tidak diekspor (ACTION bukan Cont/Conv):** ${exp.skipped.length} item — ` +
      exp.skipped.slice(0, 5).map((s) => `\`${s.itemId}\` (${s.action || "kosong"})`).join(", ") +
      (exp.skipped.length > 5 ? `, +${exp.skipped.length - 5} lagi` : "")
    : "";
  const ledgerText = exp.ledgerRows
    ? `\n📒 **Ledger:** ${exp.ledgerRows} item (${exp.ledgerQty} pcs) — porsi ledger/PO, tak masuk RES/CONV. Lihat file LEDGER.`
    : "";
  const opWarn = exp.convWithOp.length
    ? `\n🚨 **ANOMALI:** ${exp.convWithOp.length} item CONV punya alokasi OP ` +
      `(${exp.convWithOp.slice(0, 5).map((s) => `\`${s.itemId}\`=${s.op}`).join(", ")}) — ` +
      `template CONV tak punya kolom OP, qty OP-nya TIDAK ikut. Tangani manual.`
    : "";

  const embed = new EmbedBuilder()
    .setColor(exp.convWithOp.length > 0 ? 0xd32f2f : 0x0277bd)
    .setTitle(`Absen Arrival — ${batch.batchName}`)
    .setDescription(
      `📦 **RES (restock):** ${exp.resRows} baris\n` +
        `🔄 **CONV (convert):** ${exp.convRows} baris\n` +
        (exp.manualRows > 0
          ? `⚠️ **Manual (tak ada di data):** ${exp.manualRows} item — cek file MANUAL, tangani manual.\n`
          : "") +
        ledgerText +
        skippedText +
        opWarn +
        `\n\n*File RES & CONV siap copy-paste ke jurnal.*`,
    )
    .setFooter({ text: `Batch: ${batch.batchName} • ${safe}` })
    .setTimestamp();

  await (channel as TextChannel).send({ embeds: [embed], files });
  return {
    ok: true as const,
    resRows: exp.resRows,
    convRows: exp.convRows,
    manualRows: exp.manualRows,
    ledgerRows: exp.ledgerRows,
    ledgerQty: exp.ledgerQty,
    skipped: exp.skipped.length,
    convWithOp: exp.convWithOp.length,
  };
}
