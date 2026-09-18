import type { IncomingMessage, ServerResponse } from "node:http";
import { ChannelType, EmbedBuilder, type Client } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { readBody, sendJson } from "./opnameRequestIntake.js";

/**
 * POST /kakera/opname-request-progress — progress of a "request cek fisik".
 *
 * Since 18 Sep 2026 the stores answer on the PDA (Machitan → Cek Fisik), not in
 * the Discord thread. After every answer kakera sends the whole state; Jolyne
 * only reports it: the original request message gets a "Hasil" field (who has
 * checked, who is still pending) and the thread gets one line per new answer.
 * No counts and no photos here: the count is blind, and the numbers live on the
 * Meja Selisih desk in kakera (Gilang, 18 Sep 2026). Nothing here is stored — kakera holds the answers
 * and remembers where the message is, because this bot's store does not survive
 * a redeploy.
 */

export interface ProgressAnswer {
  source: string;
  counted: number;
  by: string;
  at: string;
  photos: string[];
}

export interface RequestProgress {
  requestId: number;
  itemId: number;
  itemName: string;
  status: "open" | "done" | "cancelled";
  channelId: string;
  messageId: string;
  threadId: string;
  answers: ProgressAnswer[];
  pending: string[];
  latest: ProgressAnswer | null;
}

const COLOR_DONE = 0x41b774;
const COLOR_CANCELLED = 0x9a9aa4;

const hhmm = (at: string) => at.slice(11, 16) || at;

function parseAnswer(raw: unknown): ProgressAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, unknown>;
  const source = String(a.source ?? "").trim().toUpperCase();
  const counted = Number(a.counted);
  if (!source || !Number.isFinite(counted)) return null;
  return {
    source,
    counted,
    by: String(a.by ?? "").trim(),
    at: String(a.at ?? "").trim(),
    photos: Array.isArray(a.photos) ? a.photos.map(String).filter((u) => /^https?:\/\//.test(u)) : []
  };
}

export function parseProgress(raw: unknown): RequestProgress | string {
  if (!raw || typeof raw !== "object") return "Body bukan objek JSON";
  const r = raw as Record<string, unknown>;
  const requestId = Number(r.requestId);
  if (!Number.isInteger(requestId) || requestId <= 0) return "requestId wajib berupa angka";
  const channelId = String(r.channelId ?? "").trim();
  const messageId = String(r.messageId ?? "").trim();
  if (!/^\d+$/.test(channelId) || !/^\d+$/.test(messageId)) return "channelId dan messageId wajib diisi";
  const status = r.status === "done" || r.status === "cancelled" ? r.status : "open";
  return {
    requestId,
    itemId: Number(r.itemId) || 0,
    itemName: String(r.itemName ?? "").trim(),
    status,
    channelId,
    messageId,
    threadId: /^\d+$/.test(String(r.threadId ?? "")) ? String(r.threadId) : "",
    answers: (Array.isArray(r.answers) ? r.answers : []).map(parseAnswer).filter((a): a is ProgressAnswer => a !== null),
    pending: Array.isArray(r.pending) ? r.pending.map((s) => String(s).trim().toUpperCase()).filter(Boolean) : [],
    latest: parseAnswer(r.latest)
  };
}

/** The "Hasil" field: answered places first, then the ones still waited for. */
export function progressLines(p: RequestProgress): string {
  const lines = p.answers.map((a) => `✅ **${a.source}** — sudah cek · ${a.by || "?"} ${hhmm(a.at)}`);
  if (p.status === "cancelled") lines.push("🚫 Dibatalkan dari Meja Selisih");
  else lines.push(...p.pending.map((s) => `⏳ **${s}** — belum dicek`));
  return lines.join("\n").slice(0, 1024) || "_belum ada jawaban_";
}

/** The request embed with its "Hasil" field replaced and the colour set by status. */
export function progressEmbed(original: EmbedBuilder, p: RequestProgress): EmbedBuilder {
  const fields = (original.data.fields ?? []).filter((f) => f.name !== "Hasil");
  const e = EmbedBuilder.from(original.data).setFields(...fields, { name: "Hasil", value: progressLines(p) });
  if (p.status === "done") e.setColor(COLOR_DONE).setAuthor({ name: "Cek fisik selesai — semua toko sudah menjawab" });
  if (p.status === "cancelled") e.setColor(COLOR_CANCELLED).setAuthor({ name: "Request cek fisik dibatalkan" });
  return e;
}

export function latestEmbed(a: ProgressAnswer): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(COLOR_DONE)
    .setDescription(`✅ **${a.source}** sudah cek fisik · ${a.by || "?"} · ${hhmm(a.at)}`);
}

export async function handleOpnameRequestProgress(
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
  let p: RequestProgress | string;
  try {
    p = parseProgress(JSON.parse((await readBody(request, 64 * 1024)) || "{}"));
  } catch {
    sendJson(response, 400, { ok: false, error: "Body bukan JSON yang sah" });
    return;
  }
  if (typeof p === "string") {
    sendJson(response, 400, { ok: false, error: p });
    return;
  }

  const channel = await client.channels.fetch(p.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    sendJson(response, 404, { ok: false, error: "Channel request tidak ditemukan" });
    return;
  }
  const message = await channel.messages.fetch(p.messageId).catch(() => null);
  if (!message || !message.embeds[0]) {
    sendJson(response, 404, { ok: false, error: "Pesan request tidak ditemukan" });
    return;
  }
  try {
    await message.edit({ embeds: [progressEmbed(EmbedBuilder.from(message.embeds[0]), p)], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error(`[opname-progress] request ${p.requestId}: gagal edit pesan`, err);
    sendJson(response, 502, { ok: false, error: "Pesan request gagal diperbarui" });
    return;
  }

  if (p.threadId) {
    const thread = await client.channels.fetch(p.threadId).catch(() => null);
    if (thread?.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => undefined);
      if (p.latest) await thread.send({ embeds: [latestEmbed(p.latest)] }).catch((err) => console.error("[opname-progress] thread:", err));
      if (p.status === "done") await thread.send("Semua toko yang diminta sudah menjawab. ✅").catch(() => undefined);
      if (p.status === "cancelled") await thread.send("Request ini dibatalkan dari Meja Selisih.").catch(() => undefined);
    }
  }
  sendJson(response, 200, { ok: true });
}
