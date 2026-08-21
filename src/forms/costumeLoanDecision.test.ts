import test from "node:test";
import assert from "node:assert/strict";
import { EmbedBuilder } from "discord.js";
import { buildDecidedEmbed, decisionButtons } from "./costumeLoanDecision.js";

function pengajuan() {
  return new EmbedBuilder()
    .setTitle("👗 Pinjam Costume — Gilang")
    .addFields(
      { name: "Divisi", value: "Ops Div - Tech & OPTR Div", inline: true },
      { name: "Tanggal pinjam", value: "28/08/2026", inline: true }
    )
    .setFooter({ text: "ID tanggapan: row-2" });
}

function nilai(embed: EmbedBuilder, nama: string) {
  return (embed.data.fields ?? []).find((f) => f.name === nama)?.value;
}

test("disetujui: mencatat siapa yang mengklik, tanpa kolom alasan", () => {
  const embed = buildDecidedEmbed(pengajuan(), { disetujui: true, olehId: "419213146209779713", alasan: null });
  const keputusan = nilai(embed, "Keputusan") ?? "";
  assert.match(keputusan, /Disetujui oleh <@419213146209779713>/);
  assert.equal(nilai(embed, "Alasan ditolak"), undefined);
  assert.equal(embed.data.color, 0x2f8f5b);
});

test("ditolak: alasannya ikut tercatat di embed", () => {
  const embed = buildDecidedEmbed(pengajuan(), {
    disetujui: false,
    olehId: "915811508561272894",
    alasan: "Costume-nya sedang dipakai untuk pemotretan"
  });
  assert.match(nilai(embed, "Keputusan") ?? "", /Tidak disetujui oleh <@915811508561272894>/);
  assert.equal(nilai(embed, "Alasan ditolak"), "Costume-nya sedang dipakai untuk pemotretan");
  assert.equal(embed.data.color, 0xd9534f);
});

test("isi pengajuan aslinya tidak hilang setelah diputuskan", () => {
  const embed = buildDecidedEmbed(pengajuan(), { disetujui: true, olehId: "1", alasan: null });
  assert.equal(embed.data.title, "👗 Pinjam Costume — Gilang");
  assert.equal(nilai(embed, "Divisi"), "Ops Div - Tech & OPTR Div");
  assert.equal(nilai(embed, "Tanggal pinjam"), "28/08/2026");
  assert.equal(embed.data.footer?.text, "ID tanggapan: row-2");
});

test("alasan kepanjangan dipotong, tidak ditolak Discord", () => {
  const embed = buildDecidedEmbed(pengajuan(), { disetujui: false, olehId: "1", alasan: "x".repeat(5000) });
  assert.ok((nilai(embed, "Alasan ditolak") ?? "").length <= 1024);
});

test("ditolak tanpa alasan tetap punya penanda, bukan field kosong", () => {
  const embed = buildDecidedEmbed(pengajuan(), { disetujui: false, olehId: "1", alasan: null });
  assert.equal(nilai(embed, "Alasan ditolak"), "—");
});

test("tombol membawa id tanggapan supaya keputusannya bisa dicocokkan", () => {
  const row = decisionButtons("row-2");
  const ids = row.toJSON().components.map((c) => ("custom_id" in c ? c.custom_id : null));
  assert.deepEqual(ids, ["costume_approve:row-2", "costume_reject:row-2"]);
});

test("tanpa id tanggapan, tombol tetap terbentuk", () => {
  const ids = decisionButtons(null)
    .toJSON()
    .components.map((c) => ("custom_id" in c ? c.custom_id : null));
  assert.deepEqual(ids, ["costume_approve", "costume_reject"]);
});
