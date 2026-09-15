import test from "node:test";
import assert from "node:assert/strict";
import type { TextChannel } from "discord.js";
import {
  bergiliran,
  mentionIdsUntuk,
  openingEmbed,
  type ShipmentItem,
  type ShipmentRow
} from "./wsr-shipment.js";

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

// Orang toko yang menekan tautan gudang mendarat di daftar kiriman semua
// tempat, tanpa satu pun tanda mana barisnya.
test("tiap tempat dapat alamatnya sendiri — toko ke panel tokonya", () => {
  const isi = description(shipment(), [
    item("SS", "LAMBDA", 42),
    item("ALPHA", "LAMBDA", 3),
    item("BETA", "LAMBDA", 1)
  ]);

  assert.match(isi, /SS: <https:\/\/team\.kyou\.id\/warehouse\/stock-rotation\?kiriman=19>/);
  assert.match(isi, /ALPHA: <https:\/\/team\.kyou\.id\/store\/alpha\/kiriman\?kiriman=19>/);
  assert.match(isi, /BETA: <https:\/\/team\.kyou\.id\/store\/beta\/kiriman\?kiriman=19>/);
});

test("kiriman yang semuanya gudang tetap satu alamat", () => {
  const isi = description(shipment(), [item("OMEGA", "LAMBDA", 5), item("SS", "LAMBDA", 2)]);
  assert.match(isi, /OMEGA\/SS: <https:\/\/team\.kyou\.id\/warehouse\/stock-rotation\?kiriman=19>/);
  assert.ok(!isi.includes("/store/"), "gudang tidak boleh diarahkan ke panel toko");
});

// WSR-GAMMA_LAMBDA-20, 15 Sep 2026: rak Lambda dikerjakan dari panel Gamma
// (kakera: racksOf). Tautannya dulu ke papan gudang — yang tidak pernah memuat
// rak Lambda — jadi orang yang menekannya mengira kirimannya hilang.
test("rak Lambda ditautkan ke panel Gamma, langsung ke kirimannya", () => {
  const isi = description(shipment({ id: 20, totalItems: 13, totalQty: 20 }), [
    item("LAMBDA", "GAMMA", 20)
  ]);
  assert.match(isi, /LAMBDA: <https:\/\/team\.kyou\.id\/store\/gamma\/kiriman\?kiriman=20>/);
  assert.ok(!isi.includes("/warehouse/stock-rotation"), "rak Lambda bukan milik papan gudang");
});

test("rak gudang tanpa panel tetap ke papan gudang, langsung ke kirimannya", () => {
  const isi = description(shipment(), [item("SIGMA", "LAMBDA", 5)]);
  assert.match(isi, /SIGMA: <https:\/\/team\.kyou\.id\/warehouse\/stock-rotation\?kiriman=19>/);
});

/*
TAG: rak berpanel toko → peran tokonya; rak tanpa panel → orang gudang kotanya.
Channel tiruan cuma memuat daftar peran — itu satu-satunya yang dibaca.
*/
function channelDenganPeran(): TextChannel {
  const peran = [
    { id: "peran-alpha", name: "Team Alpha Store" },
    { id: "peran-beta", name: "Team Beta Store" },
    { id: "peran-gamma", name: "Team Gamma Store" }
  ];
  return {
    guild: {
      roles: {
        cache: {
          find: (cocok: (r: { id: string; name: string }) => boolean) => peran.find(cocok),
          has: (id: string) => peran.some((r) => r.id === id),
          size: peran.length
        }
      }
    }
  } as unknown as TextChannel;
}

const ORANG_SURABAYA = "1224581529854939138"; // Shello (env bawaan)
const ORANG_BEKASI = "1115194334497755157"; // env bawaan

test("kiriman dari rak Lambda men-tag Team Gamma Store, bukan orang Surabaya", () => {
  const ids = mentionIdsUntuk(shipment({ id: 20 }), [item("LAMBDA", "GAMMA", 20)], channelDenganPeran());
  assert.deepEqual(ids, ["peran-gamma"]);
  assert.ok(!ids.includes(ORANG_SURABAYA));
});

test("minta dari Bekasi tetap men-tag orang Bekasi plus peran toko yang raknya dipakai", () => {
  const ids = mentionIdsUntuk(
    shipment(),
    [item("SS", "LAMBDA", 42), item("OMEGA", "LAMBDA", 16), item("ALPHA", "LAMBDA", 3), item("BETA", "LAMBDA", 1)],
    channelDenganPeran()
  );
  assert.deepEqual(ids.sort(), [ORANG_BEKASI, "peran-alpha", "peran-beta"].sort());
});

test("kiriman yang sudah beres tetap menaut ke kirimannya", () => {
  const isi = description(shipment({ status: "done" }), [item("OMEGA", "LAMBDA", 5)]);
  assert.match(isi, /stock-rotation\?kiriman=19>/);
});

test("isi toko biasa tetap berbunyi isi toko, rinciannya per tujuan", () => {
  const isi = description(shipment({ id: 18, totalItems: 78, totalQty: 127 }), [
    item("LAMBDA", "GAMMA", 100),
    item("LAMBDA", "GAMMA", 27)
  ]);

  assert.match(isi, /Gudang → Toko \(isi toko\)/);
  assert.match(isi, /Untuk \*\*GAMMA\*\* 127 pcs/);
});

// WSR-GAMMA_LAMBDA-20: dorongan kakera dan poller memeriksa channel berbarengan,
// dua-duanya melihatnya kosong, dua pengumuman terkirim. Giliran kedua harus
// baru memeriksa SESUDAH giliran pertama selesai mengirim.
test("dua pengumuman yang datang berbarengan dikerjakan bergiliran", async () => {
  const terumumkan = new Set<string>();
  const jejak: string[] = [];
  const umumkan = (jalur: string) =>
    bergiliran(async () => {
      jejak.push(`${jalur}:periksa`);
      if (terumumkan.has("WSR-GAMMA_LAMBDA-20")) return "sudah-ada";
      await new Promise((r) => setTimeout(r, 20)); // Discord yang lambat
      terumumkan.add("WSR-GAMMA_LAMBDA-20");
      jejak.push(`${jalur}:kirim`);
      return "terkirim";
    });

  const [a, b] = await Promise.all([umumkan("kakera"), umumkan("poller")]);
  assert.deepEqual([a, b], ["terkirim", "sudah-ada"]);
  assert.deepEqual(jejak, ["kakera:periksa", "kakera:kirim", "poller:periksa"]);
});

test("giliran yang gagal tidak menahan giliran berikutnya", async () => {
  const gagal = bergiliran(async () => {
    throw new Error("Discord menolak");
  });
  await assert.rejects(gagal);
  assert.equal(await bergiliran(async () => "jalan"), "jalan");
});

test("kiriman tanpa rincian barang tetap punya kalimat arah", () => {
  const isi = description(shipment(), []);
  assert.match(isi, /Gudang → Toko \(isi toko\)/);
  assert.ok(!isi.includes("Diambil dari"), "rute tidak dikarang saat barangnya tidak terbaca");
});
