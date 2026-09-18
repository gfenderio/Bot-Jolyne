import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecount, recountEmbed, recountMentions } from "./opnameRecountIntake.js";

const body = (extra: Record<string, unknown> = {}) => ({
  sessionId: 3,
  source: "frontera26",
  total: 565,
  counted: 540,
  mismatch: 12,
  unscanned: 25,
  sentBy: "Gilang",
  fileName: "hitung-ulang-frontera26-3.xlsx",
  fileBase64: Buffer.from("PK fake xlsx").toString("base64"),
  people: [
    { name: "Ani", discordId: "111", items: 9 },
    { name: "Budi", discordId: "", items: 3 }
  ],
  ...extra
});

test("parse refuses a request without the Excel", () => {
  assert.equal(parseRecount(body({ fileBase64: "" })), "file Excel wajib dikirim");
  assert.equal(parseRecount(body({ sessionId: 0 })), "sessionId wajib berupa angka");
});

test("people with a Discord id are pinged, the rest named", () => {
  const r = parseRecount(body());
  assert.ok(typeof r !== "string");
  assert.equal(r.source, "FRONTERA26");
  assert.deepEqual(recountMentions(r.people), { text: "<@111> Budi", users: ["111"] });
});

test("embed counts what must be recounted, never the stock", () => {
  const r = parseRecount(body());
  assert.ok(typeof r !== "string");
  const e = recountEmbed(r).toJSON();
  assert.equal(e.title, "Opname FRONTERA26 — 37 barang perlu dihitung ulang");
  assert.match(e.fields?.[3].value ?? "", /Ani — 9 barang/);
  assert.doesNotMatch(JSON.stringify(e), /sistem|stok/i);
});
