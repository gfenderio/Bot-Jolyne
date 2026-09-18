import assert from "node:assert/strict";
import { test } from "node:test";
import { groupByRack, itemEmbed, parseCrosscheck, rackMessages, summaryEmbed } from "./opnameCrosscheckIntake.js";

const item = (itemId: number, rack: string, mentions: string[] = [], counters: string[] = []) => ({
  itemId,
  name: `Item ${itemId}`,
  itemUrl: `https://team.kyou.id/items/${itemId}`,
  imageUrl: "",
  rack,
  system: 2,
  counted: null,
  counters,
  mentions
});

test("parse refuses an empty list and a bad session", () => {
  assert.equal(parseCrosscheck({ sessionId: 1, source: "X", items: [] }), "items wajib berisi minimal satu barang");
  assert.equal(parseCrosscheck({ sessionId: 0, source: "X", items: [item(1, "A")] }), "sessionId wajib berupa angka");
});

test("parse drops mention ids that are not Discord snowflakes", () => {
  const r = parseCrosscheck({ sessionId: 3, source: "frontera26", items: [{ ...item(1, "a-1"), mentions: ["123", "<@1>", ""] }] });
  assert.ok(typeof r !== "string");
  assert.equal(r.source, "FRONTERA26");
  assert.equal(r.items[0].rack, "A-1");
  assert.deepEqual(r.items[0].mentions, ["123"]);
});

test("racks sort by name with the no-rack group last", () => {
  const groups = groupByRack([item(1, "B-2"), item(2, ""), item(3, "A-1"), item(4, "B-2")]);
  assert.deepEqual(groups.map(([r, l]) => [r, l.length]), [["A-1", 1], ["B-2", 2], ["", 1]]);
});

test("each rack tags its own counters once; long racks split at 10 embeds", () => {
  const items = [
    ...Array.from({ length: 12 }, (_, i) => item(100 + i, "A-1", ["111"], ["Ani"])),
    item(200, "B-2", [], ["Budi"])
  ];
  const msgs = rackMessages(items);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].embeds.length, 10);
  assert.match(msgs[0].content, /Rak A-1\*\* · 12 barang · <@111>/);
  assert.deepEqual(msgs[0].mentions, ["111"]);
  assert.equal(msgs[1].embeds.length, 2);
  assert.deepEqual(msgs[1].mentions, [], "the continuation must not ping again");
  // No Discord id known: the names are written, nobody is pinged.
  assert.match(msgs[2].content, /Rak B-2\*\* · 1 barang · Budi/);
});

test("embeds read like the desk", () => {
  const req = parseCrosscheck({ sessionId: 7, source: "FRONTERA26", total: 812, counted: 790, sentBy: "Gilang", items: [item(1, "A-1")] });
  const capped = parseCrosscheck({ sessionId: 7, source: "SS", missing: 400, items: [item(1, "A-1")] });
  assert.ok(typeof capped !== "string");
  assert.equal(summaryEmbed(capped).toJSON().title, "Opname SS — 400 barang belum ketemu", "the title counts every missing item, not just the ones sent");
  assert.ok(typeof req !== "string");
  const s = summaryEmbed(req).toJSON();
  assert.equal(s.title, "Opname FRONTERA26 — 1 barang belum ketemu");
  assert.equal(s.fields?.[0].value, "790 / 812 barang");
  const e = itemEmbed({ ...item(5, "C-3"), counted: 1, system: 3 }).toJSON();
  assert.match(e.description ?? "", /Rak \*\*C-3\*\* · dihitung 1 · sistem 3/);
});
