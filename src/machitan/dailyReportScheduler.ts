import cron from "node-cron";
import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { getAndClearMachitanProofs, MachitanProofPayload, MachitanProofItem } from "./proofStore.js";
import { getAndClearWsInboxProofs, WsInboxProofPayload } from "./wsInboxStore.js";

const TARGET_CHANNEL_ID = "1501899831268868106";
const MARK_PICK_CHANNEL = "1418827227264450663";
const PICK_FISIK_CHANNEL = "1390221553333043200";
const PACK_PROOF_CHANNEL = "1209860901914677368";

type SheetKind = "pick_fisik" | "mark_pick" | "pack" | "archive" | "ws_opname";

interface SheetTheme {
  title: string;
  headerColor: string;
  accentColor: string;
  actorLabel: string;
}

const SHEET_THEMES: Record<SheetKind, SheetTheme> = {
  pick_fisik: { title: "Pick Fisik Log",  headerColor: "FF1B5E20", accentColor: "FFE8F5E9", actorLabel: "Picker"   },
  mark_pick:  { title: "Mark Pick Log",   headerColor: "FF0D47A1", accentColor: "FFE3F2FD", actorLabel: "Picker"   },
  pack:       { title: "Pack Log",        headerColor: "FF4A148C", accentColor: "FFF3E5F5", actorLabel: "Packer"   },
  archive:    { title: "Archive Log",     headerColor: "FFBF360C", accentColor: "FFFFE0B2", actorLabel: "Archiver" },
  ws_opname:  { title: "WS Opname Log",   headerColor: "FF1A237E", accentColor: "FFE8EAF6", actorLabel: "Staff"    },
};

function isArchiveProof(p: MachitanProofPayload): boolean {
  return String(p.proofType ?? "").toUpperCase().includes("ARCHIVE");
}

function jakartaDateParts(iso: string): { tanggal: string; jam: string } {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return { tanggal: dateStr, jam: timeStr };
}

function typeFillColor(tipe: string): string | null {
  const t = tipe.toUpperCase();
  if (t.includes("UREQ")) return "FFFFF8E1";       // amber
  if (t.includes("GIFT")) return "FFFCE4EC";       // pink
  if (t.includes("E-COM") || t.includes("ECOM")) return "FFE0F7FA"; // cyan
  if (t.includes("B2B")) return "FFF3E5F5";        // purple
  if (t === "REGULER" || t === "REGULAR") return "FFF5F5F5"; // neutral grey
  // Archive reasons
  if (t.includes("TIDAK KETEMU")) return "FFFFEBEE"; // light red
  if (t.includes("SALAH")) return "FFFFF3E0";        // orange
  if (t.includes("PINDAH RAK")) return "FFE8F5E9";   // light green
  if (t.includes("LAIN")) return "FFEEEEEE";         // light grey
  return null;
}

function classifyType(item: MachitanProofItem): string {
  const origin = String(item.originType ?? "").toLowerCase();
  const source = String(item.source ?? "").toUpperCase();

  if (origin.includes("ureq") || source === "UREQ") return "UReq";
  if (origin.includes("gift") || source === "GIFT") return "Gift";
  if (item.channel && item.channel.trim().length > 0) {
    const ch = item.channel.toLowerCase();
    if (ch.includes("shopee")) return "E-COM (Shopee)";
    if (ch.includes("tokopedia") || ch.includes("toped")) return "E-COM (Tokopedia)";
    return `E-COM (${item.channel})`;
  }
  if (origin.includes("ecom") || origin.includes("e-com") || origin.includes("outside")) return "E-COM";
  if (origin.includes("b2b") || origin.includes("partner")) return "B2B";
  return "Reguler";
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

export function buildSheet(workbook: ExcelJS.Workbook, kind: SheetKind, proofs: MachitanProofPayload[], reportDateStr: string) {
  const theme = SHEET_THEMES[kind];
  const sheet = workbook.addWorksheet(theme.title, {
    views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 22 },
  });

  // ── Title block (rows 1-3) ─────────────────────────────────────────────────
  sheet.mergeCells("A1:K1");
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

  sheet.mergeCells("A2:K2");
  const summaryCell = sheet.getCell("A2");
  summaryCell.value = `Total Item: ${flatRows.length}    Total Qty: ${totalQty}    Unique Orders: ${uniqueOrders}    Unique ${theme.actorLabel}: ${uniquePickers}`;
  summaryCell.font = { name: "Segoe UI", size: 10, color: { argb: "FF424242" }, italic: true };
  summaryCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  summaryCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.accentColor } };
  sheet.getRow(2).height = 22;

  sheet.getRow(3).height = 6; // spacer

  // ── Column definitions ─────────────────────────────────────────────────────
  const baseColumns: Array<Partial<ExcelJS.Column> & { key: string; header: string }> = [
    { header: "Tanggal",         key: "tanggal",      width: 12 },
    { header: "Jam (WIB)",       key: "jam",          width: 11 },
    { header: theme.actorLabel,  key: "actor",        width: 22 },
    { header: "Order / Invoice", key: "orderId",      width: 22 },
    { header: "Order Item ID",   key: "orderItemId",  width: 14 },
    { header: "Item ID",         key: "itemId",       width: 11 },
    { header: "Nama Barang",     key: "productName",  width: 46 },
    { header: "Qty",             key: "qty",          width: 7  },
    { header: "Tipe",            key: "tipe",         width: 18 },
    { header: "Source",          key: "source",       width: 14 },
    { header: "Catatan",         key: "notes",        width: 28 },
  ];

  // Pack sheet uses "Lokasi Pack / Rack" instead of plain Source
  if (kind === "pack") {
    baseColumns[9] = { header: "Lokasi Pack / Rack", key: "source", width: 22 };
  }
  // Archive sheet: kolom "Tipe" jadi "Alasan Arsip", "Source" tetap source asal
  if (kind === "archive") {
    baseColumns[8] = { header: "Alasan Arsip", key: "tipe", width: 22 };
  }

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
    const tipe = kind === "archive"
      ? (r.archiveReason || "Lain-lain")
      : classifyType(r);
    const sourceValue = kind === "pack"
      ? ([r.packLocation, r.rackName].filter(Boolean).join(" / ") || r.source || "-")
      : (r.source || "-");

    const row = sheet.addRow({
      tanggal,
      jam,
      actor: r._proof.actor || "-",
      orderId: String(orderDisplay),
      orderItemId: r.orderItemId || "-",
      itemId: r.itemId || "-",
      productName: r.productName || "Item",
      qty: Number(r.qty) || 0,
      tipe,
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

    // Tipe color badge
    const tipeColor = typeFillColor(tipe);
    if (tipeColor) {
      row.getCell("tipe").fill = { type: "pattern", pattern: "solid", fgColor: { argb: tipeColor } };
      row.getCell("tipe").font = { name: "Segoe UI Semibold", size: 10, bold: true };
      row.getCell("tipe").alignment = { vertical: "middle", horizontal: "center" };
    }

    // Source plain bold
    row.getCell("source").font = { name: "Segoe UI Semibold", size: 10, bold: true };
    row.getCell("source").alignment = { vertical: "middle", horizontal: "center" };

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
    sheet.mergeCells(`A5:K5`);
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

export async function generateMachitanReportWorkbook(proofs: MachitanProofPayload[], todayStr: string): Promise<{ buffer: ArrayBuffer; pickFisiks: MachitanProofPayload[]; markPicks: MachitanProofPayload[]; packProofs: MachitanProofPayload[]; archives: MachitanProofPayload[]; }> {
  const archives   = proofs.filter(p => isArchiveProof(p));
  const regular    = proofs.filter(p => !isArchiveProof(p));

  const pickFisiks = regular.filter(p => p.channelId === PICK_FISIK_CHANNEL);
  const markPicks  = regular.filter(p => p.channelId === MARK_PICK_CHANNEL);
  const packProofs = regular.filter(p => p.channelId === PACK_PROOF_CHANNEL);
  const others     = regular.filter(p => ![MARK_PICK_CHANNEL, PICK_FISIK_CHANNEL, PACK_PROOF_CHANNEL].includes(p.channelId));
  pickFisiks.push(...others);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bot Jolyne";
  workbook.created = new Date();
  workbook.title = `Rekap Warehouse Machitan — ${todayStr}`;

  buildSheet(workbook, "pick_fisik", pickFisiks, todayStr);
  buildSheet(workbook, "mark_pick",  markPicks,  todayStr);
  buildSheet(workbook, "pack",       packProofs, todayStr);
  buildSheet(workbook, "archive",    archives,   todayStr);

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, pickFisiks, markPicks, packProofs, archives };
}

export function buildWsSheet(workbook: ExcelJS.Workbook, proofs: WsInboxProofPayload[], reportDateStr: string) {
  const theme = SHEET_THEMES["ws_opname"];
  const sheet = workbook.addWorksheet(theme.title, {
    views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 22 },
  });

  // ── Title block (rows 1-3) — sama persis dengan buildSheet ────────────────
  const colCount = 10;
  const lastCol = String.fromCharCode(64 + colCount);
  sheet.mergeCells(`A1:${lastCol}1`);
  const titleCell = sheet.getCell("A1");
  titleCell.value = `${theme.title} — ${reportDateStr}`;
  titleCell.font = { name: "Segoe UI Semibold", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.headerColor } };
  sheet.getRow(1).height = 32;

  const allItems = proofs.flatMap(p => p.items);
  const uniqueActors = new Set(proofs.map(p => p.actor)).size;
  const surplusCount = allItems.filter(i => i.delta > 0).length;
  const deficitCount = allItems.filter(i => i.delta < 0).length;

  sheet.mergeCells(`A2:${lastCol}2`);
  const summaryCell = sheet.getCell("A2");
  summaryCell.value = `Total Item: ${allItems.length}    Total Submit: ${proofs.length}    Unique ${theme.actorLabel}: ${uniqueActors}    Lebih: ${surplusCount}    Kurang: ${deficitCount}`;
  summaryCell.font = { name: "Segoe UI", size: 10, color: { argb: "FF424242" }, italic: true };
  summaryCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  summaryCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.accentColor } };
  sheet.getRow(2).height = 22;
  sheet.getRow(3).height = 6;

  // ── Columns ───────────────────────────────────────────────────────────────
  sheet.columns = [
    { header: "Tanggal",     key: "tanggal",     width: 12 },
    { header: "Jam (WIB)",   key: "jam",         width: 11 },
    { header: theme.actorLabel, key: "actor",    width: 22 },
    { header: "Item ID",     key: "itemId",      width: 11 },
    { header: "Nama Barang", key: "productName", width: 46 },
    { header: "Ekspektasi",  key: "expectedQty", width: 12 },
    { header: "Aktual",      key: "actualQty",   width: 10 },
    { header: "Delta",       key: "delta",       width: 10 },
    { header: "Partial",     key: "partial",     width: 10 },
    { header: "Catatan",     key: "notes",       width: 28 },
  ];

  // ── Header row (row 4) — identik dengan buildSheet ────────────────────────
  const headerRow = sheet.getRow(4);
  headerRow.font = { name: "Segoe UI", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.headerColor } };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };
  headerRow.height = 28;
  headerRow.eachCell({ includeEmpty: true }, cell => {
    cell.border = {
      top: { style: "medium", color: { argb: theme.headerColor } },
      bottom: { style: "medium", color: { argb: theme.headerColor } },
      left: { style: "thin", color: { argb: "FFE0E0E0" } },
      right: { style: "thin", color: { argb: "FFE0E0E0" } },
    };
  });
  headerRow.commit();

  // ── Data rows ─────────────────────────────────────────────────────────────
  let rowIndex = 0;
  for (const proof of proofs) {
    const { tanggal, jam } = jakartaDateParts(proof.timestamp);
    for (const item of proof.items) {
      rowIndex++;
      const row = sheet.addRow({
        tanggal,
        jam,
        actor: proof.actor,
        itemId: item.itemId,
        productName: item.productName,
        expectedQty: item.expectedQty,
        actualQty: item.actualQty,
        delta: item.delta,
        partial: proof.isPartial ? "Ya" : "-",
        notes: proof.notes || "-",
      });
      row.height = 26;
      row.font = { name: "Segoe UI", size: 10 };
      row.alignment = { vertical: "middle", wrapText: false };

      // Hyperlink productName → sama dengan buildSheet
      const productCell = row.getCell("productName");
      const url = itemKyouUrl(item.itemId);
      if (url) {
        productCell.value = { text: item.productName, hyperlink: url };
        productCell.font = { name: "Segoe UI", size: 10, color: { argb: "FF1565C0" }, underline: true };
      }
      productCell.alignment = { vertical: "middle", wrapText: true };

      // Delta: merah/hijau
      const deltaCell = row.getCell("delta");
      deltaCell.numFmt = "+#,##0;-#,##0;0";
      deltaCell.alignment = { vertical: "middle", horizontal: "center" };
      if (item.delta > 0) {
        deltaCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F5E9" } };
        deltaCell.font = { name: "Segoe UI Semibold", size: 10, bold: true, color: { argb: "FF2E7D32" } };
      } else if (item.delta < 0) {
        deltaCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEBEE" } };
        deltaCell.font = { name: "Segoe UI Semibold", size: 10, bold: true, color: { argb: "FFC62828" } };
      }

      (["expectedQty", "actualQty"] as const).forEach(k => {
        row.getCell(k).numFmt = "#,##0";
        row.getCell(k).alignment = { vertical: "middle", horizontal: "center" };
      });

      // Zebra stripe
      if (rowIndex % 2 === 0) {
        row.eachCell({ includeEmpty: false }, cell => {
          if (!cell.fill || (cell.fill as any).type !== "pattern") {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFAFA" } };
          }
        });
      }

      // Borders
      row.eachCell({ includeEmpty: true }, cell => {
        cell.border = {
          top: { style: "hair", color: { argb: "FFE0E0E0" } },
          left: { style: "hair", color: { argb: "FFE0E0E0" } },
          bottom: { style: "hair", color: { argb: "FFE0E0E0" } },
          right: { style: "hair", color: { argb: "FFE0E0E0" } },
        };
      });
    }
  }

  if (rowIndex === 0) {
    sheet.mergeCells(`A5:${lastCol}5`);
    const emptyCell = sheet.getCell("A5");
    emptyCell.value = `Tidak ada data ${theme.title} untuk tanggal ${reportDateStr}.`;
    emptyCell.font = { name: "Segoe UI", size: 11, italic: true, color: { argb: "FF9E9E9E" } };
    emptyCell.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(5).height = 40;
  } else {
    sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: colCount } };
  }
}

export async function generateWsReportWorkbook(wsProofs: WsInboxProofPayload[], todayStr: string): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bot Jolyne";
  workbook.created = new Date();
  workbook.title = `Rekap WS Opname — ${todayStr}`;
  buildWsSheet(workbook, wsProofs, todayStr);
  return workbook.xlsx.writeBuffer();
}

export function startMachitanDailyReportScheduler(client: Client<true>) {
  cron.schedule("0 0 * * *", async () => {
    try {
      console.log("[DailyReport] Running Machitan Daily Report Scheduler...");
      const [proofs, wsProofs] = await Promise.all([getAndClearMachitanProofs(), getAndClearWsInboxProofs()]);

      if (proofs.length === 0 && wsProofs.length === 0) {
        console.log("[DailyReport] No proofs to report today.");
        return;
      }

      const todayStr = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric" });
      const footerText = `Generated ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB · Auto-cron 00:00`;

      const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
      if (!channel || !channel.isTextBased()) {
        console.error("[DailyReport] Cannot fetch target channel");
        return;
      }
      const textChannel = channel as TextChannel;

      // ── Message 1: Pick / Mark Pick / Pack / Archive ──────────────────────
      if (proofs.length > 0) {
        const { buffer, pickFisiks, markPicks, packProofs, archives } = await generateMachitanReportWorkbook(proofs, todayStr);
        const totalItems = proofs.reduce((sum, p) => sum + (Array.isArray(p.items) ? p.items.length : 0), 0);
        const fileName = `Rekap_Warehouse_${todayStr.replace(/ /g, "_")}.xlsx`;
        const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: fileName });

        const embed = new EmbedBuilder()
          .setColor(0x2E7D32)
          .setTitle(`📊 Rekap Harian Warehouse — ${todayStr}`)
          .setDescription(`File Excel berisi 4 sheet: **Pick Fisik**, **Mark Pick**, **Pack**, **Archive Log**. Setiap baris = 1 item. Klik nama produk untuk buka di Kyou.`)
          .addFields(
            { name: "📦 Pick Fisik",   value: `${pickFisiks.length} proof`, inline: true },
            { name: "📝 Mark Pick",    value: `${markPicks.length} proof`,  inline: true },
            { name: "✅ Pack",          value: `${packProofs.length} proof`, inline: true },
            { name: "🗄️ Archive",       value: `${archives.length} item`,   inline: true },
            { name: "Total Item Rows", value: `${totalItems}`,              inline: true },
          )
          .setFooter({ text: footerText })
          .setTimestamp();

        await textChannel.send({ embeds: [embed], files: [attachment] });
        console.log(`[DailyReport] Sent warehouse report for ${todayStr} (${totalItems} item rows)`);
      }

      // ── Message 2: WS Opname ──────────────────────────────────────────────
      if (wsProofs.length > 0) {
        const wsBuffer = await generateWsReportWorkbook(wsProofs, todayStr);
        const wsTotalItems = wsProofs.reduce((sum, p) => sum + p.items.length, 0);
        const wsFileName = `Rekap_WS_Opname_${todayStr.replace(/ /g, "_")}.xlsx`;
        const wsAttachment = new AttachmentBuilder(Buffer.from(wsBuffer), { name: wsFileName });
        const surplusCount = wsProofs.flatMap(p => p.items).filter(i => i.delta > 0).length;
        const deficitCount = wsProofs.flatMap(p => p.items).filter(i => i.delta < 0).length;

        const wsEmbed = new EmbedBuilder()
          .setColor(0x1565C0)
          .setTitle(`🏭 Rekap WS Opname — ${todayStr}`)
          .setDescription(`Rekap opname harian per source. Delta positif = lebih stok, negatif = kurang stok.`)
          .addFields(
            { name: "Total Submit",  value: `${wsProofs.length}`,  inline: true },
            { name: "Total Item",    value: `${wsTotalItems}`,      inline: true },
            { name: "⬆️ Lebih",      value: `${surplusCount} item`, inline: true },
            { name: "⬇️ Kurang",     value: `${deficitCount} item`, inline: true },
          )
          .setFooter({ text: footerText })
          .setTimestamp();

        await textChannel.send({ embeds: [wsEmbed], files: [wsAttachment] });
        console.log(`[DailyReport] Sent WS opname report for ${todayStr} (${wsTotalItems} item rows)`);
      }
    } catch (e) {
      console.error("[DailyReport] Error:", e);
    }
  });
}
