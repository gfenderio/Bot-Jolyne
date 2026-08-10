import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Buku pengiriman menulis ke <cwd>/data — pindah ke folder sementara dulu supaya
// tes tidak menyentuh data bot yang asli.
const originalCwd = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), "jolyne-proof-delivery-"));
process.chdir(tempDir);

const { deriveProofKey, hasProofFor, isPosted, markPosted, markReceived, messageKey } =
  await import("./proofDelivery.js");

after(async () => {
  process.chdir(originalCwd);
  await rm(tempDir, { force: true, recursive: true });
});

const base = {
  proofType: "ecom_physical_pick_proof",
  picker: "Bening Suwarsih",
  submittedAt: "2026-08-09 15:18:47"
};

test("kiriman identik menghasilkan kunci yang sama", () => {
  const first = deriveProofKey({ ...base, orderIds: ["260809UPYA9Y59"], itemIds: ["159150"] });
  const second = deriveProofKey({ ...base, orderIds: ["260809UPYA9Y59"], itemIds: ["159150"] });
  assert.ok(first);
  assert.equal(first, second);
});

test("barang berbeda bukan kiriman yang sama", () => {
  const first = deriveProofKey({ ...base, orderIds: ["260809UPYA9Y59"], itemIds: ["159150"] });
  const second = deriveProofKey({ ...base, orderIds: ["260809UPYA9Y59"], itemIds: ["133760"] });
  assert.notEqual(first, second);
});

test("tanpa identitas stabil, penyaring kembar dimatikan (null)", () => {
  const key = deriveProofKey({
    proofType: "pick_proof",
    picker: "Bening Suwarsih",
    orderIds: ["260809UPYA9Y59"],
    itemIds: ["159150"]
  });
  assert.equal(key, null);
});

test("kiriman ulang dikenali setelah berhasil diposting", async () => {
  const key = messageKey(String(deriveProofKey({ ...base, orderIds: ["A1"], itemIds: ["1"] })), "item0");

  assert.equal(await isPosted(key), false);
  await markPosted(key, { proofType: base.proofType, orderIds: ["A1"], itemIds: ["1"], pairs: ["A1|1"] });
  assert.equal(await isPosted(key), true);
});

test("bukti dicocokkan per pasangan invoice+barang, bukan silang", async () => {
  await markPosted("uji-pasangan", {
    proofType: base.proofType,
    orderIds: ["INV-A", "INV-B"],
    itemIds: ["11", "22"],
    pairs: ["INV-A|11", "INV-B|22"]
  });

  assert.equal(await hasProofFor("INV-A", "11"), true);
  assert.equal(await hasProofFor("INV-B", "22"), true);
  // Pasangan silang tidak pernah ada — kalau ini lolos, barang yang bocor akan
  // dikira sudah ada buktinya.
  assert.equal(await hasProofFor("INV-A", "22"), false);
});

test("baru diterima tapi belum terposting bukan bukti", async () => {
  await markReceived("uji-diterima", {
    proofType: base.proofType,
    orderIds: ["INV-C"],
    itemIds: ["33"],
    pairs: ["INV-C|33"]
  });

  assert.equal(await isPosted("uji-diterima"), false);
  assert.equal(await hasProofFor("INV-C", "33"), false);
});
