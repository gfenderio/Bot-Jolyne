import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The delivery ledger writes to <cwd>/data — move to a temp folder first so the
// tests never touch the bot's real data.
const originalCwd = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "jolyne-proof-replacement-"));
process.chdir(tempDir);

const {
  chunkByBytes,
  dedupeBuffers,
  isReplaceableProofCard,
  parseReplaceMode,
  parseSubmittedAtWib,
  proofCardOrderIds,
  replacementNote,
  replacementWantedIds,
  sweepCutoffMs
} = await import("./proofReplacement.js");
const { markPosted, messageIdsForSubmission } = await import("./proofDelivery.js");

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { force: true, recursive: true });
});

const BOT = "bot-1";

function pickCard(orderValue: string, overrides: { title?: string; footer?: string | null; fields?: { name: string; value: string }[] } = {}) {
  return {
    authorId: BOT,
    content: "",
    embeds: [{
      title: overrides.title ?? "📸 Pick Proof: Order #365269",
      footer: overrides.footer ?? null,
      fields: overrides.fields ?? [
        { name: "Order ID", value: orderValue },
        { name: "Picker", value: "Bening" },
        { name: "Items", value: "1. Barang\n   Order: #365269" }
      ]
    }]
  };
}

test("a regular pick card for the resent order is replaceable, link or plain", () => {
  assert.equal(isReplaceableProofCard(pickCard("[365269](https://kyou.id/admin/orders/365269)"), ["365269"], BOT), true);
  assert.equal(isReplaceableProofCard(pickCard("365269"), ["365269"], BOT), true);
});

test("a combined card that also proves another order is left alone", () => {
  assert.deepEqual(proofCardOrderIds(pickCard("365269, 365270")), ["365269", "365270"]);
  assert.equal(isReplaceableProofCard(pickCard("365269, 365270"), ["365269"], BOT), false);
  assert.equal(isReplaceableProofCard(pickCard("365269, 365270"), ["365269", "365270"], BOT), true);
});

test("cards by someone else, pack proofs and BATAL PICK cards are never replaced", () => {
  assert.equal(isReplaceableProofCard({ ...pickCard("365269"), authorId: "human" }, ["365269"], BOT), false);
  assert.equal(isReplaceableProofCard(pickCard("365269", { title: "📦 Pack Proof: Order #365269" }), ["365269"], BOT), false);
  assert.equal(isReplaceableProofCard(pickCard("365269", { title: "BATAL PICK — Barang" }), ["365269"], BOT), false);
  const withStatus = pickCard("365269", {
    fields: [
      { name: "Order ID", value: "365269" },
      { name: "Status", value: "Diproses ke RESI Fulfillment" },
      { name: "Items", value: "1. Barang" }
    ]
  });
  assert.equal(isReplaceableProofCard(withStatus, ["365269"], BOT), false);
});

test("an e-commerce item card is recognized by its Items field", () => {
  const card = pickCard("260912TXAR1BKE", {
    title: "Aventurine Badge",
    fields: [
      { name: "Order ID", value: "260912TXAR1BKE" },
      { name: "Items", value: "Item: #199356 | Qty: 1 | Source: SS" }
    ]
  });
  assert.equal(isReplaceableProofCard(card, ["260912TXAR1BKE"], BOT), true);
  assert.equal(isReplaceableProofCard(card, ["260912OTHER"], BOT), false);
});

test("the extra-photos message is replaceable only when its order list is complete", () => {
  const extra = { authorId: BOT, content: "📷 Foto tambahan (Order #260912TXAR1BKE)", embeds: [] };
  assert.equal(isReplaceableProofCard(extra, ["260912TXAR1BKE"], BOT), true);
  const summarized = { authorId: BOT, content: "📷 Foto tambahan (Order #7 order (a, b, c, …))", embeds: [] };
  assert.equal(proofCardOrderIds(summarized), null);
  assert.equal(proofCardOrderIds(pickCard("12 order:\n1, 2, 3…")), null);
});

test("a card this same submission already posted is not treated as old", () => {
  const own = pickCard("365269", { footer: "2026-09-14 11:14:31" });
  assert.equal(isReplaceableProofCard(own, ["365269"], BOT, "2026-09-14 11:14:31"), false);
  assert.equal(isReplaceableProofCard(own, ["365269"], BOT, "2026-09-13 09:00:00"), true);
});

// The payload the PDA really sends: orderIds are kyou order ids, the marketplace
// invoice only lives in items[].invoiceNumber (MarkPickViewModel.buildPendingPickProof).
const ecomResendPayload = {
  orderIds: ["347931"],
  items: [
    { orderId: "347931", orderItemId: "900001", itemId: "199356", invoiceNumber: "260912TXAR1BKE", originType: "E-COMMERCE" },
    { orderId: "347931", orderItemId: "900002", itemId: "199357", invoiceNumber: "584653665670366416 BOX MULUS", originType: "E-COMMERCE" }
  ]
};

function ecomItemCard(orderValue: string, createdTimestamp?: number) {
  return {
    ...pickCard(orderValue, {
      title: "Aventurine Badge",
      footer: "2026-09-12 10:00:00",
      fields: [
        { name: "Order ID", value: orderValue },
        { name: "Picker", value: "Bening" },
        { name: "Items", value: "Item: #199356 | Qty: 1 | Source: SS" }
      ]
    }),
    createdTimestamp
  };
}

test("e-com resend: wanted ids hold the kyou order ids and the cleaned invoice numbers", () => {
  assert.deepEqual(
    replacementWantedIds(ecomResendPayload.orderIds, ecomResendPayload.items).sort(),
    ["260912TXAR1BKE", "347931", "584653665670366416"].sort()
  );
  assert.deepEqual(replacementWantedIds(["365269"], undefined), ["365269"]);
  assert.deepEqual(replacementWantedIds("365269", [{ invoice_number: "#260912X" }]), ["365269", "260912X"]);
});

test("e-com resend with the real payload replaces item cards and the extra-photos message", () => {
  const wanted = replacementWantedIds(ecomResendPayload.orderIds, ecomResendPayload.items);
  // Matching against orderIds alone (the old behaviour) misses the item card.
  assert.equal(isReplaceableProofCard(ecomItemCard("260912TXAR1BKE"), ecomResendPayload.orderIds, BOT), false);
  assert.equal(isReplaceableProofCard(ecomItemCard("260912TXAR1BKE"), wanted, BOT), true);
  assert.equal(isReplaceableProofCard(ecomItemCard("584653665670366416"), wanted, BOT), true);
  const extra = { authorId: BOT, content: "📷 Foto tambahan (Order #347931)", embeds: [] };
  assert.equal(isReplaceableProofCard(extra, wanted, BOT), true);
  assert.equal(isReplaceableProofCard(ecomItemCard("260912OTHER"), wanted, BOT), false);
});

test("a description suffix on the card's order field is stripped before matching", () => {
  assert.deepEqual(proofCardOrderIds(ecomItemCard("584653665670366416 BOX MULUS")), ["584653665670366416"]);
  assert.equal(isReplaceableProofCard(ecomItemCard("584653665670366416 BOX MULUS"), ["584653665670366416"], BOT), true);
});

test("submittedAt is read as WIB", () => {
  assert.equal(parseSubmittedAtWib("2026-09-14 11:14:31"), Date.parse("2026-09-14T04:14:31Z"));
  assert.equal(parseSubmittedAtWib("2026-09-14 00:30:00"), Date.parse("2026-09-13T17:30:00Z"));
  assert.equal(parseSubmittedAtWib("14/09/2026 11:14"), null);
  assert.equal(parseSubmittedAtWib("2026-02-31 10:00:00"), null);
  assert.equal(parseSubmittedAtWib(undefined), null);
});

test("sweep cutoff: PDA time when readable, never later than the request start", () => {
  const started = Date.parse("2026-09-14T09:00:00Z");
  assert.equal(sweepCutoffMs("2026-09-14 11:14:31", started), Date.parse("2026-09-14T04:14:31Z"));
  assert.equal(sweepCutoffMs("garbage", started), started);
  // A PDA clock running ahead cannot push the cutoff past the request start.
  assert.equal(sweepCutoffMs("2026-09-15 00:00:00", started), started);
});

test("a stale queued resend does not delete cards newer than itself", () => {
  // R1 "replace" submitted 10:00 WIB, failed and was queued; R2 "append" at 12:00
  // posted a new card. R1 retried at 15:00 must leave R2's card alone.
  const cutoff = sweepCutoffMs("2026-09-14 10:00:00", Date.parse("2026-09-14T08:00:00Z"));
  const original = { ...pickCard("365269"), createdTimestamp: Date.parse("2026-09-14T02:30:00Z") };
  const newerR2 = { ...pickCard("365269", { footer: "2026-09-14 12:00:00" }), createdTimestamp: Date.parse("2026-09-14T05:00:05Z") };
  assert.equal(isReplaceableProofCard(original, ["365269"], BOT, "2026-09-14 10:00:00", cutoff), true);
  assert.equal(isReplaceableProofCard(newerR2, ["365269"], BOT, "2026-09-14 10:00:00", cutoff), false);
  // This submission's own extra-photos message has no footer, only its time keeps it safe.
  const ownExtra = { authorId: BOT, content: "📷 Foto tambahan (Order #365269)", embeds: [], createdTimestamp: Date.parse("2026-09-14T03:00:02Z") };
  assert.equal(isReplaceableProofCard(ownExtra, ["365269"], BOT, "2026-09-14 10:00:00", cutoff), false);
  // Unknown creation time with a cutoff in force: not touched.
  assert.equal(isReplaceableProofCard(pickCard("365269"), ["365269"], BOT, "", cutoff), false);
});

test("attachments are chunked by count and by total bytes", () => {
  const MB = 1024 * 1024;
  const size = (n: number) => n;
  assert.deepEqual(chunkByBytes(Array.from({ length: 23 }, () => 1), size).map((c) => c.length), [10, 10, 3]);
  // Five 7MB photos: three fit under 24MB, the rest go to the next message.
  assert.deepEqual(chunkByBytes([7, 7, 7, 7, 7].map((n) => n * MB), size).map((c) => c.length), [3, 2]);
  // A file bigger than the cap still gets its own message instead of looping forever.
  assert.deepEqual(chunkByBytes([30 * MB, 1], size, 10, 24 * MB).map((c) => c.length), [1, 1]);
  assert.deepEqual(chunkByBytes([], size), []);
});

test("identical photos are kept once", () => {
  const a = Buffer.from("photo-a");
  const unique = dedupeBuffers([a, Buffer.from("photo-a"), Buffer.from("photo-b")]);
  assert.equal(unique.length, 2);
  assert.equal(unique[0].toString(), "photo-a");
});

test("replace mode parsing and the replacement note", () => {
  assert.equal(parseReplaceMode("append"), "append");
  assert.equal(parseReplaceMode("REPLACE"), "replace");
  assert.equal(parseReplaceMode(undefined), null);
  assert.equal(parseReplaceMode("yes"), null);
  assert.match(replacementNote("append", 0, 0), /tidak ketemu/);
  assert.match(replacementNote("append", 2, 3), /3 foto lama ikut/);
  assert.match(replacementNote("replace", 1, 0), /tidak dipakai/);
  assert.match(replacementNote("append", 0, 0, true), /gagal dibaca/);
});

test("message ids of one submission include its derived keys and nothing else", async () => {
  await markPosted("sha:abc", { proofType: "pick_proof", orderIds: ["1"], itemIds: ["1"], channelId: "c", messageId: "m-main" });
  await markPosted("sha:abc#extra0", { proofType: "pick_proof", orderIds: ["1"], itemIds: ["1"], channelId: "c", messageId: "m-extra" });
  await markPosted("sha:abcd#item0", { proofType: "pick_proof", orderIds: ["2"], itemIds: ["2"], channelId: "c", messageId: "m-other" });
  const ids = await messageIdsForSubmission("sha:abc");
  assert.deepEqual([...ids].sort(), ["m-extra", "m-main"]);
  assert.equal((await messageIdsForSubmission(null)).size, 0);
});
