import cron from "node-cron";
import ExcelJS from "exceljs";
import { AttachmentBuilder, Client, EmbedBuilder, TextChannel } from "discord.js";
import { getAndClearMachitanProofs, MachitanProofPayload } from "./proofStore.js";

const TARGET_CHANNEL_ID = "1501899831268868106"; // User requested target channel
const MARK_PICK_CHANNEL = "1418827227264450663";
const PICK_FISIK_CHANNEL = "1390221553333043200";
const PACK_PROOF_CHANNEL = "1209860901914677368";

export function startMachitanDailyReportScheduler(client: Client<true>) {
  // Run every midnight (00:00)
  cron.schedule("0 0 * * *", async () => {
    try {
      console.log("Running Machitan Daily Report Scheduler...");
      const proofs = await getAndClearMachitanProofs();
      
      if (proofs.length === 0) {
        console.log("No proofs to report today.");
        return;
      }

      // Group proofs
      const markPicks = proofs.filter(p => p.channelId === MARK_PICK_CHANNEL);
      const pickFisiks = proofs.filter(p => p.channelId === PICK_FISIK_CHANNEL);
      const packProofs = proofs.filter(p => p.channelId === PACK_PROOF_CHANNEL);
      // fallback for any other proofs
      const others = proofs.filter(p => ![MARK_PICK_CHANNEL, PICK_FISIK_CHANNEL, PACK_PROOF_CHANNEL].includes(p.channelId));
      
      // Combine others into the most logical place if needed, or put in pickFisiks
      pickFisiks.push(...others);

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Bot Jolyne";
      
      // Helper to create sheet with premium styling and sorting enabled
      const createSheet = (name: string, data: MachitanProofPayload[]) => {
        const sheet = workbook.addWorksheet(name);
        sheet.views = [{ showGridLines: true }]; // Ensure gridlines are visible

        sheet.columns = [
          { header: "Waktu (WIB)", key: "time", width: 25 },
          { header: "Staff", key: "actor", width: 18 },
          { header: "Order IDs", key: "orders", width: 25 },
          { header: "Catatan", key: "notes", width: 30 },
          { header: "Item Summary", key: "items", width: 55 },
          { header: "Foto (Base64)", key: "photo", width: 15 }
        ];

        // Format Header Row
        const headerRow = sheet.getRow(1);
        headerRow.font = { name: "Segoe UI", bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
        headerRow.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF2C3E50" } // Professional dark slate
        };
        headerRow.alignment = { vertical: "middle", horizontal: "left" };
        headerRow.height = 26;

        // Populate Data
        data.forEach((p, idx) => {
          const row = sheet.addRow({
            time: new Date(p.timestamp).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }),
            actor: p.actor,
            orders: p.orderIds.join(", "),
            notes: p.notes,
            items: p.itemSummary.join("\n"),
            photo: "Has Photo" 
          });

          row.height = 24;
          row.font = { name: "Segoe UI", size: 10 };
          row.alignment = { vertical: "middle" };

          // Format items column with text wrapping
          const itemsCell = row.getCell("items");
          itemsCell.alignment = { wrapText: true, vertical: "middle" };

          // Subtle Zebra Striping for better readability
          if (idx % 2 === 1) {
            row.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: "FFF8F9FA" } // Light gray row background
            };
          }

          // Add cell borders to look premium
          row.eachCell({ includeEmpty: true }, (cell) => {
            cell.border = {
              top: { style: "thin", color: { argb: "FFE0E0E0" } },
              left: { style: "thin", color: { argb: "FFE0E0E0" } },
              bottom: { style: "thin", color: { argb: "FFE0E0E0" } },
              right: { style: "thin", color: { argb: "FFE0E0E0" } }
            };
          });
        });

        // Enable AutoFilter so user can sort and filter any column
        const totalRows = data.length + 1;
        sheet.autoFilter = `A1:F${totalRows}`;
      };

      createSheet("Pick Fisik Log", pickFisiks);
      createSheet("Mark Pack Log", markPicks); // User called it Mark Pack Log
      createSheet("Pack Log", packProofs);

      const buffer = await workbook.xlsx.writeBuffer();
      
      const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
      if (!channel || !channel.isTextBased()) {
        console.error("Cannot fetch target channel for daily report");
        return;
      }
      
      const todayStr = new Date().toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric" });
      const fileName = `Rekap_Warehouse_${todayStr.replace(/ /g, "_")}.xlsx`;
      
      const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: fileName });
      
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`📊 Rekap Harian Warehouse - ${todayStr}`)
        .addFields(
          { name: "Total Mark Pick", value: `📝 ${markPicks.length} Items`, inline: true },
          { name: "Total Pick Fisik", value: `📦 ${pickFisiks.length} Items`, inline: true },
          { name: "Total Pack Proof", value: `✅ ${packProofs.length} Orders`, inline: true }
        )
        .setFooter({ text: "Silakan download file .xlsx terlampir untuk detail lengkapnya." })
        .setTimestamp();

      await (channel as TextChannel).send({
        embeds: [embed],
        files: [attachment]
      });
      
      console.log(`Successfully sent daily report for ${todayStr}`);
    } catch (e) {
      console.error("Error generating/sending daily report:", e);
    }
  });
}
