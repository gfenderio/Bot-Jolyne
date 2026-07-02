import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, Client, EmbedBuilder } from "discord.js";
import { env } from "../config/env.js";
import { addMachitanProof } from "./proofStore.js";

const ECOM_PICK_PROOF_CHANNEL_ID = "1390221553333043200";
const SHOPEE_MENTION = "<@804685637252939788>";
const TOKOPEDIA_MENTION = "<@833000054880206888>";
// Discord bot API upload limit ~8MB per attachment (beda dari limit user biasa/boosted server).
const DISCORD_BOT_ATTACHMENT_LIMIT_BYTES = 8 * 1024 * 1024;

function isEcommerceProofItem(item: any) {
  const origin = String(item?.originType ?? item?.pickRequestType ?? item?.requestType ?? "").toLowerCase();
  return origin.includes("e-com") || origin.includes("ecommerce") || origin.includes("outside");
}

function inferEcommerceChannel(orderId: string, item: any) {
  const explicit = String(item?.channel ?? item?.ecommerce ?? item?.marketplace ?? "").toLowerCase();
  if (explicit.includes("shopee")) return "Shopee";
  if (explicit.includes("tokopedia") || explicit.includes("toped")) return "Tokopedia";
  // Order ID kadang dapat suffix non-digit dari PDA (mis. "584... BOX MULUS")
  // yang bikin /^\d+$/ gagal → salah default ke Shopee. Ambil grup digit pertama
  // dulu, baru cek panjangnya (order numerik panjang = Tokopedia).
  const digits = orderId.match(/\d+/)?.[0] ?? "";
  if (digits.length >= 12) return "Tokopedia";
  return "Shopee";
}

function mentionForEcommerce(channel: string) {
  const normalized = channel.toLowerCase();
  if (normalized.includes("shopee")) return SHOPEE_MENTION;
  if (normalized.includes("tokopedia") || normalized.includes("toped")) return TOKOPEDIA_MENTION;
  return "";
}

function itemKyouUrl(itemId: string) {
  return itemId && itemId !== "-" ? `https://kyou.id/items/${encodeURIComponent(itemId)}` : undefined;
}

// Order ID marketplace kadang punya deskripsi nempel di belakang angka
// (mis. "584653665670366416 BOX MULUS"). Pisahkan jadi order id bersih + deskripsi
// supaya tidak ngerusak deteksi channel (tag) & tampil di kolom sendiri.
function splitOrderDescription(raw: unknown): { orderId: string; description: string | null } {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{6,})\s+(\S.*)$/);
  if (m) return { orderId: m[1], description: m[2].trim() };
  return { orderId: s, description: null };
}


// Helper for sending JSON response
function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

export class PayloadTooLargeError extends Error {}

// 20MB: multi-foto (base64 +33%) bisa lewat 10MB dengan 4+ foto hasil kompres PDA.
async function readRequestBody(request: IncomingMessage, maxBytes = 20 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new PayloadTooLargeError("Payload terlalu besar.");
    }
  }
  return body;
}

export async function handleMachitanPickProof(
  request: IncomingMessage,
  response: ServerResponse,
  client: Client<true>
) {
  if (request.method !== "POST") {
    return sendJson(response, 405, { error: "Method not allowed", ok: false });
  }

  // Very simple auth check
  const authHeader = request.headers.authorization;
  if (authHeader !== "Bearer kyou-machitan-secret-2026") {
    return sendJson(response, 401, { error: "Unauthorized", ok: false });
  }

  try {
    const bodyStr = await readRequestBody(request);
    const body = JSON.parse(bodyStr);

    const logOnly = body.logOnly === true || String(body.proofType ?? body.type ?? "").toLowerCase().includes("log");

    const hasAnyImage = !!body.imageBase64 || (Array.isArray(body.images) && body.images.length > 0);
    if (!body.orderIds || !body.picker || (!logOnly && !hasAnyImage)) {
      return sendJson(response, 400, { error: "Missing required fields", ok: false });
    }

    const orderIdsArr: string[] = Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)];
    const orderSplits = orderIdsArr.map(splitOrderDescription);
    const cleanOrderIdsArr = orderSplits.map(s => s.orderId);
    const orderDescriptions = [...new Set(orderSplits.map(s => s.description).filter((d): d is string => !!d))];
    const orderIdsStr = cleanOrderIdsArr.join(", ");
    const orderCount = cleanOrderIdsArr.length;
    // Discord title max 256 char, field value max 1024 char.
    // Bulk PO bisa puluhan order → ringkas biar embed gak ditolak Discord.
    const orderTitleStr = orderCount > 5
      ? `${orderCount} order (${cleanOrderIdsArr.slice(0, 3).join(", ")}, …)`
      : orderIdsStr;
    const orderFieldStr = orderIdsStr.length > 1000
      ? `${orderCount} order:\n${orderIdsStr.slice(0, 980)}…`
      : orderIdsStr;
    const userNotesRaw = body.userNotes ?? body.user_notes ?? body.notes;
    const userNotes = userNotesRaw ? String(userNotesRaw) : "-";
    const adminNotesRaw = body.adminNotes ?? body.admin_notes;
    const adminNotes = adminNotesRaw ? String(adminNotesRaw) : "-";

    const combinedNotesForStore = [
      userNotes !== "-" ? `User: ${userNotes}` : "",
      adminNotes !== "-" ? `Admin: ${adminNotes}` : ""
    ].filter(Boolean).join(" | ") || "-";
    const proofType = String(body.proofType ?? body.type ?? "pick_proof").toLowerCase();
    const isPackProof = proofType.includes("pack");
    const isBypass = body.isBypass === true || proofType.includes("bypass");
    const actorLabel = isPackProof ? "Packer" : "Picker";
    const actorName = String(isPackProof ? (body.packer ?? body.picker ?? "-") : (body.picker ?? body.packer ?? "-"));
    const picker = actorName;
    const titlePrefix = isPackProof ? (isBypass ? "📦 Pack Proof Bypass" : "📦 Pack Proof") : "📸 Pick Proof";
    // Multi-foto: images[] (PDA ≥1.4.5), fallback imageBase64 tunggal (PDA lama).
    const imagesBase64: string[] = Array.isArray(body.images) && body.images.length > 0
      ? body.images.map(String).filter(Boolean)
      : body.imageBase64
      ? [String(body.imageBase64)]
      : [];
    const imageBase64 = imagesBase64[0] ?? "";

    // Bot Discord dibatasi ~8MB per attachment (beda dari limit user biasa) — cek di
    // sini biar gagalnya rapi (413), bukan crash mentah pas channel.send ke Discord.
    if (!logOnly) {
      for (const b64 of imagesBase64) {
        if (Buffer.byteLength(b64, "base64") > DISCORD_BOT_ATTACHMENT_LIMIT_BYTES) {
          throw new PayloadTooLargeError("Salah satu foto terlalu besar untuk diupload ke Discord (maks ~8MB).");
        }
      }
    }

    // logOnly mode: save to store untuk daily Excel report, skip Discord embed
    if (logOnly) {
      const requestedChannelIdLog = body.channelId ?? body.channel_id ?? body.targetChannelId ?? body.target_channel_id;
      const targetChannelIdLog = requestedChannelIdLog ? String(requestedChannelIdLog) : "1390221553333043200"; // default PICK_FISIK

      await addMachitanProof({
        timestamp: new Date().toISOString(),
        channelId: targetChannelIdLog,
        orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)],
        actor: picker,
        items: Array.isArray(body.items)
          ? body.items.map((item: any, index: number) => {
              const orderId = String(item?.invoiceNumber ?? item?.invoice_number ?? item?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-");
              return {
                orderId: orderId,
                orderItemId: item?.orderItemId != null ? String(item.orderItemId) : undefined,
                itemId: String(item?.itemId ?? item?.id ?? "-"),
                productName: String(item?.productName ?? item?.name ?? "Item"),
                qty: Number(item?.qty ?? item?.quantity ?? 1),
                source: String(item?.source ?? item?.pickRequestType ?? item?.requestType ?? "-").toUpperCase(),
                channel: item?.channel ? String(item.channel) : undefined,
                invoiceNumber: item?.invoiceNumber ? String(item.invoiceNumber) : undefined,
                originType: item?.originType ? String(item.originType) : (item?.pickRequestType ? String(item.pickRequestType) : undefined),
                rackName: item?.rackName ? String(item.rackName) : undefined,
                archiveReason: item?.archiveReason ? String(item.archiveReason) : undefined,
              };
            })
          : [],
        notes: combinedNotesForStore,
        imageBase64: "",
        proofType: String(body.proofType ?? body.type ?? "PICK_FISIK_LOG"),
      }).catch(err => console.error("Failed to save pick-log to store", err));

      return sendJson(response, 200, { message: "Pick log saved (no Discord embed)", ok: true, logOnly: true });
    }

    const requestedChannelId = body.channelId ?? body.channel_id ?? body.targetChannelId ?? body.target_channel_id;
    const targetChannelId = requestedChannelId ? String(requestedChannelId) : env.MACHITAN_PICK_PROOF_CHANNEL_ID;
    const itemSummary = Array.isArray(body.itemSummary)
      ? body.itemSummary.map((item: unknown) => String(item)).filter(Boolean)
      : [];
    const itemIds = Array.isArray(body.itemIds)
      ? body.itemIds.map((item: unknown) => String(item)).filter(Boolean)
      : [];
    const itemRows = Array.isArray(body.items)
      ? body.items.map((item: any, index: number) => {
        const itemId = item?.itemId ?? item?.id ?? "-";
        const orderItemId = item?.orderItemId ?? "-";
        const productName = item?.productName ?? item?.name ?? "Item";
        const qty = item?.qty ?? item?.quantity ?? "-";
        const source = String(item?.source ?? "-").toUpperCase();
        const orderIdRaw = item?.invoiceNumber ?? item?.invoice_number ?? item?.orderId;
        const resolvedId = String(orderIdRaw == null || orderIdRaw === 0 || orderIdRaw === "0" ? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-" : orderIdRaw);
        const orderId = resolvedId.includes(" ") || resolvedId.length > 30 ? (Array.isArray(body.orderIds) ? String(body.orderIds[index] ?? "-") : String(body.orderIds ?? "-")) : resolvedId;
        return [
          `${index + 1}. ${productName}`,
          `   Order: #${orderId} | Order Item: #${orderItemId} | Item: #${itemId}`,
          `   Qty: ${qty} | Source: ${source}`
        ].join("\n");
      }).filter(Boolean)
      : [];
    const detailRows = itemRows.length ? itemRows : itemSummary;
    const itemDetails = detailRows.length
      ? detailRows.slice(0, 6).join("\n").slice(0, 1024)
      : (itemIds.length ? itemIds.join(", ").slice(0, 1024) : "-");

    const ecommerceRows = Array.isArray(body.items)
      ? body.items.map((item: any, index: number) => ({ item, index })).filter(({ item }: { item: any }) => isEcommerceProofItem(item))
      : [];

    if (!isPackProof && ecommerceRows.length > 0) {
      const channel = await client.channels.fetch(ECOM_PICK_PROOF_CHANNEL_ID);
      if (!channel || !channel.isTextBased() || !("send" in channel)) {
        throw new Error(`Cannot send to channel ${ECOM_PICK_PROOF_CHANNEL_ID}`);
      }

      const imageBuffer = Buffer.from(imageBase64, "base64");
      for (const { item, index } of ecommerceRows) {
        const rawOrderId = String(item?.invoiceNumber ?? item?.invoice_number ?? item?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-");
        const { orderId, description } = splitOrderDescription(rawOrderId);
        const itemId = String(item?.itemId ?? item?.id ?? "-");
        const productName = String(item?.productName ?? item?.name ?? "E-Commerce item");
        const qty = String(item?.qty ?? item?.quantity ?? "-");
        const source = String(item?.source ?? "-").toUpperCase();
        const channelName = inferEcommerceChannel(orderId, item);
        const attachmentName = `ecom_pick_proof_${index + 1}.jpg`;
        const attachment = new AttachmentBuilder(imageBuffer, { name: attachmentName });
        const embed = new EmbedBuilder()
          .setColor(0x00c853)
          .setTitle(productName.slice(0, 256))
          .addFields(
            { name: "Order ID", value: orderId, inline: true },
            { name: actorLabel, value: picker, inline: true },
            ...(description ? [{ name: "Deskripsi", value: description.slice(0, 1024), inline: true }] : []),
            { name: "User Notes", value: userNotes.slice(0, 1024), inline: !isPackProof },
            ...(adminNotes !== "-" ? [{ name: "Admin Notes", value: adminNotes.slice(0, 1024), inline: !isPackProof }] : []),
            ...(isPackProof ? [{ name: "Status", value: "Diproses ke RESI Fulfillment", inline: true }] : []),
            { name: "Items", value: `Item: #${itemId} | Qty: ${qty} | Source: ${source}`, inline: false }
          )
          .setImage(`attachment://${attachmentName}`)
          .setTimestamp();

        const url = itemKyouUrl(itemId);
        if (url) embed.setURL(url);
        if (body.submittedAt) embed.setFooter({ text: String(body.submittedAt) });

        await channel.send({
          content: mentionForEcommerce(channelName),
          embeds: [embed],
          files: [attachment]
        });
      }

      // Foto tambahan (multi-foto) cukup dikirim sekali, bukan diulang per item.
      if (imagesBase64.length > 1) {
        const extraAttachments = imagesBase64.slice(1).map((b64, i) =>
          new AttachmentBuilder(Buffer.from(b64, "base64"), { name: `ecom_pick_proof_extra_${i + 2}.jpg` })
        );
        for (let i = 0; i < extraAttachments.length; i += 10) {
          await channel.send({
            content: i === 0 ? `📷 Foto tambahan (Order #${orderTitleStr})` : undefined,
            files: extraAttachments.slice(i, i + 10)
          });
        }
      }

      // Save to local store for daily excel export
      addMachitanProof({
        timestamp: new Date().toISOString(),
        channelId: ECOM_PICK_PROOF_CHANNEL_ID,
        orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)],
        actor: picker,
        items: ecommerceRows.map(({ item, index }: any) => {
           const rawOrderId = String(item?.invoiceNumber ?? item?.invoice_number ?? item?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-");
           const { orderId, description } = splitOrderDescription(rawOrderId);
           return {
             orderId: orderId,
             orderItemId: item?.orderItemId != null ? String(item.orderItemId) : undefined,
             itemId: String(item?.itemId ?? item?.id ?? "-"),
             productName: String(item?.productName ?? item?.name ?? "E-Commerce item"),
             qty: Number(item?.qty ?? item?.quantity ?? 1),
             source: String(item?.source ?? item?.pickRequestType ?? item?.requestType ?? "-"),
             channel: item?.channel ? String(item.channel) : undefined,
             invoiceNumber: orderId,
             description: description ?? undefined,
             originType: item?.originType ? String(item.originType) : (item?.pickRequestType ? String(item.pickRequestType) : undefined),
           };
        }),
        notes: combinedNotesForStore,
        imageBase64: imageBase64,
        proofType: String(body.proofType ?? body.type ?? "ECOM_PHYSICAL_PICK_PROOF"),
      }).catch(err => console.error("Failed to save e-com proof to store", err));

      return sendJson(response, 200, {
        message: "E-commerce pick proof received and sent to Discord",
        ok: true,
        channelId: ECOM_PICK_PROOF_CHANNEL_ID,
        count: ecommerceRows.length
      });
    }

    // Semua foto jadi attachment; embed menampilkan foto pertama, sisanya tampil
    // sebagai attachment tambahan di pesan yang sama.
    const proofBaseName = isPackProof ? "pack_proof" : "pick_proof";
    const attachments = imagesBase64.map((b64, i) =>
      new AttachmentBuilder(Buffer.from(b64, "base64"), { name: i === 0 ? `${proofBaseName}.jpg` : `${proofBaseName}_${i + 1}.jpg` })
    );
    const photoLabel = imagesBase64.length > 1 ? ` · ${imagesBase64.length} foto` : "";

    // Create Embed
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle(`${titlePrefix}: Order #${orderTitleStr}${photoLabel}`)
      .addFields(
        { name: "Order ID", value: orderFieldStr, inline: true },
        { name: actorLabel, value: picker, inline: true },
        ...(orderDescriptions.length ? [{ name: "Deskripsi", value: orderDescriptions.join(", ").slice(0, 1024), inline: true }] : []),
        { name: "User Notes", value: userNotes.slice(0, 1024), inline: !isPackProof },
        ...(adminNotes !== "-" ? [{ name: "Admin Notes", value: adminNotes.slice(0, 1024), inline: !isPackProof }] : []),
        ...(isPackProof ? [{ name: "Status", value: "Diproses ke RESI Fulfillment", inline: true }] : []),
        { name: "Items", value: itemDetails, inline: false }
      )
      .setImage(isPackProof ? "attachment://pack_proof.jpg" : "attachment://pick_proof.jpg")
      .setTimestamp();

    if (!targetChannelId) {
      throw new Error("MACHITAN_PICK_PROOF_CHANNEL_ID wajib diisi atau kirim channelId di payload.");
    }

    const channel = await client.channels.fetch(targetChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Cannot send to channel ${targetChannelId}`);
    }

    let mentionContent = "";
    if (isPackProof && ecommerceRows.length > 0) {
      const ecomItem = ecommerceRows[0].item;
      const orderId = String(ecomItem?.invoiceNumber ?? ecomItem?.invoice_number ?? ecomItem?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[0] : body.orderIds) ?? "-");
      const channelName = inferEcommerceChannel(orderId, ecomItem);
      mentionContent = mentionForEcommerce(channelName);
    }

    // Discord max 10 file per pesan — chunk kalau lebih (jaga-jaga).
    const fileChunks: (typeof attachments)[] = [];
    for (let i = 0; i < attachments.length; i += 10) {
      fileChunks.push(attachments.slice(i, i + 10));
    }
    await channel.send({
      content: mentionContent ? mentionContent : undefined,
      embeds: [embed],
      files: fileChunks[0]
    });
    for (let i = 1; i < fileChunks.length; i++) {
      await channel.send({ files: fileChunks[i] });
    }

    // Save to local store for daily excel export
    addMachitanProof({
      timestamp: new Date().toISOString(),
      channelId: targetChannelId,
      orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)],
      actor: picker,
      items: Array.isArray(body.items) && body.items.length > 0
        ? body.items.map((item: any, index: number) => {
            const split = splitOrderDescription(item?.invoiceNumber ?? item?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-");
            return {
              orderId: split.orderId,
              orderItemId: item?.orderItemId != null ? String(item.orderItemId) : undefined,
              itemId: String(item?.itemId ?? item?.id ?? "-"),
              productName: String(item?.productName ?? item?.name ?? "Item"),
              qty: Number(item?.qty ?? item?.quantity ?? 1),
              source: String(item?.source ?? item?.pickRequestType ?? item?.requestType ?? "-"),
              channel: item?.channel ? String(item.channel) : undefined,
              invoiceNumber: item?.invoiceNumber ? split.orderId : undefined,
              description: split.description ?? undefined,
              originType: item?.originType ? String(item.originType) : (item?.pickRequestType ? String(item.pickRequestType) : undefined),
              packLocation: item?.packLocation ? String(item.packLocation) : (body?.packLocation ? String(body.packLocation) : undefined),
              rackName: item?.rackName ? String(item.rackName) : undefined,
            };
          })
        : (Array.isArray(body.orderIds) ? body.orderIds.map((oId: any) => ({
            orderId: String(oId),
            itemId: "-",
            productName: "Proof Item",
            qty: 1,
            source: "-"
          })) : [{
            orderId: String(body.orderIds),
            itemId: "-",
            productName: "Proof Item",
            qty: 1,
            source: "-"
          }]),
      notes: combinedNotesForStore,
      imageBase64: imageBase64,
      proofType: String(body.proofType ?? body.type ?? "PICK_PROOF"),
      isBypass: isBypass,
      bypassReason: body.bypassReason ? String(body.bypassReason) : undefined,
    }).catch(err => console.error("Failed to save proof to store", err));


    sendJson(response, 200, { message: "Photo received and sent to Discord", ok: true, channelId: targetChannelId });
  } catch (error) {
    console.error("Machitan Pick Proof Intake Error:", error);
    if (error instanceof PayloadTooLargeError) {
      return sendJson(response, 413, { error: error.message, ok: false });
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}



