import type { IncomingMessage, ServerResponse } from "node:http";
import { AttachmentBuilder, Client, EmbedBuilder } from "discord.js";
import { env } from "../config/env.js";
import { addMachitanProof } from "./proofStore.js";

const ECOM_PICK_PROOF_CHANNEL_ID = "1390221553333043200";
const SHOPEE_MENTION = "<@804685637252939788>";
const TOKOPEDIA_MENTION = "<@833000054880206888>";

function isEcommerceProofItem(item: any) {
  const origin = String(item?.originType ?? item?.pickRequestType ?? item?.requestType ?? "").toLowerCase();
  return origin.includes("e-com") || origin.includes("ecommerce") || origin.includes("outside");
}

function inferEcommerceChannel(orderId: string, item: any) {
  const explicit = String(item?.channel ?? item?.ecommerce ?? item?.marketplace ?? "").toLowerCase();
  if (explicit.includes("shopee")) return "Shopee";
  if (explicit.includes("tokopedia") || explicit.includes("toped")) return "Tokopedia";
  if (/^\d+$/.test(orderId) && orderId.length >= 12) return "Tokopedia";
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


// Helper for sending JSON response
function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function readRequestBody(request: IncomingMessage, maxBytes = 5 * 1024 * 1024) {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body, "utf8") > maxBytes) {
      throw new Error("Payload terlalu besar.");
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

    if (!body.orderIds || !body.picker || (!logOnly && !body.imageBase64)) {
      return sendJson(response, 400, { error: "Missing required fields", ok: false });
    }

    const orderIdsStr = Array.isArray(body.orderIds) ? body.orderIds.join(", ") : String(body.orderIds);
    const notes = body.notes ? String(body.notes) : "-";
    const proofType = String(body.proofType ?? body.type ?? "pick_proof").toLowerCase();
    const isPackProof = proofType.includes("pack");
    const isBypass = body.isBypass === true || proofType.includes("bypass");
    const actorLabel = isPackProof ? "Packer" : "Picker";
    const actorName = String(isPackProof ? (body.packer ?? body.picker ?? "-") : (body.picker ?? body.packer ?? "-"));
    const picker = actorName;
    const titlePrefix = isPackProof ? (isBypass ? "📦 Pack Proof Bypass" : "📦 Pack Proof") : "📸 Pick Proof";
    const imageBase64 = String(body.imageBase64 ?? "");

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
                source: (() => { const s = String(item?.source ?? item?.pickRequestType ?? item?.requestType ?? "-").toUpperCase(); return (s === "GIFT" || s === "UREQ" || s === "REGULAR_ORDER" || s === "") ? "BEKASI" : s; })(),
                channel: item?.channel ? String(item.channel) : undefined,
                invoiceNumber: item?.invoiceNumber ? String(item.invoiceNumber) : undefined,
                originType: item?.originType ? String(item.originType) : (item?.pickRequestType ? String(item.pickRequestType) : undefined),
                rackName: item?.rackName ? String(item.rackName) : undefined,
                archiveReason: item?.archiveReason ? String(item.archiveReason) : undefined,
              };
            })
          : [],
        notes: notes,
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
        const rawSource = String(item?.source ?? "-").toUpperCase();
        const source = (rawSource === "GIFT" || rawSource === "UREQ" || rawSource === "REGULAR_ORDER" || rawSource === "") ? "BEKASI" : rawSource;
        const orderIdRaw = item?.invoiceNumber ?? item?.invoice_number ?? item?.orderId;
        const orderId = String(orderIdRaw == null || orderIdRaw === 0 || orderIdRaw === "0" ? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-" : orderIdRaw);
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
        const orderId = String(item?.invoiceNumber ?? item?.invoice_number ?? item?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-");
        const itemId = String(item?.itemId ?? item?.id ?? "-");
        const productName = String(item?.productName ?? item?.name ?? "E-Commerce item");
        const qty = String(item?.qty ?? item?.quantity ?? "-");
        const rawSource2 = String(item?.source ?? "-").toUpperCase();
        const source = (rawSource2 === "GIFT" || rawSource2 === "UREQ" || rawSource2 === "REGULAR_ORDER" || rawSource2 === "") ? "BEKASI" : rawSource2;
        const channelName = inferEcommerceChannel(orderId, item);
        const attachmentName = `ecom_pick_proof_${index + 1}.jpg`;
        const attachment = new AttachmentBuilder(imageBuffer, { name: attachmentName });
        const embed = new EmbedBuilder()
          .setColor(0x00c853)
          .setTitle(productName.slice(0, 256))
          .addFields(
            { name: "Order ID", value: orderId, inline: true },
            { name: actorLabel, value: picker, inline: true },
            { name: "Notes", value: notes.slice(0, 1024), inline: !isPackProof },
            ...(isPackProof ? [{ name: "Status", value: "Diproses ke RESI Fulfillment", inline: true }] : []),
            { name: "Items", value: `Qty: ${qty} | Source: ${source}`, inline: false }
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

      // Save to local store for daily excel export
      addMachitanProof({
        timestamp: new Date().toISOString(),
        channelId: ECOM_PICK_PROOF_CHANNEL_ID,
        orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)],
        actor: picker,
        items: ecommerceRows.map(({ item, index }: any) => {
           const orderId = String(item?.invoiceNumber ?? item?.invoice_number ?? item?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-");
           return {
             orderId: orderId,
             orderItemId: item?.orderItemId != null ? String(item.orderItemId) : undefined,
             itemId: String(item?.itemId ?? item?.id ?? "-"),
             productName: String(item?.productName ?? item?.name ?? "E-Commerce item"),
             qty: Number(item?.qty ?? item?.quantity ?? 1),
             source: String(item?.source ?? item?.pickRequestType ?? item?.requestType ?? "-"),
             channel: item?.channel ? String(item.channel) : undefined,
             invoiceNumber: item?.invoiceNumber ? String(item.invoiceNumber) : undefined,
             originType: item?.originType ? String(item.originType) : (item?.pickRequestType ? String(item.pickRequestType) : undefined),
           };
        }),
        notes: notes,
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

    // Convert Base64 back to buffer
    const imageBuffer = Buffer.from(imageBase64, "base64");
    
    // Create Attachment
    const attachment = new AttachmentBuilder(imageBuffer, { name: isPackProof ? "pack_proof.jpg" : "pick_proof.jpg" });

    // Create Embed
    const embed = new EmbedBuilder()
      .setColor(0x00ff00)
      .setTitle(`${titlePrefix}: Order #${orderIdsStr}`)
      .addFields(
        { name: "Order ID", value: orderIdsStr, inline: true },
        { name: actorLabel, value: picker, inline: true },
        { name: "Notes", value: notes.slice(0, 1024), inline: !isPackProof },
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

    await channel.send({
      content: mentionContent ? mentionContent : undefined,
      embeds: [embed],
      files: [attachment]
    });

    // Save to local store for daily excel export
    addMachitanProof({
      timestamp: new Date().toISOString(),
      channelId: targetChannelId,
      orderIds: Array.isArray(body.orderIds) ? body.orderIds.map(String) : [String(body.orderIds)],
      actor: picker,
      items: Array.isArray(body.items) && body.items.length > 0
        ? body.items.map((item: any, index: number) => {
            const orderId = String(item?.orderId ?? (Array.isArray(body.orderIds) ? body.orderIds[index] : body.orderIds) ?? "-");
            return {
              orderId: orderId,
              orderItemId: item?.orderItemId != null ? String(item.orderItemId) : undefined,
              itemId: String(item?.itemId ?? item?.id ?? "-"),
              productName: String(item?.productName ?? item?.name ?? "Item"),
              qty: Number(item?.qty ?? item?.quantity ?? 1),
              source: String(item?.source ?? item?.pickRequestType ?? item?.requestType ?? "-"),
              channel: item?.channel ? String(item.channel) : undefined,
              invoiceNumber: item?.invoiceNumber ? String(item.invoiceNumber) : undefined,
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
      notes: notes,
      imageBase64: imageBase64,
      proofType: String(body.proofType ?? body.type ?? "PICK_PROOF"),
      isBypass: isBypass,
      bypassReason: body.bypassReason ? String(body.bypassReason) : undefined,
    }).catch(err => console.error("Failed to save proof to store", err));

    sendJson(response, 200, { message: "Photo received and sent to Discord", ok: true, channelId: targetChannelId });
  } catch (error) {
    console.error("Machitan Pick Proof Intake Error:", error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : "Internal Server Error", ok: false });
  }
}



