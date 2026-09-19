import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeMarkdown, mentionKeys, opnameRequestEmbed, parseOpnameRequest } from "./opnameRequestIntake.js";

test("tags: without PICs, stores by role name, Lambda uses Gamma, Sigma by id, other Bekasi warehouses untagged", () => {
  assert.deepEqual(mentionKeys(["BETA", "OMEGA", "SS", "LAMBDA", "GAMMA", "delta", "SIGMA", "ORIPA", "KCC"], ""), [
    "Team Beta Store",
    "Team Gamma Store",
    "Team Delta Store",
    "715841421466402858"
  ]);
});

test("tags: a place with a PIC tags that person, one tag per person, the rest fall back", () => {
  assert.deepEqual(mentionKeys(["ALPHA", "OMEGA", "SS", "BETA", "ORIPA"], "ALPHA=11, OMEGA=22,SS=22,broken,=9"), [
    "11",
    "22",
    "Team Beta Store"
  ]);
});

test("tags: default PICs cover every store and Omega/SS", () => {
  const keys = mentionKeys(["ALPHA", "BETA", "GAMMA", "DELTA", "LAMBDA", "OMEGA", "SS", "SIGMA"]);
  assert.equal(keys.length, 7);
  assert.ok(keys.every((k) => /^\d+$/.test(k)));
});

test("item names with brackets and stars do not break the link", () => {
  assert.equal(escapeMarkdown("[Set of 10] Haikyu!! *Can* Badge_A"), "\\[Set of 10\\] Haikyu!! \\*Can\\* Badge\\_A");
});

test("parse refuses a request without places", () => {
  assert.equal(parseOpnameRequest({ itemId: 5, sources: [] }), "sources wajib berisi minimal satu tempat");
  assert.equal(parseOpnameRequest({ itemId: 0, sources: ["BETA"] }), "itemId wajib berupa angka");
});

test("request embed: item and places to check, no recorded stock", () => {
  const req = parseOpnameRequest({
    itemId: 101250,
    itemName: "[Set of 10] Chongyuan Mini Figure",
    itemUrl: "https://team.kyou.id/items/101250",
    imageUrl: "https://kyoucdn.id/thumbnail/a.jpg",
    stocks: [
      { source: "alpha", units: 2 },
      { source: "BETA", units: 1 },
      { source: "ALPHA-SUR", units: 1 }
    ],
    sources: ["BETA", "OMEGA", "GAMMA"],
    requestedBy: "Cindy Wilianto"
  });
  assert.equal(typeof req, "object");
  const e = opnameRequestEmbed(req as Exclude<typeof req, string>).toJSON();
  assert.equal(e.title, "[Set of 10] Chongyuan Mini Figure");
  assert.equal(e.url, "https://team.kyou.id/items/101250");
  assert.equal(e.thumbnail?.url, "https://kyoucdn.id/thumbnail/a.jpg");
  const field = (name: string) => e.fields?.find((f) => f.name === name)?.value;
  // Blind count: the recorded stock never reaches the message.
  assert.equal(field("Stok tercatat"), undefined);
  assert.ok(!JSON.stringify(e).includes("ALPHA-SUR"));
  assert.equal(field("Cek di"), "BETA · OMEGA · GAMMA");
  assert.equal(field("Diminta oleh"), "Cindy Wilianto");
});
