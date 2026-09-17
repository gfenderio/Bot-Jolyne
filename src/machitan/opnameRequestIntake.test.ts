import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeMarkdown, mentionKeys, opnameRequestEmbed, parseOpnameRequest } from "./opnameRequestIntake.js";

test("tags: stores by role name, Lambda uses Gamma, Sigma by id, other Bekasi warehouses untagged", () => {
  assert.deepEqual(mentionKeys(["BETA", "OMEGA", "SS", "LAMBDA", "GAMMA", "delta", "SIGMA", "ORIPA", "KCC"]), [
    "Team Beta Store",
    "Team Gamma Store",
    "Team Delta Store",
    "715841421466402858"
  ]);
});

test("item names with brackets and stars do not break the link", () => {
  assert.equal(escapeMarkdown("[Set of 10] Haikyu!! *Can* Badge_A"), "\\[Set of 10\\] Haikyu!! \\*Can\\* Badge\\_A");
});

test("parse refuses a request without places", () => {
  assert.equal(parseOpnameRequest({ itemId: 5, sources: [] }), "sources wajib berisi minimal satu tempat");
  assert.equal(parseOpnameRequest({ itemId: 0, sources: ["BETA"] }), "itemId wajib berupa angka");
});

test("request embed: item, aligned stock block, places to check", () => {
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
  assert.equal(field("Stok tercatat"), "```\nALPHA      2\nBETA       1\nALPHA-SUR  1\n```");
  assert.equal(field("Cek di"), "BETA · OMEGA · GAMMA");
  assert.equal(field("Diminta oleh"), "Cindy Wilianto");
});
