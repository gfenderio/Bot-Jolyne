import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, EmbedBuilder, type Client } from "discord.js";
import { env } from "../config/env.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { findChannel, readBody, sendJson } from "./opnameRequestIntake.js";

/**
 * POST /kakera/opname-recount — phase 2 of an event opname on team.kyou.id
 * (Gilang, 18 Sep 2026).
 *
 * Phase 1 counted the whole event on the PDA and was finished. kakera sends one
 * Excel: who counted something that did not match, and what nobody scanned.
 * Jolyne posts it with a short summary, tags those people so they recount on
 * the PDA, and opens a thread for the follow-ups. No numbers in the message:
 * the recount stays blind, and the sheet itself carries no system stock.
 */

export interface RecountPerson {
  name: string;
  discordId: string;
  items: number;
}

export interface RecountRequest {
  sessionId: number;
  source: string;
  sessionUrl: string;
  sentBy: string;
  total: number;
  counted: number;
  mismatch: number;
  unscanned: number;
  people: RecountPerson[];
  fileName: string;
  file: Buffer;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export function parseRecount(raw: unknown): RecountRequest | string {
  if (!raw || typeof raw !== "object") return "Body bukan objek JSON";
  const r = raw as Record<string, unknown>;
  const sessionId = Number(r.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return "sessionId wajib berupa angka";
  const source = String(r.source ?? "").trim().toUpperCase();
  if (!source) return "source wajib diisi";
  const file = Buffer.from(String(r.fileBase64 ?? ""), "base64");
  if (file.length === 0) return "file Excel wajib dikirim";
  if (file.length > MAX_FILE_BYTES) return "file Excel terlalu besar";
  const people = (Array.isArray(r.people) ? r.people : [])
    .map((p) => p as Record<string, unknown>)
    .map((p) => ({
      name: String(p.name ?? "").trim(),
      discordId: /^\d+$/.test(String(p.discordId ?? "")) ? String(p.discordId) : "",
      items: Number(p.items) || 0
    }))
    .filter((p) => p.name);
  const fileName = String(r.fileName ?? "").trim().replace(/[^\w.-]/g, "_") || `hitung-ulang-${sessionId}.xlsx`;
  return {
    sessionId,
    source,
    sessionUrl: String(r.sessionUrl ?? "").trim(),
    sentBy: String(r.sentBy ?? "").trim(),
    total: Number(r.total) || 0,
    counted: Number(r.counted) || 0,
    mismatch: Number(r.mismatch) || 0,
    unscanned: Number(r.unscanned) || 0,
    people,
    fileName: fileName.endsWith(".xlsx") ? fileName : `${fileName}.xlsx`,
    file
  };
}

/** Tags for people with a Discord id; the rest are named plainly. */
export function recountMentions(people: RecountPerson[]): { text: string; users: string[] } {
  const users = [...new Set(people.map((p) => p.discordId).filter(Boolean))];
  const named = people.filter((p) => !p.discordId).map((p) => p.name);
  const parts = [...users.map((id) => `<@${id}>`), ...named];
  return { text: parts.join(" "), users };
}

export function recountEmbed(req: RecountRequest): EmbedBuilder {
  const who = req.people.map((p) => `• ${p.name} — ${p.items} barang`).join("\n").slice(0, 1024) || "-";
  const e = new EmbedBuilder()
    .setColor(0xe0a030)
    .setAuthor({ name: "Opname event · Fase 2 hitung ulang" })
    .setTitle(`Opname ${req.source} — ${req.mismatch + req.unscanned} barang perlu dihitung ulang`.slice(0, 256))
    .setDescription(
      "Hitungan di Excel ini **tidak cocok** atau **belum di-scan**. Tolong hitung ulang lewat menu **Opname** di Machitan (gudang " +
        `${req.source}). Hasilnya masuk sendiri ke team.kyou.id.`
    )
    .addFields(
      { name: "Tidak cocok", value: `${req.mismatch} barang`, inline: true },
      { name: "Belum di-scan", value: `${req.unscanned} barang`, inline: true },
      { name: "Dikirim oleh", value: req.sentBy || "-", inline: true },
      { name: "Yang hitung ulang", value: who }
    )
    .setFooter({ text: `Sesi #${req.sessionId} · ${req.counted}/${req.total} barang terhitung di fase 1` })
    .setTimestamp(new Date());
  if (req.sessionUrl) e.setURL(req.sessionUrl);
  return e;
}

export async function handleOpnameRecountPush(request: IncomingMessage, response: ServerResponse, client: Client): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }
  let parsed: RecountRequest | string;
  try {
    parsed = parseRecount(JSON.parse((await readBody(request, 12 * 1024 * 1024)) || "{}"));
  } catch {
    sendJson(response, 400, { ok: false, error: "Body bukan JSON yang sah" });
    return;
  }
  if (typeof parsed === "string") {
    sendJson(response, 400, { ok: false, error: parsed });
    return;
  }
  const req = parsed;
  const channelKey = env.OPNAME_CROSSCHECK_CHANNEL || env.OPNAME_REQUEST_CHANNEL;
  const channel = await findChannel(client, channelKey);
  if (!channel) {
    sendJson(response, 503, { ok: false, error: `Jolyne tidak bisa membuka channel opname (${channelKey}) — tambahkan Jolyne ke channel itu.` });
    return;
  }
  const tags = recountMentions(req.people);
  let message;
  try {
    message = await channel.send({
      content: tags.text || undefined,
      embeds: [recountEmbed(req)],
      files: [new AttachmentBuilder(req.file, { name: req.fileName })],
      allowedMentions: { users: tags.users }
    });
  } catch (err) {
    console.error("[opname-recount] gagal kirim:", err);
    sendJson(response, 502, {
      ok: false,
      error: `Jolyne tidak bisa kirim ke #${channel.name} — butuh izin View Channel, Send Messages, Attach Files.`
    });
    return;
  }
  try {
    await message.startThread({ name: `Hitung ulang ${req.source} #${req.sessionId}`.slice(0, 100), autoArchiveDuration: 1440 });
  } catch (err) {
    console.error(`[opname-recount] sesi ${req.sessionId}: gagal membuka thread`, err);
  }
  sendJson(response, 200, { ok: true, messageId: message.id, tagged: tags.users.length });
}
