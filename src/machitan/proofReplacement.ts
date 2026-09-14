import crypto from "node:crypto";
import type { Message, TextChannel } from "discord.js";

/**
 * Replacing an order's pick proof card when the PDA resends its photos.
 *
 * ── THE PROBLEM ─────────────────────────────────────────────────────────────
 * "Kirim Ulang Foto" on the PDA used to post a second green card next to the
 * first one. Anyone scrolling the channel reads two cards as the item being
 * picked twice.
 *
 * ── WHAT HAPPENS NOW ────────────────────────────────────────────────────────
 * The PDA sends `replaceOrderProof`:
 *   - "append"  — the new card carries the old photos after the new ones.
 *   - "replace" — the new card carries only the new photos.
 * In both modes the new card is posted FIRST and the old cards are deleted only
 * after every post succeeded. A failed post leaves the old card untouched, so a
 * proof can never disappear halfway.
 *
 * ── WHICH CARDS COUNT AS "OLD" ──────────────────────────────────────────────
 * Only pick proof cards posted by this bot, and only when EVERY order on the
 * card is one of the resent orders. A combined card that also proves another
 * order is left alone: deleting it would erase that other order's proof.
 * Pack proofs and BATAL PICK cards are never touched.
 *
 * The cards are found by sweeping the channel's recent history, not from the
 * delivery ledger: the ledger lives in `data/`, which is wiped on every
 * redeploy. A card older than the sweep window is not found; the new card then
 * says so, and nothing is deleted.
 */

export type ReplaceMode = "append" | "replace";

const SWEEP_MAX_MESSAGES = 300;

export function parseReplaceMode(value: unknown): ReplaceMode | null {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "append" || mode === "replace" ? mode : null;
}

/** The parts of a Discord message the matcher reads — kept plain so it can be tested. */
export type ProofCardLike = {
  authorId: string;
  content: string;
  embeds: {
    title?: string | null;
    footer?: string | null;
    fields: { name: string; value: string }[];
  }[];
  /** Discord creation time; cards created at or after the sweep cutoff are never old. */
  createdTimestamp?: number;
};

// Order ID marketplace kadang punya deskripsi nempel di belakang angka
// (mis. "584653665670366416 BOX MULUS"). Pisahkan jadi order id bersih + deskripsi
// supaya tidak ngerusak deteksi channel (tag) & tampil di kolom sendiri.
export function splitOrderDescription(raw: unknown): { orderId: string; description: string | null } {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{6,})\s+(\S.*)$/);
  if (m) return { orderId: m[1], description: m[2].trim() };
  return { orderId: s, description: null };
}

function stripMarkdownLinks(value: string): string {
  return value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}

function cleanOrderId(raw: string): string {
  return splitOrderDescription(stripMarkdownLinks(raw).trim().replace(/^#/, "")).orderId;
}

/**
 * Every id an old card of this resend may carry. Regular cards and the e-com
 * extra-photos message list kyou order ids (body.orderIds), but e-com item
 * cards list the marketplace invoice number (items[].invoiceNumber) instead.
 */
export function replacementWantedIds(orderIds: unknown, items: unknown): string[] {
  const ids = new Set<string>();
  const orderList = Array.isArray(orderIds) ? orderIds : orderIds == null ? [] : [orderIds];
  for (const raw of orderList) {
    const id = cleanOrderId(String(raw ?? ""));
    if (id) ids.add(id);
  }
  if (Array.isArray(items)) {
    for (const item of items) {
      const invoice = (item as any)?.invoiceNumber ?? (item as any)?.invoice_number;
      if (invoice == null) continue;
      const id = cleanOrderId(String(invoice));
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** PDA `submittedAt` ("yyyy-MM-dd HH:mm:ss", PDA local time = WIB) as epoch ms, or null. */
export function parseSubmittedAtWib(value: unknown): number | null {
  const match = String(value ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const utc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(utc);
  // Rejects impossible dates such as 2026-02-31 that Date.UTC silently rolls over.
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return utc - WIB_OFFSET_MS;
}

/**
 * Only cards created before this moment may be deleted as "old".
 *
 * A queued submission can be retried hours later, after a newer resend already
 * replaced the card; without this cutoff the stale retry would delete the newer
 * card. The PDA time is used when readable; either way nothing created after
 * this request started processing is ever touched.
 */
export function sweepCutoffMs(submittedAt: unknown, requestStartedAtMs: number): number {
  const submittedMs = parseSubmittedAtWib(submittedAt);
  return submittedMs == null ? requestStartedAtMs : Math.min(submittedMs, requestStartedAtMs);
}

/** A photo of an old card could not be downloaded (append mode) — old card stays, request fails. */
export class OldPhotoDownloadError extends Error {}

// Discord: at most 10 files per message; keep the message total under ~25MB.
export const DISCORD_MAX_FILES_PER_MESSAGE = 10;
export const DISCORD_MESSAGE_MAX_BYTES = 24 * 1024 * 1024;

/**
 * Groups files into Discord messages by count AND total bytes, keeping order.
 * A single file larger than the byte cap still gets its own message.
 */
export function chunkByBytes<T>(
  items: T[],
  sizeOf: (item: T) => number,
  maxCount = DISCORD_MAX_FILES_PER_MESSAGE,
  maxBytes = DISCORD_MESSAGE_MAX_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && (current.length >= maxCount || currentBytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function splitOrderList(value: string): string[] {
  return stripMarkdownLinks(value)
    .split(/,\s*/)
    .map(cleanOrderId)
    .filter(Boolean);
}

/**
 * The orders an existing card proves, or null when the card is not a pick proof
 * or its order list cannot be read in full. Null means "do not touch".
 */
export function proofCardOrderIds(card: ProofCardLike): string[] | null {
  const embed = card.embeds[0];
  if (embed) {
    const title = embed.title ?? "";
    if (title.startsWith("BATAL PICK") || title.startsWith("📦")) return null;
    // Pack proofs carry a Status field; pick proofs never do.
    if (embed.fields.some((field) => field.name === "Status")) return null;

    const itemsField = embed.fields.find((field) => field.name === "Items");
    const isRegularPickCard = title.startsWith("📸 Pick Proof");
    const isEcommercePickCard = (itemsField?.value ?? "").startsWith("Item: #");
    if (!isRegularPickCard && !isEcommercePickCard) return null;

    const orderField = embed.fields.find((field) => field.name === "Order ID");
    if (!orderField) return null;
    // "12 order:\n…" — the list was cut to fit Discord, so it is not complete.
    if (/\border:/i.test(orderField.value) || orderField.value.includes("…")) return null;

    const ids = splitOrderList(orderField.value);
    return ids.length ? ids : null;
  }

  // The follow-up message that carries e-commerce extra photos.
  const extra = card.content.match(/^📷 Foto tambahan \(Order #(.+)\)$/);
  if (extra) {
    // "7 order (a, b, c, …)" — summarized, not the full list.
    if (/\border \(/i.test(extra[1]) || extra[1].includes("…")) return null;
    const ids = splitOrderList(extra[1]);
    return ids.length ? ids : null;
  }

  return null;
}

/**
 * Whether a card may be replaced by this resend.
 *
 * [ownSubmittedAt] keeps out the cards this same submission already posted on
 * an earlier attempt (they carry it in the footer) — without it a retry would
 * delete the replacement it just made.
 *
 * [createdBeforeMs] (see [sweepCutoffMs]) keeps out every card created after the
 * submission — newer resends, and this submission's own extra-photos message,
 * which has no footer.
 */
export function isReplaceableProofCard(
  card: ProofCardLike,
  orderIds: string[],
  botUserId: string,
  ownSubmittedAt = "",
  createdBeforeMs?: number,
): boolean {
  if (card.authorId !== botUserId) return false;
  if (ownSubmittedAt && card.embeds.some((embed) => embed.footer === ownSubmittedAt)) return false;
  if (createdBeforeMs != null && (card.createdTimestamp == null || card.createdTimestamp >= createdBeforeMs)) {
    return false;
  }

  const ids = proofCardOrderIds(card);
  if (!ids) return false;

  const wanted = new Set(orderIds.map(cleanOrderId));
  return ids.every((id) => wanted.has(id));
}

export async function findReplaceableProofMessages(
  channel: TextChannel,
  orderIds: string[],
  botUserId: string,
  excludeMessageIds: Set<string>,
  ownSubmittedAt: string,
  createdBeforeMs: number,
): Promise<Message[]> {
  const found: Message[] = [];
  let before: string | undefined;
  let read = 0;

  // Discord returns at most 100 messages per request, so the history is read in pages.
  while (read < SWEEP_MAX_MESSAGES) {
    const batch = await channel.messages.fetch({
      limit: Math.min(100, SWEEP_MAX_MESSAGES - read),
      before,
    });
    if (batch.size === 0) break;
    read += batch.size;
    before = batch.last()?.id;

    for (const message of batch.values()) {
      if (excludeMessageIds.has(message.id)) continue;
      const card: ProofCardLike = {
        authorId: message.author.id,
        content: message.content ?? "",
        embeds: message.embeds.map((embed) => ({
          title: embed.title,
          footer: embed.footer?.text ?? null,
          fields: embed.fields,
        })),
        createdTimestamp: message.createdTimestamp,
      };
      if (isReplaceableProofCard(card, orderIds, botUserId, ownSubmittedAt, createdBeforeMs)) {
        found.push(message);
      }
    }
  }

  return found;
}

/** E-commerce posts the same photo on every item card, so identical files are kept once. */
export function dedupeBuffers(buffers: Buffer[]): Buffer[] {
  const seen = new Set<string>();
  const unique: Buffer[] = [];
  for (const buffer of buffers) {
    const hash = crypto.createHash("sha1").update(buffer).digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    unique.push(buffer);
  }
  return unique;
}

/**
 * The photos of the old cards, oldest card first. A photo that fails to
 * download throws: posting the replacement without it and then deleting the old
 * card would lose that photo for good.
 */
export async function downloadProofPhotos(messages: Message[]): Promise<Buffer[]> {
  const ordered = [...messages].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const buffers: Buffer[] = [];

  for (const message of ordered) {
    for (const attachment of message.attachments.values()) {
      const isImage =
        (attachment.contentType ?? "").startsWith("image/") ||
        /\.(jpe?g|png|webp)$/i.test(attachment.name ?? "");
      if (!isImage) continue;

      let response: Response;
      try {
        response = await fetch(attachment.url);
      } catch (err) {
        throw new OldPhotoDownloadError(
          `Foto lama gagal diunduh dari Discord (${err instanceof Error ? err.message : String(err)}). Kartu lama tidak dihapus.`,
        );
      }
      if (!response.ok) {
        throw new OldPhotoDownloadError(`Foto lama gagal diunduh dari Discord (${response.status}). Kartu lama tidak dihapus.`);
      }
      buffers.push(Buffer.from(await response.arrayBuffer()));
    }
  }

  return dedupeBuffers(buffers);
}

/** Text of the "Kiriman Ulang" field on the replacement card. */
export function replacementNote(mode: ReplaceMode, oldCardCount: number, oldPhotoCount: number, sweepFailed = false): string {
  if (sweepFailed) {
    return "Foto dikirim ulang, tapi kartu lamanya tidak ketemu (riwayat channel gagal dibaca) — cek manual supaya tidak terhitung dipick 2x.";
  }
  if (oldCardCount === 0) {
    return "Foto dikirim ulang, tapi kartu lamanya tidak ketemu di channel ini — cek manual supaya tidak terhitung dipick 2x.";
  }
  return mode === "append"
    ? `Foto dikirim ulang, menggantikan kartu lama. ${oldPhotoCount} foto lama ikut di kartu ini.`
    : "Foto dikirim ulang, menggantikan kartu lama. Foto lama tidak dipakai.";
}

/** Returns how many old messages were actually deleted. */
export async function deleteReplacedMessages(messages: Message[]): Promise<number> {
  let deleted = 0;
  for (const message of messages) {
    try {
      await message.delete();
      deleted++;
    } catch (err) {
      // Already deleted by someone, or access lost. The replacement is posted,
      // so this only leaves an extra card behind.
      console.warn(`Kartu bukti lama ${message.id} gagal dihapus:`, err);
    }
  }
  return deleted;
}
