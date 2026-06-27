// node send-opname-report.mjs
import ExcelJS from "exceljs";
import { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } from "discord.js";
import { buildWsInboxSheet } from "./dist/machitan/wsInboxDailyReportScheduler.js";

import 'dotenv/config'; // Load variables from .env

const KYOU_TOKEN = process.env.KYOU_TOKEN;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = "1501899831268868106";
const SOURCES = ["Alpha", "Omega", "SS", "Delta", "Beta", "Gamma", "Lambda", "OP"];

// Use today's date dynamically
const DATE = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' }); // Format: YYYY-MM-DD

async function fetchReport(source) {
  const res = await fetch(`https://api.kyou.id/api/admin/pda/opname/report?source=${source}&date=${DATE}`, {
    headers: { Authorization: `Bearer ${KYOU_TOKEN}`, "X-App-Name": "machitan" },
  });
  const json = await res.json();
  return json.success ? json.data : null;
}

// Konversi string tanggal ke ISO string WIB
function toISO(dateStr) {
  return new Date(dateStr.replace(" ", "T") + "+07:00").toISOString();
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once("clientReady", async () => {
  console.log(`Bot ready, fetching opname report (${DATE}) dari semua source...`);
  try {
    const allData = (await Promise.all(SOURCES.map(fetchReport))).filter(Boolean);

    const proofs = [];
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
      console.log("Tidak ada data opname hari ini.");
      await client.destroy();
      return;
    }

    const todayStr = new Date().toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta", day: "2-digit", month: "long", year: "numeric"
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Bot Jolyne";
    workbook.created = new Date();
    // Reusing the WS Inbox sheet builder since it perfectly formats expected/actual/delta/rack
    buildWsInboxSheet(workbook, proofs, todayStr);
    
    // Rename the sheet title to match Opname
    workbook.eachSheet((sheet) => {
      sheet.name = `Opname ${todayStr.replace(/ /g, "_")}`;
      // Cell A1 contains the title in the sheet
      if (sheet.getCell('A1').value) {
         sheet.getCell('A1').value = `REKAP OPNAME PDA - ${todayStr.toUpperCase()}`;
      }
    });

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    const fileName = `Rekap_Opname_${todayStr.replace(/ /g, "_")}.xlsx`;
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    const totalKor = proofs.filter(p => p.items.some(i => i.selisih !== 0)).length;
    const embed = new EmbedBuilder()
      .setColor(totalKor > 0 ? 0xD32F2F : 0x388E3C)
      .setTitle(`[Rekap Opname PDA] - ${todayStr}`)
      .setDescription(
        `Total scan opname hari ini: **${proofs.length}** item\n` +
        `Selisih (Discrepancy): **${totalKor}** item\n\n` +
        `*File Excel terlampir berisi rincian item-per-item beserta rak-nya.*`
      )
      .setFooter({ text: `Manual trigger ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB` })
      .setTimestamp();

    const channel = await client.channels.fetch(CHANNEL_ID);
    await channel.send({ embeds: [embed], files: [attachment] });
    console.log(`Terkirim! ${proofs.length} item opname, file: ${fileName}`);
  } catch (e) {
    console.error("Error:", e);
  }
  await client.destroy();
});

client.login(DISCORD_TOKEN);
