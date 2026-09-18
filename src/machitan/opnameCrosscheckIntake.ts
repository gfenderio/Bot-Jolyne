import type { IncomingMessage, ServerResponse } from "node:http";
import { EmbedBuilder, type Message, type ThreadChannel } from "discord.js";
import { env } from "../config/env.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { escapeMarkdown, findChannel, readBody, sendJson } from "./opnameRequestIntake.js";

/**
 * POST /kakera/opname-crosscheck — round 2 ("cek silang") of an opname session
 * on team.kyou.id (Gilang, 18 Sep 2026).
 *
 * Round 1 counted a whole warehouse on the PDA and was submitted. kakera sends
 * the items still not found; Jolyne posts one summary in the channel, opens a
 * thread, and lists the items there grouped by rack. Each rack's message tags
 * the people who counted that rack in round 1 (kakera resolves them to Discord
 * ids), so everyone is pinged only for the shelves they walked.
 *
 * The summary is posted before answering kakera; the rack messages follow in
 * the background, because a big event can need a dozen messages and Discord
 * rate-limits them.
 */

export interface CrosscheckItem {
  itemId: number;
  name: string;
  itemUrl: string;
  imageUrl: string;
  rack: string;
  system: number;
  counted: number | null;
  counters: string[];
  mentions: string[];
}

export interface CrosscheckRequest {
  sessionId: number;
  source: string;
  sessionUrl: string;
  startedAt: string;
  sentBy: string;
  total: number;
  counted: number;
  /** All items still missing; `items` carries at most MAX_ITEMS of them. */
  missing: number;
  items: CrosscheckItem[];
}

/** Discord allows 10 embeds per message; more racks than this go to kakera's link. */
const EMBEDS_PER_MESSAGE = 10;
const MAX_ITEMS = 150;

const COLOR_SUMMARY = 0xe5484d; // red: something is missing
const COLOR_ITEM = 0xe0a030; // amber: needs a look

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];

export function parseCrosscheck(raw: unknown): CrosscheckRequest | string {
  if (!raw || typeof raw !== "object") return "Body bukan objek JSON";
  const r = raw as Record<string, unknown>;
  const sessionId = Number(r.sessionId);
  if (!Number.isInteger(sessionId) || sessionId <= 0) return "sessionId wajib berupa angka";
  const source = String(r.source ?? "").trim().toUpperCase();
  if (!source) return "source wajib diisi";
  const items = (Array.isArray(r.items) ? r.items : [])
    .map((x) => x as Record<string, unknown>)
    .map((x) => ({
      itemId: Number(x.itemId),
      name: String(x.name ?? "").trim(),
      itemUrl: String(x.itemUrl ?? "").trim(),
      imageUrl: String(x.imageUrl ?? "").trim(),
      rack: String(x.rack ?? "").trim().toUpperCase(),
      system: Number(x.system) || 0,
      counted: x.counted === null || x.counted === undefined ? null : Number(x.counted),
      counters: strList(x.counters),
      mentions: strList(x.mentions).filter((id) => /^\d+$/.test(id))
    }))
    .filter((x) => Number.isInteger(x.itemId) && x.itemId > 0);
  if (items.length === 0) return "items wajib berisi minimal satu barang";
  return {
    sessionId,
    source,
    sessionUrl: String(r.sessionUrl ?? "").trim(),
    startedAt: String(r.startedAt ?? "").trim(),
    sentBy: String(r.sentBy ?? "").trim(),
    total: Number(r.total) || 0,
    counted: Number(r.counted) || 0,
    missing: Math.max(Number(r.missing) || 0, items.length),
    items
  };
}

/** Items per rack, racks in order, "" (no rack) last. */
export function groupByRack(items: CrosscheckItem[]): [string, CrosscheckItem[]][] {
  const m = new Map<string, CrosscheckItem[]>();
  for (const it of items) {
    const list = m.get(it.rack) ?? [];
    list.push(it);
    m.set(it.rack, list);
  }
  return [...m.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
}

export function summaryEmbed(req: CrosscheckRequest): EmbedBuilder {
  const racks = groupByRack(req.items).length;
  const e = new EmbedBuilder()
    .setColor(COLOR_SUMMARY)
    .setAuthor({ name: "Cek silang opname · Sesi 2" })
    .setTitle(`Opname ${req.source} — ${req.missing} barang belum ketemu`.slice(0, 256))
    .setDescription(
      "Barang di thread ini tidak ketemu saat Sesi 1. Tolong cari lagi di raknya, lalu **scan ulang lewat menu Opname di Machitan**. " +
        "Yang ketemu tercoret sendiri di team.kyou.id — tidak perlu balas satu-satu."
    )
    .addFields(
      { name: "Sudah dihitung", value: `${req.counted} / ${req.total} barang`, inline: true },
      { name: "Belum ketemu", value: `${req.missing} barang · ${racks}${req.missing > req.items.length ? "+" : ""} rak`, inline: true },
      { name: "Dikirim oleh", value: req.sentBy || "-", inline: true }
    )
    .setFooter({ text: `Sesi #${req.sessionId}${req.startedAt ? ` · mulai ${req.startedAt}` : ""}` })
    .setTimestamp(new Date());
  if (req.sessionUrl) e.setURL(req.sessionUrl);
  return e;
}

export function itemEmbed(it: CrosscheckItem): EmbedBuilder {
  const counted =
    it.counted === null ? `belum di-scan · sistem ${it.system}` : `dihitung ${it.counted} · sistem ${it.system}`;
  const e = new EmbedBuilder()
    .setColor(COLOR_ITEM)
    .setTitle(escapeMarkdown(it.name || `Item ${it.itemId}`).slice(0, 256))
    .setDescription(`\`#${it.itemId}\` · Rak **${it.rack || "tanpa rak"}** · ${counted}`);
  if (it.itemUrl) e.setURL(it.itemUrl);
  if (it.imageUrl) e.setThumbnail(it.imageUrl);
  if (it.counters.length) e.setFooter({ text: `Yang hitung rak ini: ${it.counters.join(", ")}`.slice(0, 2048) });
  return e;
}

/** The thread messages: one or more per rack, each with that rack's tags. */
export function rackMessages(items: CrosscheckItem[]): { content: string; mentions: string[]; embeds: EmbedBuilder[] }[] {
  const out: { content: string; mentions: string[]; embeds: EmbedBuilder[] }[] = [];
  for (const [rack, list] of groupByRack(items)) {
    const mentions = [...new Set(list.flatMap((it) => it.mentions))];
    const names = [...new Set(list.flatMap((it) => it.counters))];
    const who = mentions.length
      ? mentions.map((id) => `<@${id}>`).join(" ")
      : names.length
        ? names.join(", ")
        : "_belum ada yang menghitung rak ini_";
    for (let i = 0; i < list.length; i += EMBEDS_PER_MESSAGE) {
      const part = list.slice(i, i + EMBEDS_PER_MESSAGE);
      const head = i === 0 ? `📦 **Rak ${rack || "tanpa rak"}** · ${list.length} barang · ${who}` : `📦 **Rak ${rack || "tanpa rak"}** (lanjutan)`;
      out.push({ content: head, mentions: i === 0 ? mentions : [], embeds: part.map(itemEmbed) });
    }
  }
  return out;
}

async function postRacks(thread: ThreadChannel, req: CrosscheckRequest): Promise<void> {
  const items = req.items.slice(0, MAX_ITEMS);
  for (const m of rackMessages(items)) {
    try {
      await thread.send({ content: m.content, embeds: m.embeds, allowedMentions: { users: m.mentions } });
    } catch (err) {
      console.error(`[opname-crosscheck] sesi ${req.sessionId}: gagal kirim satu pesan rak`, err);
    }
  }
  if (req.missing > items.length) {
    await thread
      .send(`…dan ${req.missing - items.length} barang lagi. Daftar lengkapnya di ${req.sessionUrl || "team.kyou.id"}.`)
      .catch(() => undefined);
  }
}

export async function handleOpnameCrosscheckPush(
  request: IncomingMessage,
  response: ServerResponse,
  client: import("discord.js").Client
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }
  let parsed: CrosscheckRequest | string;
  try {
    parsed = parseCrosscheck(JSON.parse((await readBody(request, 1024 * 1024)) || "{}"));
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
    sendJson(response, 503, { ok: false, error: `Jolyne tidak bisa membuka channel cek silang (${channelKey}) — tambahkan Jolyne ke channel itu.` });
    return;
  }

  let summary: Message;
  try {
    summary = await channel.send({ embeds: [summaryEmbed(req)], allowedMentions: { parse: [] } });
  } catch (err) {
    console.error("[opname-crosscheck] gagal kirim ringkasan:", err);
    sendJson(response, 502, {
      ok: false,
      error: `Jolyne tidak bisa kirim ke #${channel.name} — tambahkan Jolyne ke channel itu (View Channel, Send Messages, Create Public Threads).`
    });
    return;
  }

  let thread: ThreadChannel;
  try {
    thread = await summary.startThread({ name: `Cek silang ${req.source} #${req.sessionId}`.slice(0, 100), autoArchiveDuration: 1440 });
  } catch (err) {
    console.error(`[opname-crosscheck] sesi ${req.sessionId}: gagal membuka thread`, err);
    sendJson(response, 502, { ok: false, error: "Ringkasan terkirim, tapi Jolyne tidak bisa membuka thread (izin Create Public Threads)." });
    return;
  }

  const tagged = new Set(req.items.slice(0, MAX_ITEMS).flatMap((it) => it.mentions)).size;
  sendJson(response, 200, { ok: true, messageId: summary.id, threadId: thread.id, tagged });
  postRacks(thread, req).catch((err) => console.error(`[opname-crosscheck] sesi ${req.sessionId}: kirim rak gagal`, err));
}
