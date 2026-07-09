import { test } from "node:test";
import assert from "node:assert/strict";
import { joinOrderNotes, type OrderNotesLookup } from "./orderNotes.js";

function lookup(entries: Record<string, { adminNotes?: string | null; userNotes?: string | null }>): OrderNotesLookup {
  return {
    authoritative: true,
    byOrderId: new Map(
      Object.entries(entries).map(([id, n]) => [id, { adminNotes: n.adminNotes ?? null, userNotes: n.userNotes ?? null }])
    )
  };
}

test("order tunggal tampil tanpa prefix", () => {
  const found = lookup({ "397177": { userNotes: "Packaging mohon hati-hati." } });
  assert.equal(joinOrderNotes(["397177"], (n) => n.userNotes, found), "Packaging mohon hati-hati.");
});

test("multi-order diberi prefix order id", () => {
  const found = lookup({ "1": { userNotes: "bubble wrap" }, "2": { userNotes: "kirim cepat" } });
  assert.equal(joinOrderNotes(["1", "2"], (n) => n.userNotes, found), "Order #1: bubble wrap\nOrder #2: kirim cepat");
});

test("order tanpa catatan dilewati, bukan bikin baris kosong", () => {
  const found = lookup({ "1": { userNotes: "  " }, "2": { userNotes: "kirim cepat" } });
  assert.equal(joinOrderNotes(["1", "2"], (n) => n.userNotes, found), "Order #2: kirim cepat");
});

test("tidak ada catatan sama sekali -> null", () => {
  const found = lookup({ "1": { adminNotes: "cuma admin" } });
  assert.equal(joinOrderNotes(["1"], (n) => n.userNotes, found), null);
});

test("order id yang tidak ada di lookup tidak bikin crash", () => {
  const found = lookup({ "1": { userNotes: "ada" } });
  assert.equal(joinOrderNotes(["1", "999"], (n) => n.userNotes, found), "Order #1: ada");
});

test("catatan admin dan pembeli diambil dari kolom masing-masing", () => {
  const found = lookup({ "397177": { userNotes: "Req dengan admin WA", adminNotes: "USER SENSITIF" } });
  assert.equal(joinOrderNotes(["397177"], (n) => n.userNotes, found), "Req dengan admin WA");
  assert.equal(joinOrderNotes(["397177"], (n) => n.adminNotes, found), "USER SENSITIF");
});
