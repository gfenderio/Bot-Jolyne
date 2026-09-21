import test from "node:test";
import assert from "node:assert/strict";

import { geserMenit } from "../services/splitPrintClickStore.js";

/**
 * Jendela klik dihitung sebagai TEKS jam WIB, bukan lewat zona waktu. Salah di
 * sini tidak kelihatan di layar: jendelanya cuma meleset dan pencocokan klik
 * diam-diam tidak pernah cocok — persis kegagalan tujuh jam yang pernah bikin
 * poller ini tidak menemukan apa pun.
 */
test("geserMenit menggeser jam WIB apa adanya", () => {
  assert.equal(geserMenit("2026-08-06 09:16:23", 15), "2026-08-06 09:31:23");
  assert.equal(geserMenit("2026-08-06 23:55:00", 15), "2026-08-07 00:10:00");
  assert.equal(geserMenit("2026-08-31 23:50:00", 15), "2026-09-01 00:05:00");
  assert.equal(geserMenit("2026-08-06 00:05:00", -15), "2026-08-05 23:50:00");
});

test("geserMenit membiarkan nilai yang tak masuk akal apa adanya", () => {
  assert.equal(geserMenit("", 15), "");
  assert.equal(geserMenit("bukan tanggal", 15), "bukan tanggal");
});

// Tes pencocokan klik di SQL (tanpa klik = tebakan lokasi, klik grup 2 tidak
// mengklaim grup lain, catatan yang diklaim keluar dari jalur tebakan, LEFT
// JOIN) ikut pindah bersama kuerinya ke kakera:
// apps/api/pkg/jolyneread/jolyneread_test.go.
