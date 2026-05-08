import assert from "node:assert";
import { test } from "node:test";
import { classifyDelivereePageText } from "./webClassifier.js";
import { assertSafeDelivereeClickText, isForbiddenDelivereeClickText } from "./webSafety.js";

test("Deliveree Web Classifier - detects searching driver states", () => {
  assert.strictEqual(classifyDelivereePageText("Memilih... Tidak ada info Pengemudi").status, "searching_driver");
  assert.strictEqual(classifyDelivereePageText("Mencari pengemudi... Mengonfirmasi 03m50d").status, "searching_driver");
});

test("Deliveree Web Classifier - detects no driver found modal", () => {
  const result = classifyDelivereePageText("Tidak bisa menemukan driver Coba Pesan Kembali Bantuan CS");

  assert.strictEqual(result.status, "no_driver_found");
  assert.strictEqual(result.finalActionVisible, false);
});

test("Deliveree Web Classifier - detects cancelled detail page", () => {
  const result = classifyDelivereePageText("BATAL Segera #19330506 Detail Pemesanan");

  assert.strictEqual(result.status, "cancelled");
});

test("Deliveree Web Classifier - detects booking flow and final action visibility", () => {
  const result = classifyDelivereePageText("1. Rute 2. Layanan 3. Rincian Pesan Pengemudi");

  assert.strictEqual(result.status, "draft_prepared");
  assert.strictEqual(result.finalActionVisible, true);
});

test("Deliveree Web Safety - blocks final order actions", () => {
  assert.strictEqual(isForbiddenDelivereeClickText("Pesan Pengemudi"), true);
  assert.throws(() => assertSafeDelivereeClickText("Simpan"), /Blocked unsafe/);
  assert.doesNotThrow(() => assertSafeDelivereeClickText("Rincian"));
});

