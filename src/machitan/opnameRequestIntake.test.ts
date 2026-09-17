import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeMarkdown, mentionKeys, opnameRequestText, parseOpnameRequest } from "./opnameRequestIntake.js";

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

test("message follows Cindy's wording", () => {
  const req = parseOpnameRequest({
    itemId: 101250,
    itemName: "Chongyuan Mini Figure",
    itemUrl: "https://team.kyou.id/items/101250",
    stocks: [
      { source: "alpha", units: 2 },
      { source: "BETA", units: 1 },
      { source: "SS", units: 5 },
      { source: "ALPHA-SUR", units: 1 }
    ],
    sources: ["BETA", "OMEGA", "LAMBDA", "GAMMA", "DELTA"],
    requestedBy: "Cindy Wilianto"
  });
  assert.equal(typeof req, "object");
  const text = opnameRequestText(req as Exclude<typeof req, string>, "<@&1>");
  assert.match(text, /Tolong cek fisik \[Chongyuan Mini Figure\]\(https:\/\/team\.kyou\.id\/items\/101250\) dan update opname via Machitan/);
  assert.match(text, /stok tercatat: ALPHA 2 · BETA 1 · SS 5 · ALPHA-SUR 1/);
  assert.match(text, /Cek di: BETA, OMEGA, LAMBDA, GAMMA, DELTA/);
  assert.match(text, /CC: <@&1>$/);
});
