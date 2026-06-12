import cron from "node-cron";
import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { getAndClearWsInboxProofs, WsInboxProofPayload } from "./wsInboxStore.js";

const TARGET_CHANNEL_ID = "1501899831268868106"; // Sesuaikan jika channelnya beda

function jakartaDateParts(iso: string): { tanggal: string; jam: string } {
  const d = new Date(iso);
  const dateStr = d.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = d.toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return { tanggal: dateStr, jam: timeStr };
}

export function buildWsInboxSheet(workbook: ExcelJS.Workbook, proofs: WsInboxProofPayload[], reportDateStr: string) {
  const sheet = workbook.addWorksheet("WS Inbox Log", {
    views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    properties: { defaultRowHeight: 22 },
  });

  sheet.mergeCells("A1:J1");
  const titleCell = sheet.getCell("A1");
  titleCell.value = `WS Inbox Log — ${reportDateStr}`;
  titleCell.font = { name: "Segoe UI Semibold", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0277BD" } }; // Light blue header
  sheet.getRow(1).height = 32;

  let totalItems = 0;
  let totalDelta = 0;
  for (const p of proofs) {
    totalItems += p.items.length;
    for (const it of p.items) totalDelta += it.delta;
  }

  sheet.mergeCells("A2:J2");
  const summaryCell = sheet.getCell("A2");
  summaryCell.value = `Total Transaksi: ${proofs.length}    Total Item: ${totalItems}    Net Delta: ${totalDelta}`;
  summaryCell.font = { name: "Segoe UI", size: 10, color: { argb: "FF424242" }, italic: true };
  summaryCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  summaryCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE1F5FE" } };
  sheet.getRow(2).height = 22;

  sheet.getRow(3).height = 6;

  sheet.columns = [
    { header: "Tanggal",       key: "tanggal",     width: 12 },
    { header: "Jam (WIB)",     key: "jam",         width: 11 },
    { header: "Admin",         key: "actor",       width: 22 },
    { header: "Item ID",       key: "itemId",      width: 11 },
    { header: "Nama Barang",   key: "productName", width: 46 },
    { header: "Qty Sistem",    key: "expectedQty", width: 12 },
    { header: "Qty Fisik",     key: "actualQty",   width: 12 },
    { header: "Selisih",       key: "delta",       width: 10 },
    { header: "Tipe",          key: "tipe",        width: 18 },
    { header: "Catatan",       key: "notes",       width: 28 },
  ];

  const headerRow = sheet.getRow(4);
  headerRow.font = { name: "Segoe UI", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0277BD" } };
  headerRow.alignment = { vertical: "middle", horizontal: "left" };
  headerRow.height = 28;

  let rowIndex = 0;
  for (const p of proofs) {
    const { tanggal, jam } = jakartaDateParts(p.timestamp);
    for (const it of p.items) {
      const isKor = it.delta !== 0;
      let tipeStr = "Opname Normal";
      let tipeColor = "FFE8F5E9"; // green
      
      if (isKor && p.isPartial) {
         tipeStr = "Partial / Pending";
         tipeColor = "FFFFF3E0"; // orange
      } else if (isKor && it.delta < 0) {
         tipeStr = "KOR (Minus)";
         tipeColor = "FFFFEBEE"; // light red
      } else if (isKor && it.delta > 0) {
         tipeStr = "KOR (Plus)";
         tipeColor = "FFE3F2FD"; // light blue
      }

      const row = sheet.addRow({
        tanggal,
        jam,
        actor: p.actor || "-",
        itemId: it.itemId || "-",
        productName: it.productName || "Item",
        expectedQty: it.expectedQty || 0,
        actualQty: it.actualQty || 0,
        delta: it.delta || 0,
        tipe: tipeStr,
        notes: p.notes || "-",
      });
      rowIndex++;
      row.height = 26;
      row.font = { name: "Segoe UI", size: 10 };
      row.alignment = { vertical: "middle", wrapText: false };

      row.getCell("delta").numFmt = "+#,##0;-#,##0;0";
      row.getCell("delta").alignment = { vertical: "middle", horizontal: "center" };
      row.getCell("expectedQty").alignment = { vertical: "middle", horizontal: "center" };
      row.getCell("actualQty").alignment = { vertical: "middle", horizontal: "center" };

      if (tipeColor) {
        row.getCell("tipe").fill = { type: "pattern", pattern: "solid", fgColor: { argb: tipeColor } };
        row.getCell("tipe").font = { name: "Segoe UI Semibold", size: 10, bold: true };
        row.getCell("tipe").alignment = { vertical: "middle", horizontal: "center" };
      }

      if (it.delta < 0) {
        row.getCell("delta").font = { color: { argb: "FFD32F2F" }, bold: true };
      } else if (it.delta > 0) {
        row.getCell("delta").font = { color: { argb: "FF1976D2" }, bold: true };
      }

      if (rowIndex % 2 === 0) {
        row.eachCell({ includeEmpty: false }, (cell) => {
          if (!cell.fill || (cell.fill as any).type !== "pattern") {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFAFAFA" } };
          }
        });
      }
    }
  }

  if (rowIndex === 0) {
    sheet.mergeCells(`A5:J5`);
    const emptyCell = sheet.getCell("A5");
    emptyCell.value = `Tidak ada aktivitas WS Inbox untuk tanggal ${reportDateStr}.`;
    emptyCell.font = { name: "Segoe UI", size: 11, italic: true, color: { argb: "FF9E9E9E" } };
    emptyCell.alignment = { vertical: "middle", horizontal: "center" };
    sheet.getRow(5).height = 40;
  } else {
    sheet.autoFilter = {
      from: { row: 4, column: 1 },
      to: { row: 4, column: 10 },
    };
  }
}

export async function generateWsInboxReportWorkbook(proofs: WsInboxProofPayload[], todayStr: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Bot Jolyne";
  workbook.created = new Date();
  workbook.title = `Rekap WS Inbox — ${todayStr}`;

  buildWsInboxSheet(workbook, proofs, todayStr);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// NOTE: Fungsi ini JANGAN di-cron dulu sesuai instruksi. Nanti tinggal panggil cron.schedule jika app sudah jalan.
export async function executeWsInboxDailyReport(client: Client<true>) {
  try {
    console.log("[WsInboxReport] Generating report...");
    const proofs = await getAndClearWsInboxProofs();

    if (proofs.length === 0) {
      console.log("[WsInboxReport] No proofs to report today.");
      return;
    }

    const todayStr = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric" });
    const buffer = await generateWsInboxReportWorkbook(proofs, todayStr);

    const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error("[WsInboxReport] Cannot fetch target channel");
      return;
    }

    const fileName = `Rekap_WS_Inbox_${todayStr.replace(/ /g, "_")}.xlsx`;
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    let totalSuccess = 0;
    let totalSuccessQty = 0;
    let missingItems = 0;
    let missingQty = 0;
    let surplusItems = 0;
    let surplusQty = 0;

    // Untuk Top 3 KOR
    type KorEntry = { name: string; delta: number; actor: string };
    const korList: KorEntry[] = [];

    for (const p of proofs) {
      if (p.isPartial) continue; // Skip pending stats from embed metrics

      for (const it of p.items) {
        if (it.delta === 0) {
          totalSuccess++;
          totalSuccessQty += it.actualQty;
        } else if (it.delta < 0) {
          missingItems++;
          missingQty += Math.abs(it.delta);
          korList.push({ name: it.productName, delta: it.delta, actor: p.actor });
        } else {
          surplusItems++;
          surplusQty += it.delta;
          korList.push({ name: it.productName, delta: it.delta, actor: p.actor });
        }
      }
    }

    // Sort KOR by highest absolute delta
    korList.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const top3 = korList.slice(0, 3);

    const totalKorItems = missingItems + surplusItems;

    let dangerText = "";
    if (totalKorItems === 0) {
      dangerText = "Tidak ada selisih hari ini! Luar biasa! 🎉";
    } else {
      dangerText = `* 📉 **Barang Hilang:** ${missingItems} SKU (Total -${missingQty} pcs)\n* 📈 **Barang Lebih:** ${surplusItems} SKU (Total +${surplusQty} pcs)\n\n**🚨 Top 3 Selisih Ekstrem:**\n`;
      top3.forEach((kor, idx) => {
        const typeStr = kor.delta < 0 ? "(Hilang)" : "(Lebih)";
        dangerText += `${idx + 1}. *${kor.name.substring(0,40)}* ➔ **${kor.delta > 0 ? '+'+kor.delta : kor.delta} pcs ${typeStr}** *(Admin: ${kor.actor})*\n`;
      });
    }

    const embed = new EmbedBuilder()
      .setColor(totalKorItems > 0 ? 0xD32F2F : 0x388E3C)
      .setTitle(`[Rekap WS Inbox PDA] - ${todayStr}`)
      .setDescription(`✅ **Mulus:** ${totalSuccess} SKU (+${totalSuccessQty} pcs) masuk rak aman.\n\n` + 
                      (totalKorItems > 0 ? `⚠️ **LAPORAN SELISIH (KOR WH)**\n${dangerText}` : `✅ **KOR WH ZERO DETECTED**\n${dangerText}`) +
                      `\n\n*File Excel terlampir berisi rincian item-per-item untuk audit.*`)
      .setFooter({ text: `Generated ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB` })
      .setTimestamp();

    await (channel as TextChannel).send({ embeds: [embed], files: [attachment] });
    console.log(`[WsInboxReport] Sent daily report for ${todayStr}`);
  } catch (e) {
    console.error("[WsInboxReport] Error:", e);
  }
}
