import test from "node:test";
import assert from "node:assert/strict";
import { buildDigestEmbed } from "./fulfillment-stale.js";

const STAGES = ["PRINT", "PICK", "PACK", "RESI"] as const;

function makeOrders(count: number, itemsLength: number) {
  return Array.from({ length: count }, (_, i) => ({
    orderId: String(400000 + i),
    days: 3 + (i % 20),
    stage: STAGES[i % STAGES.length],
    items: "Kartu Pokemon Edisi Panjang Sekali Namanya".slice(0, itemsLength).padEnd(itemsLength, "x"),
    user: `pembeli.nomor.${i}@contoh.com`,
    shipping: "JNE REGULER CASHLESS"
  }));
}

function embedSize(embed: ReturnType<typeof buildDigestEmbed>) {
  const data = embed.data;
  const fields = data.fields ?? [];
  return (
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text?.length ?? 0) +
    fields.reduce((total, f) => total + f.name.length + f.value.length, 0)
  );
}

test("digest tetap muat di batas Discord walau ordernya ratusan", () => {
  const embed = buildDigestEmbed(makeOrders(300, 60), 3, 30);
  assert.ok(embedSize(embed) <= 6000, `ukuran embed ${embedSize(embed)} > 6000`);
  assert.ok((embed.data.fields ?? []).length <= 25);
  for (const field of embed.data.fields ?? []) {
    assert.ok(field.value.length <= 1024, "value field lewat 1024");
  }
  assert.match(embed.data.description ?? "", /tidak ditampilkan/);
});

test("order sedikit tampil semua tanpa catatan sisa", () => {
  const embed = buildDigestEmbed(makeOrders(3, 20), 3, 30);
  assert.ok(embedSize(embed) <= 6000);
  assert.doesNotMatch(embed.data.description ?? "", /tidak ditampilkan/);
});

test("tanpa order sama sekali tetap embed kosong yang aman", () => {
  const embed = buildDigestEmbed([], 3, 30);
  assert.ok(embedSize(embed) <= 6000);
});

function countLines(embed: ReturnType<typeof buildDigestEmbed>) {
  return (embed.data.fields ?? []).reduce((n, f) => n + f.value.split("\n").length, 0);
}

test("selama masih muat, jumlah yang tampil tetap 40 seperti sebelumnya", () => {
  // Baris pendek: 40 order muat di bawah 6000, jadi tidak boleh ada pengecilan.
  const embed = buildDigestEmbed(makeOrders(100, 8), 3, 30);
  assert.equal(countLines(embed), 40);
  assert.match(embed.data.description ?? "", /60 order lagi/);
});

test("order panjang dipotong seperlunya, bukan dibuang semua", () => {
  const embed = buildDigestEmbed(makeOrders(100, 60), 3, 30);
  const lines = countLines(embed);
  assert.ok(lines > 5, `cuma ${lines} baris yang tampil, kepotong kebanyakan`);
  assert.ok(lines < 40, "harusnya dikecilkan dari 40");
});
