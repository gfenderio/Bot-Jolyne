import cron from "node-cron";
import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { getAndClearMachitanProofs, MachitanProofPayload, MachitanProofItem } from "./proofStore.js";

const TARGET_CHANNEL_ID = "1501899831268868106";
const MARK_PICK_CHANNEL = "1418827227264450663";
const PICK_FISIK_CHANNEL = "1390221553333043200";
const PACK_PROOF_CHANNEL = "1209860901914677368";

type SheetKind = "pick_fisik" | "mark_pick" | "pack";

interface SheetTheme {
  title: string;
  headerColor: string;
  accentColor: string;
  actorLabel: string;
}

const SHEET_THEMES: Record<SheetKind, SheetTheme> = {
  pick_fisik: { title: "Pick Fisik Log",         headerColor: "FF1B5E20", accentColor: "FFE8F5E9", actorLabel: "Picker" },
  mark_pick:  { title: "Mark Pick Log",          headerColor: "FF0D47A1", accentColor: "FFE3F2FD", actorLabel: "Picker" },
  pack:       { title: "Pack Log",               headerColor: "FF4A148C", accentColor: "FFF3E5F5", actorLabel: "Packer" },
};

function jakartaDateParts(iso: string): { tanggal: string; jam: string } {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return { tanggal: dateStr, jam: timeStr };
}

function sourceFillColor(source: string): string | null {
  const s = source.toUpperCase();
  if (s.includes("UREQ")) return "FFFFF8E1";
  if (s.includes("GIFT")) return "FFFCE4EC";
  if (s.includes("ECOM") || s.includes("E-COM") || s.includes("OUTSIDE")) return "FFE0F7FA";
  if (s.includes("B2B") || s.includes("PARTNER")) return "FFF3E5F5";
  if (s === "BEKASI" || s === "TANGERANG" || s === "SURABAYA") return "FFE8F5E9";
  return null;
}

function itemKyouUrl(itemId?: string): string | null {
  if (!itemId || itemId === "-" || !/^\d+$/.test(itemId)) return null;
  return `https://kyou.id/items/${encodeURIComponent(itemId)}`;
}

function flattenItems(proofs: MachitanProofPayload[]): Array<MachitanProofItem & { _proof: MachitanProofPayload }> {
  const rows: Array<MachitanProofItem & { _proof: MachitanProofPayload }> = [];
  for (const p of proofs) {
    const items = Array.isArray(p.items) && p.items.length > 0
      ? p.items
      : p.orderIds.map(oId => ({ orderId: oId, itemId: "-", productName: "Proof Item", qty: 1, source: "-" } as MachitanProofItem));
    for (const it of items) rows.push({ ...it, _proof: p });
  }
  return rows;
}

function buildSheet(workbook: ExcelJS.Workbook, kind: SheetKind, proofs: MachitanProofPayload[], reportDateStr: string) {
  const theme = SHEET_THEMES[kind];
  const sheet = workbook.addWorksheet(theme.title, {
    views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 22 },
  });

  // ── Title block (rows 1-3) ─────────────────────────────────────────────────
  sheet.mergeCells("A1:J1");
  const titleCell = sheet.getCell("A1");
  titleCell.value = `${theme.title} — ${reportDateStr}`;
  titleCell.font = { name: "Segoe UI Semibold", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.headerColor } };
  sheet.getRow(1).height = 32;

  const flatRows = flattenItems(proofs);
  const uniquePickers = new Set(flatRows.map(r => r._proof.actor)).size;
  const uniqueOrders = new Set(flatRows.map(r => r.orderId).filter(Boolean)).size;
  const totalQty = flatRows.reduce((sum, r) => sum + (Number(r.qty) || 0), 0);

  sheet.mergeCells("A2:J2");
  const summaryCell = sheet.getCell("A2");
  summaryCell.value = `Total Item: ${flatRows.length}    Total Qty: ${totalQty}    Unique Orders: ${uniqueOrders}    Unique ${theme.actorLabel}: ${uniquePickers}`;
  summaryCell.font = { name: "Segoe UI", size: 10, color: { argb: "FF424242" }, italic: true };
  summaryCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  summaryCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.accentColor } };
  sheet.getRow(2).height = 22;

  sheet.getRow(3).height = 6; // spacer

  // ── Column definitions ─────────────────────────────────────────────────────
  const baseColumns: Array<Partial<ExcelJS.Column> & { key: string; header: string }> = [
    { header: "Tanggal",       key: "tanggal",      width: 12 },
    { header: "Jam (WIB)",     key: "jam",          width: 11 },
    { header: theme.actorLabel, key: "actor",       width: 22 },
    { header: "Order / Invoice", key: "orderId",    width: 20 },
    { header: "Order Item ID", key: "orderItemId",  width: 14 },
    { header: "Item ID",       key: "itemId",       width: 12 },
    { header: "Nama Barang",   key: "productName",  width: 48 },
    { header: "Qty",           key: "qty",          width: 8 },
    { header: "Source",        key: "source",       width: 14 },
    { header: "Catatan",       key: "notes",        width: 28 },
  ];

  // Pack sheet swaps "Source" for combined "Pack Location / Rack"
  if (kind === "pack") {
    baseColumns[8] = { header: "Lokasi Pack / Rack", key: "source", width: 22 };
  }

  // Mark Pick adds channel info merged into source if available — handled at row time
  sheet.columns = baseColumns;

  // ── Header row (row 4) ─────────────────────────────────────────────────────
  const headerRow = sheet.getRow(4);
  headerRow.font = { name: "Segoe UI", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.headerColor } };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };
  headerRow.height = 28;
  headerRow.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = {
      top: { style: "medium", color: { argb: theme.headerColor } },
      bottom: { style: "medium", color: { argb: theme.headerColor } },
      left: { style: "thin", color: { argb: "FFE0E0E0" } },
      right: { style: "thin", color: { argb: "FFE0E0E0" } },
    };
  });
  headerRow.commit();

  // ── Data rows ──────────────────────────────────────────────────────────────
  let rowIndex = 0;
  for (const r of flatRows) {
    const { tanggal, jam } = jakartaDateParts(r._proof.timestamp);
    const orderDisplay = r.invoiceNumber && r.invoiceNumber !== "-" ? r.invoiceNumber : (r.orderId || r._proof.orderIds.join(", ") || "-");
    const sourceValue = kind === "pack"
      ? [r.packLocation, r.rackName].filter(Boolean).join(" / ") || r.source || "-"
      : (r.channel ? `${r.source} · ${r.channel}` : r.source);

    const row = sheet.addRow({
      tanggal,
      jam,
      actor: r._proof.actor || "-",
      orderId: String(orderDisplay),
      orderItemId: r.orderItemId || "-",
      itemId: r.itemId || "-",
      productName: r.productName || "Item",
      qty: Number(r.qty) || 0,
      source: sourceValue,
      notes: r._proof.notes || "-",
    });
    rowIndex++;
    row.height = 26;
    row.font = { name: "Segoe UI", size: 10 };
    row.alignment = { vertical: "middle", wrapText: false };

    // Hyperlink productName ke Kyou item URL kalau itemId numeric
    const productCell = row.getCell("productName");
    const url = itemKyouUrl(r.itemId);
    if (url) {
      productCell.value = { text: r.productName || "Item", hyperlink: url };
      productCell.font = { name: "Segoe UI", size: 10, color: { argb: "FF1565C0" }, underline: true };
    }
    productCell.alignment = { vertical: "middle", wrapText: true };

    // Qty number format
    row.getCell("qty").numFmt = "#,##0";
    row.getCell("qty").alignment = { vertical: "middle", horizontal: "center" };

    // Source color
    const sourceColor = sourceFillColor(sourceValue);
    if (sourceColor) {
      row.getCell("source").fill = { type: "pattern", pattern: "solid", fgColor: { argb: sourceColor } };
      row.getCell("source").font = { name: "Segoe UI Semibold", size: 10, bold: true };
    }

    // Zebra stripe (alternating background)
    if (rowIndex % 2 === 0) {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (!cell.fill || (cell.fill as any).type !== "pattern") {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFAFA" } };
        }
      });
    }

    // Borders
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.border = {
        top: { style: "hair", color: { argb: "FFE0E0E0" } },
        left: { style: "hair", color: { argb: "FFE0E0E0" } },
        bottom: { style: "hair", color: { argb: "FFE0E0E0" } },
        right: { style: "hair", color: { argb: "FFE0E0E0" } },
      };
    });
  }

  // ── Empty state ────────────────────────────────────────────────────────────
  if (rowIndex === 0) {
    sheet.mergeCells(`A5:J5`);
    const emptyCell = sheet.getCell("A5");
    emptyCell.value = `Tidak ada data ${theme.title} untuk tanggal ${reportDateStr}.`;
    emptyCell.font = { name: "Segoe UI", size: 11, italic: true, color: { argb: "FF9E9E9E" } };
    emptyCell.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(5).height = 40;
  } else {
    // AutoFilter on header row
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: 4, column: baseColumns.length },
    };
  }
}

export function startMachitanDailyReportScheduler(client: Client<true>) {
  cron.schedule("0 0 * * *", async () => {
    try {
      console.log("[DailyReport] Running Machitan Daily Report Scheduler...");
      const proofs = await getAndClearMachitanProofs();

      if (proofs.length === 0) {
        console.log("[DailyReport] No proofs to report today.");
        return;
      }

      const pickFisiks = proofs.filter(p => p.channelId === PICK_FISIK_CHANNEL);
      const markPicks  = proofs.filter(p => p.channelId === MARK_PICK_CHANNEL);
      const packProofs = proofs.filter(p => p.channelId === PACK_PROOF_CHANNEL);
      const others     = proofs.filter(p => ![MARK_PICK_CHANNEL, PICK_FISIK_CHANNEL, PACK_PROOF_CHANNEL].includes(p.channelId));
      pickFisiks.push(...others);

      const todayStr = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric" });

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Bot Jolyne";
      workbook.created = new Date();
      workbook.title = `Rekap Warehouse Machitan — ${todayStr}`;

      buildSheet(workbook, "pick_fisik", pickFisiks, todayStr);
      buildSheet(workbook, "mark_pick",  markPicks,  todayStr);
      buildSheet(workbook, "pack",       packProofs, todayStr);

      const buffer = await workbook.xlsx.writeBuffer();

      const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
      if (!channel || !channel.isTextBased()) {
        console.error("[DailyReport] Cannot fetch target channel");
        return;
      }

      const fileName = `Rekap_Warehouse_${todayStr.replace(/ /g, "_")}.xlsx`;
      const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: fileName });

      const totalItems = (proofs as MachitanProofPayload[]).reduce((sum, p) => sum + (Array.isArray(p.items) ? p.items.length : 0), 0);

      const embed = new EmbedBuilder()
        .setColor(0x2E7D32)
        .setTitle(`📊 Rekap Harian Warehouse — ${todayStr}`)
        .setDescription(`File Excel berisi 3 sheet terpisah: **Pick Fisik**, **Mark Pick**, dan **Pack**. Setiap baris = 1 item. Klik nama produk untuk buka di Kyou.`)
        .addFields(
          { name: "📦 Pick Fisik",         value: `${pickFisiks.length} proof`, inline: true },
          { name: "📝 Mark Pick",          value: `${markPicks.length} proof`,  inline: true },
          { name: "✅ Pack",                value: `${packProofs.length} proof`, inline: true },
          { name: "Total Item Rows",       value: `${totalItems}`,              inline: true },
        )
        .setFooter({ text: `Generated ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB · Auto-cron 00:00` })
        .setTimestamp();

      await (channel as TextChannel).send({ embeds: [embed], files: [attachment] });
      console.log(`[DailyReport] Sent daily report for ${todayStr} (${totalItems} item rows)`);
    } catch (e) {
      console.error("[DailyReport] Error:", e);
    }
  });
}
