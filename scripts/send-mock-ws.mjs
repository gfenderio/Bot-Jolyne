import { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder } from "discord.js";
import { generateWsReportWorkbook } from "../dist/machitan/dailyReportScheduler.js";
import "dotenv/config";

const CHANNEL_ID = "1501899831268868106";
const TOKEN = process.env.DISCORD_TOKEN;

const mockProofs = [
  {
    timestamp: "2026-06-17T01:32:11.000Z",
    actor: "Rini Astuti",
    isPartial: false,
    items: [
      { itemId: "10234", productName: "Tumbler Merah Premium 500ml",        qtySent: 20, expectedQty: 85, actualQty: 83, selisih: -2, source: "Omega", rack: "A-12" },
      { itemId: "10235", productName: "Tumbler Biru Navy 500ml",             qtySent: 30, expectedQty: 72, actualQty: 72, selisih:  0, source: "Omega", rack: "A-13" },
      { itemId: "10240", productName: "Tumbler Hijau Army 600ml",            qtySent: 15, expectedQty: 40, actualQty: 43, selisih:  3, source: "Omega", rack: "A-14" },
    ],
  },
  {
    timestamp: "2026-06-17T02:15:44.000Z",
    actor: "Budi Santoso",
    isPartial: true,
    items: [
      { itemId: "10891", productName: "Tas Kain Motif Batik Size L",         qtySent: 28, expectedQty: 110, actualQty: 115, selisih:  5, source: "SS", rack: "B-04" },
      { itemId: "10892", productName: "Tas Kain Motif Batik Size M",         qtySent: 40, expectedQty:  95, actualQty:  93, selisih: -2, source: "SS", rack: "B-04" },
    ],
  },
  {
    timestamp: "2026-06-17T04:44:02.000Z",
    actor: "Eka Purnama",
    isPartial: false,
    items: [
      { itemId: "20011", productName: "Snack Box Coklat Wafer 12pcs",        qtySent: 100, expectedQty: 240, actualQty: 240, selisih:  0, source: "Delta", rack: "C-01" },
      { itemId: "20012", productName: "Snack Box Vanilla Wafer 12pcs",       qtySent:  80, expectedQty: 180, actualQty: 174, selisih: -6, source: "Delta", rack: "C-02" },
      { itemId: "20013", productName: "Snack Box Stroberi Wafer 12pcs",      qtySent:  55, expectedQty: 130, actualQty: 137, selisih:  7, source: "Delta", rack: "C-03" },
    ],
  },
  {
    timestamp: "2026-06-17T07:20:55.000Z",
    actor: "Rini Astuti",
    isPartial: false,
    items: [
      { itemId: "10500", productName: "Botol Minum Anak Karakter Doraemon",  qtySent: 25, expectedQty: 60, actualQty: 60, selisih:  0, source: "Omega", rack: "A-20" },
      { itemId: "10501", productName: "Botol Minum Anak Karakter Hello Kitty", qtySent: 15, expectedQty: 38, actualQty: 35, selisih: -3, source: "Omega", rack: "A-21" },
    ],
  },
  {
    timestamp: "2026-06-17T08:05:10.000Z",
    actor: "Budi Santoso",
    isPartial: false,
    items: [
      { itemId: "10893", productName: "Tas Kain Polos Canvas Size XL",       qtySent: 18, expectedQty: 55, actualQty: 54, selisih: -1, source: "SS", rack: "B-05" },
    ],
  },
  {
    timestamp: "2026-06-17T09:10:00.000Z",
    actor: "Sistem (Sinkronisasi Sheet)",
    isPartial: true,
    items: [
      { itemId: "20050", productName: "Coklat Batang Import Swiss 100g",     qtySent: 60, expectedQty: 145, actualQty: 145, selisih: 0, source: "Delta", rack: "" },
    ],
  },
];

const dateStr = "17 Juni 2026";
const buffer = await generateWsReportWorkbook(mockProofs, dateStr);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
await client.login(TOKEN);

const channel = await client.channels.fetch(CHANNEL_ID);
const allItems = mockProofs.flatMap(p => p.items);
const surplus = allItems.filter(i => i.selisih > 0).length;
const deficit = allItems.filter(i => i.selisih < 0).length;

const embed = new EmbedBuilder()
  .setColor(0x1565C0)
  .setTitle(`🏭 Rekap WS Opname — ${dateStr}`)
  .setDescription("Mock data — preview format Excel harian.")
  .addFields(
    { name: "Total Submit", value: `${mockProofs.length}`, inline: true },
    { name: "Total Item",   value: `${allItems.length}`,  inline: true },
    { name: "⬆️ Lebih",     value: `${surplus} item`,     inline: true },
    { name: "⬇️ Kurang",    value: `${deficit} item`,     inline: true },
  )
  .setTimestamp();

const attachment = new AttachmentBuilder(Buffer.from(buffer), { name: `Rekap_WS_Opname_Mock_${dateStr.replace(/ /g, "_")}.xlsx` });
await channel.send({ embeds: [embed], files: [attachment] });

console.log("✅ Terkirim ke Discord");
await client.destroy();
