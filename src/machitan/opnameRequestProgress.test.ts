import assert from "node:assert/strict";
import { test } from "node:test";
import { EmbedBuilder } from "discord.js";
import { latestEmbed, parseProgress, progressEmbed, progressLines } from "./opnameRequestProgress.js";

const base = { requestId: 12, itemId: 3067, itemName: "Figure", channelId: "111", messageId: "222", threadId: "333" };

test("parse refuses a progress without a message to edit", () => {
  assert.equal(parseProgress({ requestId: 12 }), "channelId dan messageId wajib diisi");
  assert.equal(parseProgress({ ...base, requestId: 0 }), "requestId wajib berupa angka");
});

test("lines: answered first, then pending; cancelled replaces pending", () => {
  const p = parseProgress({
    ...base,
    status: "open",
    answers: [{ source: "beta", counted: 0, by: "Budi", at: "2026-09-18 10:20", photos: ["https://kyoucdn.id/a.jpg"] }],
    pending: ["ALPHA"]
  });
  assert.ok(typeof p !== "string");
  assert.equal(progressLines(p), "✅ **BETA** — 0 unit · Budi 10:20 · 1 foto\n⏳ **ALPHA** — belum dicek");
  assert.equal(progressLines({ ...p, status: "cancelled" }), "✅ **BETA** — 0 unit · Budi 10:20 · 1 foto\n🚫 Dibatalkan dari Meja Selisih");
});

test("embed: one Hasil field, replaced on every update, green when done", () => {
  const original = new EmbedBuilder().setTitle("Figure").addFields({ name: "ID", value: "3067" }, { name: "Hasil", value: "lama" });
  const p = parseProgress({ ...base, status: "done", answers: [{ source: "ALPHA", counted: 2, by: "Ani", at: "2026-09-18 10:25" }] });
  assert.ok(typeof p !== "string");
  const e = progressEmbed(original, p).toJSON();
  assert.deepEqual(e.fields?.map((f) => f.name), ["ID", "Hasil"]);
  assert.equal(e.color, 0x41b774);
  assert.match(e.author?.name ?? "", /selesai/);
});

test("latest answer shows its first photo", () => {
  const e = latestEmbed({ source: "ALPHA", counted: 2, by: "Ani", at: "2026-09-18 10:25", photos: ["https://kyoucdn.id/a.jpg", "https://kyoucdn.id/b.jpg"] }).toJSON();
  assert.equal(e.image?.url, "https://kyoucdn.id/a.jpg");
  assert.match(e.footer?.text ?? "", /\+1 foto/);
});
