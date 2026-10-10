import { fetchPickRequesters, hasKakeraReadConfig, type PickRequester } from "../services/kakeraRead.js";
import { splitOrderDescription } from "./proofReplacement.js";

/**
 * Who is tagged on the pick / pack / cancel card of an e-com order (SRV-20,
 * Evania, 10 Oct 2026): the person who made the pick request, not one fixed
 * person per marketplace. When that person is off, whoever filled in and made
 * the request is the one waiting for the item.
 *
 * Falls back to the marketplace person (mentionForEcommerce) when the request
 * is not found, its maker has no Discord id, or kakera does not answer in time:
 * a card that tags the usual admin is better than a card that tags no one.
 */

const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * The invoice numbers to look up for one card. invoice_number is typed by CS and
 * sometimes carries a note: in front ("BOX MULUS! 26101090QKU3RR", kept whole by
 * splitOrderDescription) or behind ("584… BOX MULUS", split off). Both the raw
 * text and the split id are asked, so either way the stored row is found. Pure.
 */
export function invoiceCandidates(raw: string): string[] {
  const whole = String(raw ?? "").trim().replace(/^#/, "");
  if (!whole || whole === "-") return [];
  return [...new Set([whole, splitOrderDescription(whole).orderId].filter(Boolean))];
}

/** Pure: the tag from the requester rows, or the fallback. invoice_number is case-blind in MySQL. */
export function mentionFromRequesters(rows: PickRequester[], invoices: string[], itemId: string | undefined, fallback: string): string {
  const wanted = new Set(invoices.map((v) => v.toLowerCase()));
  const ofOrder = rows.filter((r) => wanted.has(r.invoice.toLowerCase()));
  const wantsItem = itemId && itemId !== "-";
  const ofItem = wantsItem ? ofOrder.filter((r) => r.itemId === itemId) : [];
  // An item without its own request row still belongs to the order: take the
  // order's requesters rather than no one.
  const picked = ofItem.length ? ofItem : ofOrder;
  const ids = [...new Set(picked.map((r) => r.discordId).filter((id) => /^\d+$/.test(id)))];
  return ids.length ? ids.map((id) => `<@${id}>`).join(" ") : fallback;
}

/** rawOrderId = the invoice as the PDA sent it, note included. */
export async function mentionForPickRequest(rawOrderId: string, itemId: string | undefined, fallback: string): Promise<string> {
  const invoices = invoiceCandidates(rawOrderId);
  if (invoices.length === 0 || !hasKakeraReadConfig()) return fallback;
  try {
    const rows = await Promise.race([
      fetchPickRequesters(invoices),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS).unref())
    ]);
    return mentionFromRequesters(rows, invoices, itemId, fallback);
  } catch (err) {
    console.warn(`Peminta pick #${invoices[0]} tidak terbaca, pakai admin marketplace:`, err);
    return fallback;
  }
}
