import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceCandidates, mentionFromRequesters } from "./pickRequesterMention.js";

const KAY = "<@804685637252939788>";
const rows = [
  { invoice: "260526EHW40C4E", itemId: "127271", name: "Evania", discordId: "111" },
  { invoice: "260526EHW40C4E", itemId: "102999", name: "Novira", discordId: "222" },
  { invoice: "260601ABCDEF12", itemId: "5", name: "Belum di roster", discordId: "" }
];

test("item punya peminta sendiri -> peminta itu yang ditag", () => {
  assert.equal(mentionFromRequesters(rows, ["260526EHW40C4E"], "127271", KAY), "<@111>");
});

test("tanpa item (kartu pack) -> semua peminta order itu", () => {
  assert.equal(mentionFromRequesters(rows, ["260526EHW40C4E"], undefined, KAY), "<@111> <@222>");
});

test("item tanpa baris sendiri -> peminta ordernya", () => {
  assert.equal(mentionFromRequesters(rows, ["260526EHW40C4E"], "999", KAY), "<@111> <@222>");
});

test("peminta tanpa Discord id -> admin marketplace", () => {
  assert.equal(mentionFromRequesters(rows, ["260601ABCDEF12"], "5", KAY), KAY);
});

test("order tidak dikenal -> admin marketplace", () => {
  assert.equal(mentionFromRequesters(rows, ["999"], "1", KAY), KAY);
  assert.equal(mentionFromRequesters([], ["999"], "1", ""), "");
});

test("invoice bercatatan di depan dicari utuh", () => {
  assert.deepEqual(invoiceCandidates("BOX MULUS! 26101090QKU3RR"), ["BOX MULUS! 26101090QKU3RR"]);
  const noted = [{ invoice: "BOX MULUS! 26101090QKU3RR", itemId: "1", name: "Rega", discordId: "628815933208657921" }];
  assert.equal(mentionFromRequesters(noted, invoiceCandidates("BOX MULUS! 26101090QKU3RR"), "1", KAY), "<@628815933208657921>");
});

test("invoice bercatatan di belakang: utuh dan nomornya sama-sama dicari", () => {
  assert.deepEqual(invoiceCandidates("#584123456789012345 BOX MULUS"), ["584123456789012345 BOX MULUS", "584123456789012345"]);
});

test("huruf besar-kecil invoice tidak membedakan", () => {
  assert.equal(mentionFromRequesters(rows, ["260526ehw40c4e"], "127271", KAY), "<@111>");
});

test("tanpa nomor order -> tidak dicari", () => {
  assert.deepEqual(invoiceCandidates("-"), []);
  assert.deepEqual(invoiceCandidates(""), []);
});
