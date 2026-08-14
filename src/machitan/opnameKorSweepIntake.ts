import type { IncomingMessage, ServerResponse } from "node:http";
import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";

/**
 * POST /machitan/opname-kor-sweep — hasil sapuan selisih opname jam 2 pagi.
 *
 * Hanayo memindahkan selisih KURANG opname event yang tak kunjung dibereskan ke
 * kantong {GUDANG}-KOR, lalu mengirim hasilnya ke sini. Selisih itu tidak muncul
 * di layar mana pun, jadi Excel ini SATU-SATUNYA permukaan laporannya — dipakai
 * saat settlement untuk tahu barang apa yang hilang malam itu dan siapa yang
 * menghitungnya.
 *
 * Beda dengan /machitan/ws-inbox yang menumpuk ke berkas lalu dilaporkan
 * terjadwal: kiriman ini SUDAH satu laporan utuh untuk satu malam, jadi langsung
 * dikirim begitu diterima. Tidak ada yang perlu ditumpuk.
 */

const TARGET_CHANNEL_ID = "1501899831268868106"; // channel pick pack / machitan update

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

class PayloadTooLargeError extends Error {}

// Metadata murni tanpa foto. Sapuan terburuk pun ratusan baris, jauh di bawah 5MB.
async function readRequestBody(request: IncomingMessage, maxBytes = 5 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new PayloadTooLargeError("Payload terlalu besar.");
  }
  return body;
}

type SweptItem = {
  item_id?: string;
  item_name?: string | null;
  source?: string;
  kor_source?: string;
  system_stock?: number;
  counted_stock?: number;
  qty_to_kor?: number;
  counted_by?: string | null;
  counted_at?: string | null;
};

export function buildOpnameKorSweepWorkbook(
  items: SweptItem[],
  needsHuman: string[],
  sweptAt: string,
): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();

  const sheet = workbook.addWorksheet("Masuk KOR");
  sheet.columns = [
    { header: "Item ID", key: "itemId", width: 12 },
    { header: "Nama Barang", key: "name", width: 46 },
    { header: "Gudang", key: "source", width: 14 },
    { header: "Kantong KOR", key: "kor", width: 18 },
    { header: "Stok Sistem", key: "system", width: 13 },
    { header: "Hasil Hitung", key: "counted", width: 13 },
    { header: "Masuk KOR", key: "qty", width: 12 },
    { header: "Dihitung Oleh", key: "by", width: 22 },
    { header: "Waktu Hitung", key: "at", width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const it of items) {
    sheet.addRow({
      itemId: it.item_id ?? "-",
      name: it.item_name ?? "-",
      source: it.source ?? "-",
      kor: it.kor_source ?? "-",
      system: Number(it.system_stock ?? 0),
      counted: Number(it.counted_stock ?? 0),
      qty: Number(it.qty_to_kor ?? 0),
      // Yang menghitung, BUKAN yang menyapu. Penyapunya selalu akun sistem dan
      // itu tidak berguna buat siapa pun yang membaca laporan ini.
      by: it.counted_by ?? "-",
      at: it.counted_at ?? "-",
    });
  }

  // Sheet kedua hanya dibuat kalau memang ada isinya, supaya lampiran yang
  // bersih tidak menyisakan tab kosong yang bikin orang mengira ada masalah.
  if (needsHuman.length > 0) {
    const manual = workbook.addWorksheet("Perlu Diputuskan Manusia");
    manual.columns = [{ header: "Keterangan", key: "note", width: 90 }];
    manual.getRow(1).font = { bold: true };
    for (const note of needsHuman) manual.addRow({ note });
  }

  const info = workbook.addWorksheet("Info");
  info.columns = [
    { header: "Keterangan", key: "k", width: 28 },
    { header: "Nilai", key: "v", width: 50 },
  ];
  info.getRow(1).font = { bold: true };
  info.addRow({ k: "Waktu sapuan", v: sweptAt });
  info.addRow({ k: "Barang masuk KOR", v: items.length });
  info.addRow({ k: "Total unit", v: items.reduce((sum, it) => sum + Number(it.qty_to_kor ?? 0), 0) });
  info.addRow({ k: "Perlu diputuskan manusia", v: needsHuman.length });

  return workbook;
}

export async function handleOpnameKorSweepIntake(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>,
) {
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed", ok: false });

  if (!isAuthorizedMachitanIntake(request.headers.authorization)) {
    return sendJson(response, 401, { error: "Unauthorized", ok: false });
  }

  try {
    const body = JSON.parse(await readRequestBody(request));

    const items: SweptItem[] = Array.isArray(body.items) ? body.items : [];
    const needsHuman: string[] = Array.isArray(body.needs_human) ? body.needs_human.map(String) : [];
    const sweptAt = String(body.swept_at ?? new Date().toISOString());
    const totalUnits = Number(body.total_units ?? items.reduce((s, it) => s + Number(it.qty_to_kor ?? 0), 0));

    // Sapuan yang tidak menemukan apa-apa TIDAK dilaporkan. Lampiran kosong tiap
    // malam melatih orang mengabaikan laporan ini, dan yang penting justru malam
    // ketika isinya tidak kosong.
    if (items.length === 0 && needsHuman.length === 0) {
      return sendJson(response, 200, { message: "Tidak ada yang dilaporkan", ok: true });
    }

    const workbook = buildOpnameKorSweepWorkbook(items, needsHuman, sweptAt);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const tanggal = sweptAt.slice(0, 10);
    const attachment = new AttachmentBuilder(buffer, { name: `opname-kor-${tanggal}.xlsx` });

    const embed = new EmbedBuilder()
      .setTitle("Selisih Opname Masuk KOR")
      .setDescription(
        [
          `Sapuan **${sweptAt}**`,
          `**${items.length}** barang, **${totalUnits}** unit dipindah ke kantong KOR gudangnya.`,
          needsHuman.length > 0
            ? `**${needsHuman.length}** barang perlu diputuskan manusia — unit hilangnya ada di kantong reservasi oripa, jadi tidak disentuh.`
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .setColor(needsHuman.length > 0 ? 0xd9ac5c : 0x1f6f5c)
      .setTimestamp(new Date());

    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error("Channel laporan sapuan KOR tidak ditemukan atau bukan text channel");
      return sendJson(response, 500, { error: "Target channel unavailable", ok: false });
    }
    await (channel as TextChannel).send({ embeds: [embed], files: [attachment] });

    return sendJson(response, 200, { message: "Laporan sapuan KOR terkirim", ok: true });
  } catch (error) {
    console.error("Opname KOR Sweep Intake Error:", error);
    if (error instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { error: error.message, ok: false });
    }
    return sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}
