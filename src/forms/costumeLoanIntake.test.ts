import test from "node:test";
import assert from "node:assert/strict";
import { buildCostumeLoanEmbed, handleCostumeLoanIntake, normalizeAnswers } from "./costumeLoanIntake.js";

const SNK_DENDA =
  'Mohon DIBACA! terlebih dahulu untuk memahami "Syarat & Ketentuan Sanksi dan Denda" di Kyou Cosplay Corner ya! ' +
  "1. Terlambat mengembalikan costume dikenakan denda 40k per hari. ".repeat(40);

function pengajuanLengkap() {
  return [
    { question: "Timestamp", answer: "21/08/2026 11:05:00" },
    { question: SNK_DENDA, answer: "Ya, saya sudah membaca Syarat dan Ketentuan Sanksi dan Denda di Kyou Cosplay Corner." },
    { question: "1. Nama Lengkap (Sesuai KTP) ", answer: "Farel Ramadhan" },
    { question: "2. Departemen / Divisi ", answer: "Ops Div - Warehouse Div" },
    { question: "3. Sertakan link costume yang ingin dipinjam ", answer: "https://kyou.id/item/12345" },
    { question: "4. Tanggal Peminjaman Costume ", answer: "25/08/2026" },
    { question: "5. Keperluan Peminjaman Costume ", answer: "Event cosplay kantor" }
  ];
}

function embedSize(embed: ReturnType<typeof buildCostumeLoanEmbed>) {
  const data = embed.data;
  return (
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text?.length ?? 0) +
    (data.fields ?? []).reduce((total, f) => total + f.name.length + f.value.length, 0)
  );
}

function nilai(embed: ReturnType<typeof buildCostumeLoanEmbed>, nama: string) {
  return (embed.data.fields ?? []).find((f) => f.name === nama)?.value;
}

test("semua jawaban form tampil di embed", () => {
  const embed = buildCostumeLoanEmbed(normalizeAnswers(pengajuanLengkap()), "resp-1");
  assert.match(embed.data.title ?? "", /Farel Ramadhan/);
  assert.equal(nilai(embed, "Divisi"), "Ops Div - Warehouse Div");
  assert.equal(nilai(embed, "Tanggal pinjam"), "25/08/2026");
  assert.equal(nilai(embed, "Keperluan"), "Event cosplay kantor");
  assert.equal(nilai(embed, "Costume"), "https://kyou.id/item/12345");
  assert.match(embed.data.footer?.text ?? "", /resp-1/);
});

test("pertanyaan persetujuan S&K tidak ikut membengkakkan embed", () => {
  const embed = buildCostumeLoanEmbed(normalizeAnswers(pengajuanLengkap()), "resp-2");
  assert.ok(embedSize(embed) <= 6000, `ukuran ${embedSize(embed)} > 6000`);
  for (const field of embed.data.fields ?? []) {
    assert.doesNotMatch(field.name, /Sanksi dan Denda/);
  }
});

test("pertanyaan baru yang belum dikenal tetap ikut tampil", () => {
  const answers = [...pengajuanLengkap(), { question: "6. Nomor WhatsApp", answer: "081234567890" }];
  const embed = buildCostumeLoanEmbed(normalizeAnswers(answers), null);
  assert.equal(nilai(embed, "6. Nomor WhatsApp"), "081234567890");
});

test("jawaban kosong ditandai, bukan bikin field hilang", () => {
  const answers = pengajuanLengkap().map((a) => (a.question.startsWith("5.") ? { ...a, answer: "" } : a));
  const embed = buildCostumeLoanEmbed(normalizeAnswers(answers), null);
  assert.equal(nilai(embed, "Keperluan"), "—");
});

test("jawaban kepanjangan dipotong, embed tetap muat", () => {
  const answers = pengajuanLengkap().map((a) =>
    a.question.startsWith("5.") ? { ...a, answer: "x".repeat(5000) } : a
  );
  const embed = buildCostumeLoanEmbed(normalizeAnswers(answers), "resp-3");
  assert.ok((nilai(embed, "Keperluan") ?? "").length <= 1024);
  assert.ok(embedSize(embed) <= 6000);
});

test("banyak pertanyaan tak dikenal tidak menembus batas Discord", () => {
  const tambahan = Array.from({ length: 40 }, (_, i) => ({
    question: `Pertanyaan tambahan nomor ${i} yang judulnya cukup panjang`,
    answer: "jawaban panjang sekali ".repeat(20)
  }));
  const embed = buildCostumeLoanEmbed(normalizeAnswers([...pengajuanLengkap(), ...tambahan]), "resp-4");
  assert.ok(embedSize(embed) <= 6000, `ukuran ${embedSize(embed)} > 6000`);
  assert.ok((embed.data.fields ?? []).length <= 25);
});

test("kiriman tanpa pertanyaan dianggap kosong", () => {
  assert.equal(normalizeAnswers([{ question: "  ", answer: "x" }]).length, 0);
  assert.equal(normalizeAnswers("bukan array").length, 0);
});

// --- penjaga endpoint (tanpa Discord) ---

type Ditulis = { status: number; body: string };

function responsePalsu() {
  const hasil: Ditulis = { status: 0, body: "" };
  return {
    hasil,
    res: {
      headersSent: false,
      writeHead(status: number) {
        hasil.status = status;
      },
      end(body: string) {
        hasil.body = body;
      }
    } as unknown as Parameters<typeof handleCostumeLoanIntake>[1]
  };
}

function requestPalsu(method: string, auth?: string, body = "") {
  return Object.assign(
    (async function* () {
      if (body) yield body;
    })(),
    { method, headers: { authorization: auth } }
  ) as unknown as Parameters<typeof handleCostumeLoanIntake>[0];
}

const clientPalsu = { channels: { fetch: async () => null } } as unknown as Parameters<typeof handleCostumeLoanIntake>[2];

test("GET ditolak, endpoint ini cuma menerima POST", async () => {
  const { hasil, res } = responsePalsu();
  await handleCostumeLoanIntake(requestPalsu("GET"), res, clientPalsu);
  assert.equal(hasil.status, 405);
});

test("tanpa token yang benar ditolak 401", async () => {
  const { hasil, res } = responsePalsu();
  await handleCostumeLoanIntake(requestPalsu("POST", "Bearer salah", "{}"), res, clientPalsu);
  assert.equal(hasil.status, 401);
});
