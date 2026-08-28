import type { IncomingMessage, ServerResponse } from "node:http";
import { EmbedBuilder, type Client, type TextChannel } from "discord.js";
import { isAuthorizedMachitanIntake } from "./intakeAuth.js";
import { findProofMessage } from "./proofDelivery.js";
import { orderLink } from "../services/kyouLinks.js";

/**
 * BATAL PICK dari PDA.
 *
 * ── MASALAH YANG DIJAWAB ────────────────────────────────────────────────────
 * Pick e-commerce mengirim satu kartu hijau per barang ke Discord. Kalau
 * picknya kemudian dibatalkan di PDA, kartu itu tetap berdiri tanpa perubahan —
 * dan bagi siapa pun yang menemukannya nanti, barang itu tampak sudah diambil.
 * Tidak ada tempat lain untuk memeriksanya: foto pick e-com memang cuma hidup
 * di Discord, tidak masuk database mana pun.
 *
 * ── KENAPA MEMBALAS, BUKAN MENGHAPUS ────────────────────────────────────────
 * Menghapus kartu lama ikut menghapus fotonya, dan yang tersisa cuma kekosongan
 * yang tidak bisa dibedakan dari "belum pernah dipick". Yang ditanyakan orang
 * nanti bukan "ada buktinya tidak", melainkan "kenapa dibatalkan" — dan itu
 * cuma bisa dijawab kalau kedua kartunya masih ada dan bertaut.
 *
 * ── KALAU KARTU LAMANYA TIDAK KETEMU ────────────────────────────────────────
 * Kartu batalnya tetap dikirim, berdiri sendiri. Ini BUKAN keadaan langka:
 * catatan pesan tinggal di `data/` yang hilang tiap redeploy, dan umurnya
 * dipangkas 14 hari. Menolak mengirim apa pun karena tautannya hilang berarti
 * mengubah kekurangan tampilan jadi kehilangan kabar.
 */

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(`${JSON.stringify(payload)}\n`);
}

class PayloadTooLargeError extends Error {}

// Metadata saja, tanpa foto — kartu batal memakai foto kartu aslinya lewat balasan.
async function readRequestBody(request: IncomingMessage, maxBytes = 1 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new PayloadTooLargeError("Payload terlalu besar.");
  }
  return body;
}

/** "29 menit" / "2 jam 5 menit" — jeda dipick sampai dibatalkan. */
function jeda(pickedAtIso: string | undefined, cancelledAt: Date): string | null {
  if (!pickedAtIso) return null;
  const picked = new Date(pickedAtIso);
  if (Number.isNaN(picked.getTime())) return null;
  const detik = Math.round((cancelledAt.getTime() - picked.getTime()) / 1000);
  if (detik < 0) return null;
  if (detik < 60) return `${detik} detik`;
  const menit = Math.floor(detik / 60);
  if (menit < 60) return `${menit} menit`;
  const jam = Math.floor(menit / 60);
  const sisaMenit = menit % 60;
  return sisaMenit === 0 ? `${jam} jam` : `${jam} jam ${sisaMenit} menit`;
}

export async function handleMachitanPickCancel(
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

    const channelId = String(body.channelId ?? "").trim();
    const orderId = String(body.orderId ?? "-").trim();
    const itemId = String(body.itemId ?? "-").trim();
    const productName = String(body.productName ?? "Item").trim();
    const actor = String(body.actor ?? "").trim();
    // Alasan WAJIB. Kartu yang cuma berbunyi "dibatalkan" meninggalkan
    // pertanyaan pertama yang orang ajukan tanpa jawaban, dan yang membacanya
    // besok tidak punya siapa pun untuk ditanyai.
    const reason = String(body.reason ?? "").trim();

    if (!channelId || !actor || !reason) {
      return sendJson(response, 400, {
        error: "Missing required fields (channelId, actor, reason)",
        ok: false,
      });
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      return sendJson(response, 404, { error: `Channel ${channelId} tidak bisa dipakai`, ok: false });
    }

    const cancelledAt = new Date();
    const selisih = jeda(body.pickedAt ? String(body.pickedAt) : undefined, cancelledAt);
    const qty = body.qty === undefined || body.qty === null ? "-" : String(body.qty);
    const source = String(body.source ?? "-").toUpperCase();

    const embed = new EmbedBuilder()
      .setColor(0xd32f2f)
      .setTitle(`BATAL PICK — ${productName}`.slice(0, 256))
      .addFields(
        { name: "Order ID", value: orderLink(orderId), inline: true },
        { name: "Dibatalkan oleh", value: actor, inline: true },
        { name: "Alasan", value: reason.slice(0, 1024), inline: false },
        { name: "Items", value: `Item: #${itemId} | Qty: ${qty} | Source: ${source}`, inline: false },
        ...(body.channel ? [{ name: "Channel", value: String(body.channel), inline: true }] : []),
      )
      .setTimestamp(cancelledAt);

    // Jeda dipick→dibatalkan ditaruh di footer, bukan kolom: ia yang membedakan
    // salah scan (menit) dari barang yang ternyata tidak ada (jam), dan itu
    // keterangan, bukan data yang perlu disalin orang.
    if (selisih) embed.setFooter({ text: `Dipick lalu dibatalkan berselang ${selisih}` });

    const asal = await findProofMessage(orderId, itemId);
    let tertaut = false;

    if (asal) {
      try {
        const asalChannel = await client.channels.fetch(asal.channelId);
        if (asalChannel?.isTextBased()) {
          const pesan = await (asalChannel as TextChannel).messages.fetch(asal.messageId);
          await pesan.reply({ embeds: [embed] });
          tertaut = true;
        }
      } catch (err) {
        // Pesannya sudah dihapus orang, atau bot kehilangan aksesnya. Bukan
        // alasan menahan kabarnya — jatuh ke kartu berdiri sendiri di bawah.
        console.warn(`Kartu pick asal #${orderId} item ${itemId} tidak bisa dibalas:`, err);
      }
    }

    if (!tertaut) {
      await (channel as TextChannel).send({ embeds: [embed] });
    }

    return sendJson(response, 200, { ok: true, linked: tertaut });
  } catch (error) {
    console.error("Machitan pick-cancel Error:", error);
    if (error instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { error: error.message, ok: false });
    }
    return sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Internal Server Error",
      ok: false,
    });
  }
}
