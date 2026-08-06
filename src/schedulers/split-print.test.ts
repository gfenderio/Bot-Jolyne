import test from "node:test";
import assert from "node:assert/strict";

import { diklaimSiapaPun, diklaimGrupIni, sudahDicetakGudangIni } from "./split-print.js";
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

/**
 * TANPA KLIK, PERILAKUNYA HARUS PERSIS SEPERTI SEBELUMNYA. Ini pagar yang
 * paling penting di berkas ini: kalau store kliknya hilang saat redeploy —
 * dan memang bisa, storenya bukan volume — fitur lama harus tetap jalan utuh,
 * bukan mendadak membungkam atau membanjiri semua gudang.
 */
test("tanpa klik: klaim selalu salah, jadi yang tersisa cuma tebakan lokasi", () => {
  assert.equal(diklaimSiapaPun([]), "FALSE");
  assert.equal(diklaimGrupIni([], "s.pack_group_id"), "FALSE");

  const sql = sudahDicetakGudangIni("s.pack_group_id", []);
  assert.match(sql, /FALSE\s*\n?\s*OR \(NOT FALSE AND psrc\.pack_group_id = s\.pack_group_id\)/);
});

const KLIK = [{ orderId: "404139", packGroupId: 2, at: "2026-08-06 09:16:23" }];

test("klik menutup jendela pada order & jam yang benar", () => {
  const sql = diklaimSiapaPun(KLIK);
  assert.match(sql, /alp\.order_id = 404139/);
  assert.match(sql, /alp\.created_at >= '2026-08-06 09:16:23'/);
  assert.match(sql, /alp\.created_at <= '2026-08-06 09:31:23'/);
});

/**
 * Inti perbaikannya: klik untuk grup 2 tidak boleh ikut menandai grup 1
 * "sudah dicetak". Kasus nyatanya — orang Bekasi membuka tautan Tangerang —
 * dulu membungkam Bekasi, dan labelnya bisa tidak pernah keluar.
 */
test("klik grup 2 tidak mengklaim grup lain", () => {
  const sql = diklaimGrupIni(KLIK, "s.pack_group_id");
  assert.match(sql, /s\.pack_group_id = 2 AND/);
  assert.doesNotMatch(sql, /pack_group_id = 1/);
});

/**
 * Catatan yang sudah diklaim klik TIDAK boleh ikut ditebak lagi dari lokasi
 * pencetaknya. Kalau dua-duanya jalan, tebakannya tetap membungkam gudang yang
 * salah dan seluruh perbaikan ini tidak ada gunanya.
 */
test("catatan yang diklaim klik dikeluarkan dari jalur tebakan", () => {
  const sql = sudahDicetakGudangIni("s.pack_group_id", KLIK);
  assert.match(sql, /OR \(NOT \(\(alp\.order_id = 404139/);
  assert.match(sql, /AND psrc\.pack_group_id = s\.pack_group_id\)/);
});

/**
 * Join ke users/item_sources harus LEFT: catatan yang diklaim klik tetap
 * terhitung meskipun pencetaknya termasuk 19 admin yang tidak punya lokasi
 * kerja — dan justru merekalah yang paling butuh pencocokan ini.
 */
test("pencetak tanpa lokasi tidak menggugurkan barisnya", () => {
  const sql = sudahDicetakGudangIni("s.pack_group_id", KLIK);
  assert.match(sql, /LEFT JOIN users pu/);
  assert.match(sql, /LEFT JOIN item_sources psrc/);
});
