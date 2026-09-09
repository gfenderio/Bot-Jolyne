import test from "node:test";
import assert from "node:assert/strict";
import { openingEmbed, type ShipmentItem, type ShipmentRow } from "./wsr-shipment.js";

/*
Dua bentuk kiriman yang kolom `direction`-nya SAMA-SAMA 'request', tapi
pekerjaannya berbeda kota. Enum di hanayo cuma tiga dan sengaja tidak ditambah,
jadi yang membedakan cuma isi kirimannya — dan itu yang diuji di sini.
*/

function shipment(patch: Partial<ShipmentRow> = {}): ShipmentRow {
  return {
    id: 19,
    unit: "GAMMA_LAMBDA",
    direction: "request",
    status: "pending",
    totalItems: 37,
    totalQty: 78,
    createdBy: "Fara",
    executedBy: "-",
    executedAt: "",
    createdAt: "2026-09-08 15:19:31",
    ...patch
  };
}

function item(source: string, destination: string, qty: number): ShipmentItem {
  return {
    batchId: 19,
    itemId: "1",
    name: "Barang",
    barcode: "",
    source,
    destination,
    qty,
    rack: "",
    status: "pending",
    error: ""
  };
}

function description(row: ShipmentRow, items: ShipmentItem[]): string {
  return openingEmbed(row, items).data.description ?? "";
}

// Kiriman aslinya: WSR-GAMMA_LAMBDA-19, 8 Sep 2026. Lima gudang Bekasi mengirim
// ke gudang Lambda di Surabaya, dan pengumumannya menyebutnya "isi toko".
test("minta dari Bekasi tidak disebut isi toko, dan rinciannya per asal", () => {
  const isi = description(shipment(), [
    item("SS", "LAMBDA", 42),
    item("OMEGA", "LAMBDA", 16),
    item("SIGMA", "LAMBDA", 16),
    item("ALPHA", "LAMBDA", 3),
    item("BETA", "LAMBDA", 1)
  ]);

  assert.match(isi, /Gudang → Gudang \(isi gudang LAMBDA\)/);
  assert.ok(!isi.includes("Gudang → Toko"), "kiriman ke gudang tidak boleh disebut isi toko");
  // Penerimanya disebut walau tidak ditag.
  assert.match(isi, /Diambil dari \*\*SS\/OMEGA\/SIGMA\/ALPHA\/BETA\*\*, diterima \*\*LAMBDA\*\*\./);
  // Rinciannya per ASAL: "LAMBDA 78 pcs" cuma mengulang satu-satunya tujuan.
  assert.match(isi, /Dari \*\*SS\*\* 42 pcs · \*\*OMEGA\*\* 16 pcs/);
});

test("isi toko biasa tetap berbunyi isi toko, rinciannya per tujuan", () => {
  const isi = description(shipment({ id: 18, totalItems: 78, totalQty: 127 }), [
    item("LAMBDA", "GAMMA", 100),
    item("LAMBDA", "GAMMA", 27)
  ]);

  assert.match(isi, /Gudang → Toko \(isi toko\)/);
  assert.match(isi, /Untuk \*\*GAMMA\*\* 127 pcs/);
});

test("kiriman tanpa rincian barang tetap punya kalimat arah", () => {
  const isi = description(shipment(), []);
  assert.match(isi, /Gudang → Toko \(isi toko\)/);
  assert.ok(!isi.includes("Diambil dari"), "rute tidak dikarang saat barangnya tidak terbaca");
});
