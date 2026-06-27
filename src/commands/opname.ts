import { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import ExcelJS from "exceljs";
import { buildWsInboxSheet } from "../machitan/wsInboxDailyReportScheduler.js";

const KYOU_TOKEN = process.env.KYOU_TOKEN;
const SOURCES = ["Alpha", "Omega", "SS", "Delta", "Beta", "Gamma", "Lambda", "OP"];

async function fetchReport(source: string, date: string) {
  const res = await fetch(`https://api.kyou.id/api/admin/pda/opname/report?source=${source}&date=${date}`, {
    headers: { Authorization: `Bearer ${KYOU_TOKEN}`, "X-App-Name": "machitan" },
  });
  const json: any = await res.json();
  return json.success ? json.data : null;
}

function toISO(dateStr: string) {
  return new Date(dateStr.replace(" ", "T") + "+07:00").toISOString();
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("opname")
    .setDescription("Kirim rekapan Opname PDA hari ini."),

  async execute(interaction) {
    await interaction.deferReply();
    
    const DATE = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    const todayStr = new Date().toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric"
    });

    try {
      const allData = (await Promise.all(SOURCES.map(s => fetchReport(s, DATE)))).filter(Boolean);

      const proofs: any[] = [];
      for (const data of allData) {
        const opnameItems = data.items || [];
        for (const item of opnameItems) {
          proofs.push({
            timestamp: toISO(item.reported_at),
            actor: item.reported_by_name || "Sistem",
            isPartial: false,
            notes: item.notes || undefined,
            items: [{
              itemId: String(item.item_id),
              productName: String(item.product_name), 
              qtySent: item.expected_qty,
              expectedQty: item.expected_qty,
              actualQty: item.actual_qty,
              selisih: item.delta,
              source: item.source_code,
              rack: item.rack || undefined,
            }],
          });
        }
      }

      if (proofs.length === 0) {
        await interaction.editReply(`Tidak ada data opname PDA untuk hari ini (${todayStr}).`);
        return;
      }

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Bot Jolyne";
      workbook.created = new Date();
      
      buildWsInboxSheet(workbook, proofs, todayStr);
      
      workbook.eachSheet((sheet) => {
        sheet.name = `Opname ${todayStr.replace(/ /g, "_")}`;
        if (sheet.getCell('A1').value) {
           sheet.getCell('A1').value = `REKAP OPNAME PDA - ${todayStr.toUpperCase()}`;
        }
      });

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const fileName = `Rekap_Opname_${todayStr.replace(/ /g, "_")}.xlsx`;
      const attachment = new AttachmentBuilder(buffer, { name: fileName });

      const totalKor = proofs.filter(p => p.items.some((i: any) => i.selisih !== 0)).length;
      const embed = new EmbedBuilder()
        .setColor(totalKor > 0 ? 0xD32F2F : 0x388E3C)
        .setTitle(`[Rekap Opname PDA] - ${todayStr}`)
        .setDescription(
          `Total scan opname hari ini: **${proofs.length}** item\n` +
          `Selisih (Discrepancy): **${totalKor}** item\n\n` +
          `*File Excel terlampir berisi rincian item-per-item beserta rak-nya.*`
        )
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } catch (e) {
      console.error("Error opname command:", e);
      await interaction.editReply("Terjadi kesalahan saat mengambil rekapan opname.");
    }
  }
};
