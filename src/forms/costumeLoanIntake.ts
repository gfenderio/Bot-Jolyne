import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Client, EmbedBuilder, TextChannel } from "discord.js";
import { env } from "../config/env.js";
import { decisionButtons } from "./costumeLoanDecision.js";

/**
 * POST /forms/costume-loan — pengajuan pinjam costume staf Kyou.
 *
 * Google Form tidak bisa ditarik datanya, dia yang harus mendorong keluar. Apps
 * Script di spreadsheet tanggapan (scripts/costume-loan-form.gs) menembak ke
 * sini tiap ada yang mengisi, lalu bot yang menyusun embed-nya.
 *
 * Kiriman sengaja berupa daftar mentah pertanyaan->jawaban, bukan field yang
 * sudah dinamai. Form ini masih berkembang; kalau bot menuntut nama field
 * tertentu, tiap pertanyaan baru di form akan hilang diam-diam dari embed
 * sampai ada yang sadar dan merilis ulang bot. Dengan daftar mentah, pertanyaan
 * yang dikenal ditata rapi dan sisanya tetap ikut tampil apa adanya.
 */

type Answer = { question?: unknown; answer?: unknown };

type CostumeLoanPayload = {
  responseId?: unknown;
  answers?: unknown;
};

export type NormalizedAnswer = { question: string; answer: string };

const STORE_PATH = "data/costume-loan-seen.json";
const MAX_REMEMBERED = 500;

// Batas Discord: 1024 per nilai field, 6000 untuk seluruh embed.
const MAX_FIELD_CHARS = 1000;
const MAX_EMBED_CHARS = 5800;
const EMBED_COLOR = 0xa855f7;

class PayloadTooLargeError extends Error {}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readRequestBody(request: IncomingMessage, maxBytes = 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new PayloadTooLargeError("Payload terlalu besar.");
  }
  return body;
}

/** Judul pertanyaan disamakan dulu: nomor urut, tanda baca, dan spasi ganda dibuang. */
function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/^\s*\d+\s*[.)]\s*/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Pertanyaan persetujuan S&K dilewati. Judulnya memuat seluruh daftar denda
 * (ribuan karakter) dan jawabannya selalu sama karena di form sudah wajib —
 * kalau ikut ditampilkan, satu pengajuan saja bisa menembus batas embed.
 */
function isConsentQuestion(normalized: string): boolean {
  return normalized.includes("syarat dan ketentuan") || normalized.startsWith("mohon dibaca");
}

const FIELD_MATCHERS: { label: string; match: (q: string) => boolean }[] = [
  { label: "Nama", match: (q) => q.includes("nama lengkap") },
  { label: "Divisi", match: (q) => q.includes("departemen") || q.includes("divisi") },
  { label: "Tanggal pinjam", match: (q) => q.includes("tanggal peminjaman") },
  { label: "Keperluan", match: (q) => q.includes("keperluan") },
  { label: "Costume", match: (q) => q.includes("link costume") || q.includes("costume yang ingin dipinjam") }
];

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function normalizeAnswers(raw: unknown): NormalizedAnswer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry: Answer) => ({
      question: String(entry?.question ?? "").trim(),
      answer: String(entry?.answer ?? "").trim()
    }))
    .filter((entry) => entry.question.length > 0);
}

function embedSize(embed: EmbedBuilder): number {
  const data = embed.data;
  const fields = data.fields ?? [];
  return (
    (data.title?.length ?? 0) +
    (data.description?.length ?? 0) +
    (data.footer?.text?.length ?? 0) +
    fields.reduce((total, f) => total + f.name.length + f.value.length, 0)
  );
}

export function buildCostumeLoanEmbed(answers: NormalizedAnswer[], responseId: string | null): EmbedBuilder {
  const known = new Map<string, string>();
  const lainnya: NormalizedAnswer[] = [];

  for (const entry of answers) {
    const normalized = normalizeQuestion(entry.question);
    if (isConsentQuestion(normalized)) continue;

    const matcher = FIELD_MATCHERS.find((m) => m.match(normalized));
    if (matcher && !known.has(matcher.label)) {
      known.set(matcher.label, entry.answer);
    } else {
      lainnya.push(entry);
    }
  }

  const nama = known.get("Nama") || "Tanpa nama";
  const embed = new EmbedBuilder()
    .setTitle(`👗 Pinjam Costume — ${truncate(nama, 200)}`)
    .setColor(EMBED_COLOR)
    .setTimestamp();

  for (const { label } of FIELD_MATCHERS) {
    if (label === "Nama") continue;
    const value = known.get(label);
    embed.addFields({
      name: label,
      value: truncate(value || "—", MAX_FIELD_CHARS),
      inline: label !== "Costume"
    });
  }

  // Pertanyaan yang belum dikenal tetap ikut, supaya tambahan baru di form tidak
  // hilang diam-diam sambil menunggu kodenya menyusul.
  for (const entry of lainnya) {
    if (embedSize(embed) > MAX_EMBED_CHARS) break;
    embed.addFields({
      name: truncate(entry.question, 200),
      value: truncate(entry.answer || "—", MAX_FIELD_CHARS)
    });
  }

  if (responseId) {
    embed.setFooter({ text: `ID tanggapan: ${truncate(responseId, 100)}` });
  }

  // Jaring pengaman terakhir: buang field dari belakang sampai muat, daripada
  // seluruh pesan ditolak Discord.
  while (embedSize(embed) > MAX_EMBED_CHARS && (embed.data.fields?.length ?? 0) > 1) {
    embed.spliceFields(-1, 1);
  }

  return embed;
}

function readSeen(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rememberSeen(responseId: string) {
  const seen = readSeen();
  seen.push(responseId);
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(seen.slice(-MAX_REMEMBERED), null, 2), "utf-8");
}

function isAuthorized(authHeader: string | undefined): boolean {
  const token = env.COSTUME_LOAN_INTAKE_TOKEN;
  if (!token) return false;
  return authHeader === `Bearer ${token}`;
}

export async function handleCostumeLoanIntake(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client
): Promise<void> {
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  if (!isAuthorized(request.headers.authorization)) {
    sendJson(response, 401, { ok: false, error: "Unauthorized" });
    return;
  }

  const channelId = env.COSTUME_LOAN_CHANNEL_ID;
  if (!channelId) {
    sendJson(response, 503, { ok: false, error: "COSTUME_LOAN_CHANNEL_ID belum diisi" });
    return;
  }

  let payload: CostumeLoanPayload;
  try {
    payload = JSON.parse(await readRequestBody(request)) as CostumeLoanPayload;
  } catch (error) {
    const tooLarge = error instanceof PayloadTooLargeError;
    sendJson(response, tooLarge ? 413 : 400, {
      ok: false,
      error: tooLarge ? "Payload terlalu besar" : "Body bukan JSON"
    });
    return;
  }

  const answers = normalizeAnswers(payload.answers);
  if (answers.length === 0) {
    sendJson(response, 400, { ok: false, error: "answers kosong" });
    return;
  }

  // Apps Script mengirim ulang kalau jaringannya nyangkut. Kiriman kedua dijawab
  // sukses tapi tidak diposting dua kali.
  const responseId = payload.responseId ? String(payload.responseId) : null;
  if (responseId && readSeen().includes(responseId)) {
    console.log(`[costume-loan] kiriman kembar dilewati (${responseId}).`);
    sendJson(response, 200, { ok: true, duplicate: true });
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    sendJson(response, 500, { ok: false, error: "Channel tujuan tidak bisa dibuka" });
    return;
  }

  await (channel as TextChannel).send({
    embeds: [buildCostumeLoanEmbed(answers, responseId)],
    components: [decisionButtons(responseId)]
  });
  if (responseId) rememberSeen(responseId);

  console.log(`[costume-loan] pengajuan diposting${responseId ? ` (${responseId})` : ""}.`);
  sendJson(response, 200, { ok: true });
}
