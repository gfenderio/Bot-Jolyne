import type { IncomingMessage, ServerResponse } from "node:http";
import { ChannelType, EmbedBuilder, type Client, type Guild, type TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";

/**
 * POST /kakera/opname-request — "request cek fisik & opname" from the
 * Meja Selisih desk on team.kyou.id (Cindy's plan, 17 Sep 2026).
 *
 * kakera decides WHICH places must look (every warehouse except the one the
 * SUR pocket came from) and sends the item with its recorded stock. Jolyne only
 * turns that into one message in the request channel, tags the store role of
 * each place, and opens a thread so the answers stay under the request.
 *
 * Only places that actually HOLD the item are tagged (`tagSources`, decided by
 * kakera). Each place tags its PIC — one person, from OPNAME_REQUEST_PIC — not
 * the whole store role: Cindy asked for the PICs on 18 Sep and the role tag
 * pinged everyone in the store for a count one person does (19 Sep). A place
 * without a PIC falls back to the store role ("Team Alpha Store"), Sigma to
 * OPNAME_REQUEST_MENTION_SIGMA; the rest are listed without a tag.
 */

export interface OpnameRequest {
  itemId: number;
  itemName: string;
  itemUrl: string;
  imageUrl: string;
  stocks: { source: string; units: number }[];
  sources: string[];
  tagSources: string[];
  requestedBy: string;
}

/** Rack → the store panel whose people work it. Lambda is worked from Gamma. */
const STORE_OF: Record<string, string> = {
  ALPHA: "Alpha",
  BETA: "Beta",
  GAMMA: "Gamma",
  LAMBDA: "Gamma",
  DELTA: "Delta"
};

/**
 * Who to tag for these places: a role name or an id, deduplicated, in order.
 * Places with no entry (Omega, SS, OP, ORIPA, KCC) are not tagged.
 */
export function mentionKeys(sources: string[], picSpec: string = env.OPNAME_REQUEST_PIC): string[] {
  const pic = parsePicMap(picSpec);
  const keys = sources
    .map((s) => s.trim().toUpperCase())
    .map((s) =>
      pic[s] ?? (s === "SIGMA" ? env.OPNAME_REQUEST_MENTION_SIGMA.trim() : STORE_OF[s] ? `Team ${STORE_OF[s]} Store` : "")
    )
    .filter(Boolean);
  return [...new Set(keys)];
}

/** "ALPHA=123,SS=456" → { ALPHA: "123", SS: "456" }. Malformed pairs are skipped. */
export function parsePicMap(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of spec.split(",")) {
    const [place, id] = pair.split("=").map((x) => x?.trim() ?? "");
    if (place && id) out[place.toUpperCase()] = id;
  }
  return out;
}

export function parseOpnameRequest(raw: unknown): OpnameRequest | string {
  if (!raw || typeof raw !== "object") return "Body bukan objek JSON";
  const r = raw as Record<string, unknown>;
  const itemId = Number(r.itemId);
  if (!Number.isInteger(itemId) || itemId <= 0) return "itemId wajib berupa angka";
  const sources = Array.isArray(r.sources)
    ? r.sources.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  if (sources.length === 0) return "sources wajib berisi minimal satu tempat";
  const stocks = Array.isArray(r.stocks)
    ? r.stocks
        .map((s) => s as Record<string, unknown>)
        .map((s) => ({ source: String(s.source ?? "").trim().toUpperCase(), units: Number(s.units) }))
        .filter((s) => s.source && Number.isFinite(s.units))
    : [];
  const tagSources = Array.isArray(r.tagSources)
    ? r.tagSources.map((s) => String(s).trim().toUpperCase()).filter(Boolean)
    : [];
  return {
    itemId,
    itemName: String(r.itemName ?? "").trim() || `Item ${itemId}`,
    itemUrl: String(r.itemUrl ?? "").trim(),
    imageUrl: String(r.imageUrl ?? "").trim(),
    stocks,
    sources: [...new Set(sources)],
    tagSources: [...new Set(tagSources)],
    requestedBy: String(r.requestedBy ?? "").trim()
  };
}

/**
 * Item names often start with brackets ("[Set of 10] Haikyu!! ...") and contain
 * * or _, which break a [name](url) link and Discord's bold/italic. Escape them.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\[\]()*_~`|>])/g, "\\$1");
}

/** Amber, the colour of "needs a look" on the desk. */
const REQUEST_COLOR = 0xe0a030;

/**
 * The request as an embed: item on top with its picture, and where to look.
 * Recorded stock is NOT shown (Gilang, 19 Sep 2026): the count is blind, and a
 * number on the message is exactly what a store would copy instead of counting.
 * Tags stay in the message content — Discord does not ping mentions placed
 * inside an embed.
 */
export function opnameRequestEmbed(req: OpnameRequest): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(REQUEST_COLOR)
    .setAuthor({ name: "Request cek fisik & opname" })
    .setTitle(req.itemName.slice(0, 256))
    .setDescription("Tolong cek fisik barang ini di rak, lalu update opname lewat **Machitan**.")
    .addFields(
      { name: "ID", value: String(req.itemId), inline: true },
      { name: "Diminta oleh", value: req.requestedBy || "-", inline: true },
      { name: "Cek di", value: req.sources.join(" · ").slice(0, 1024) }
    )
    .setFooter({ text: "Hitung lewat Machitan, menu Cek Fisik" })
    .setTimestamp(new Date());
  if (req.itemUrl) embed.setURL(req.itemUrl);
  if (req.imageUrl) embed.setThumbnail(req.imageUrl);
  return embed;
}

async function findChannel(client: Client, idOrName: string): Promise<TextChannel | null> {
  const v = idOrName.trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) {
    const ch = await client.channels.fetch(v).catch(() => null);
    return ch && ch.type === ChannelType.GuildText ? (ch as TextChannel) : null;
  }
  const wanted = v.toLowerCase();
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch().catch(() => null);
    const hit = channels?.find((c) => c?.type === ChannelType.GuildText && c.name.toLowerCase() === wanted);
    if (hit) return hit as TextChannel;
  }
  return null;
}

/** Resolve role names / ids into mentions. An id may be a role or a person. */
async function resolveMentions(
  guild: Guild,
  keys: string[]
): Promise<{ text: string[]; roles: string[]; users: string[]; missing: string[] }> {
  if (guild.roles.cache.size === 0) await guild.roles.fetch().catch(() => null);
  const out = { text: [] as string[], roles: [] as string[], users: [] as string[], missing: [] as string[] };
  for (const k of keys) {
    if (/^\d+$/.test(k)) {
      if (guild.roles.cache.has(k)) {
        out.roles.push(k);
        out.text.push(`<@&${k}>`);
      } else {
        out.users.push(k);
        out.text.push(`<@${k}>`);
      }
      continue;
    }
    const role = guild.roles.cache.find((r) => r.name.trim().toLowerCase() === k.toLowerCase());
    if (role) {
      out.roles.push(role.id);
      out.text.push(`<@&${role.id}>`);
    } else {
      out.missing.push(k);
    }
  }
  return out;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readBody(request: IncomingMessage, maxBytes = 32 * 1024): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("Payload terlalu besar.");
  }
  return body;
}

export async function handleOpnameRequestPush(
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

  let parsed: OpnameRequest | string;
  try {
    parsed = parseOpnameRequest(JSON.parse((await readBody(request)) || "{}"));
  } catch {
    sendJson(response, 400, { ok: false, error: "Body bukan JSON yang sah" });
    return;
  }
  if (typeof parsed === "string") {
    sendJson(response, 400, { ok: false, error: parsed });
    return;
  }

  const channel = await findChannel(client, env.OPNAME_REQUEST_CHANNEL);
  if (!channel) {
    sendJson(response, 503, { ok: false, error: `Jolyne tidak bisa membuka channel request opname (${env.OPNAME_REQUEST_CHANNEL}) — tambahkan Jolyne ke channel itu.` });
    return;
  }

  // Omega/SS are never in kakera's tagSources (they are not waited for), but
  // Cindy's PIC list names Agmoe for them — so he is pinged when they are asked.
  const bekasi = parsed.sources.filter((s) => s === "OMEGA" || s === "SS");
  const tags = await resolveMentions(channel.guild, mentionKeys([...parsed.tagSources, ...bekasi]));
  let pesan;
  try {
    pesan = await channel.send({
      content: tags.text.length ? tags.text.join(" ") : undefined,
      embeds: [opnameRequestEmbed(parsed)],
      allowedMentions: { roles: tags.roles, users: tags.users }
    });
  } catch (err) {
    // Usually the bot is not allowed in the channel (Discord 50001 Missing
    // Access). Say so, instead of a bare 500 the desk cannot act on.
    console.error("[opname-request] gagal kirim ke channel:", err);
    sendJson(response, 502, {
      ok: false,
      error: `Jolyne tidak bisa kirim ke #${channel.name} — tambahkan Jolyne ke channel itu (View Channel, Send Messages, Create Public Threads, Mention roles).`
    });
    return;
  }

  try {
    const title = `Opname ${parsed.itemId} ${parsed.itemName}`.slice(0, 100);
    await pesan.startThread({ name: title, autoArchiveDuration: 10080 });
  } catch (err) {
    // The request itself is already posted; a missing thread permission must
    // not turn it into a failure that kakera would report as "not sent".
    console.error(`[opname-request] gagal membuka thread item ${parsed.itemId}:`, err);
  }

  sendJson(response, 200, { ok: true, messageId: pesan.id, tagged: tags.text.length, rolesNotFound: tags.missing });
}
