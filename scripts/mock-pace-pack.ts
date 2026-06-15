// One-off: kirim MOCK Pace Pack "Daily Final Report" ke channel Discord untuk preview.
// Pakai data Sabtu (dummy) karena belum ada scan asli.
// Jalankan: DISCORD_TOKEN=xxxx npx tsx scripts/mock-pace-pack.ts
import { Client, Events, GatewayIntentBits } from "discord.js";
import { buildDailyEmbed } from "../src/machitan/pacePackScheduler.js";
import type { PacePackEvent } from "../src/machitan/pacePackStore.js";

const TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.MACHITAN_PACE_PACK_CHANNEL_ID || "1475760273703964826";

if (!TOKEN) {
  console.error("ERROR: set DISCORD_TOKEN dulu. Contoh:\n  DISCORD_TOKEN=xxxx npx tsx scripts/mock-pace-pack.ts");
  process.exit(1);
}

// Hari Sabtu lalu (relatif terhadap hari ini). getDay(): 6 = Sabtu.
const now = new Date();
const sat = new Date(now.getFullYear(), now.getMonth(), now.getDate());
sat.setDate(sat.getDate() - ((sat.getDay() + 1) % 7)); // mundur ke Sabtu terakhir
const start = new Date(sat.getFullYear(), sat.getMonth(), sat.getDate(), 0, 0, 0, 0);

function at(hour: number, minute: number) {
  return new Date(start.getFullYear(), start.getMonth(), start.getDate(), hour, minute, 0, 0).toISOString();
}

// Dummy events Sabtu — 3 packer, beberapa jam, ada jam kosong, ada bypass (harus diabaikan KPI).
const mockEvents: PacePackEvent[] = [
  { ts: at(9, 12), actor: "Rina", items: 14, orders: ["378900"], bypass: false },
  { ts: at(9, 48), actor: "Doni", items: 9, orders: ["378901"], bypass: false },
  { ts: at(10, 5), actor: "Rina", items: 22, orders: ["378902", "378903"], bypass: false },
  { ts: at(11, 30), actor: "Sari", items: 17, orders: ["378904"], bypass: false },
  { ts: at(13, 15), actor: "Doni", items: 25, orders: ["378905"], bypass: false },
  { ts: at(13, 40), actor: "Rina", items: 31, orders: ["378906", "378907"], bypass: false },
  { ts: at(15, 0), actor: "Sari", items: 12, orders: ["378908"], bypass: false },
  { ts: at(16, 20), actor: "Doni", items: 18, orders: ["378909"], bypass: false },
  { ts: at(18, 45), actor: "Rina", items: 8, orders: ["378910"], bypass: false },
  { ts: at(19, 10), actor: "Andi", items: 5, orders: ["378911"], bypass: true }, // bypass → tidak dihitung
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  try {
    const embed = buildDailyEmbed(mockEvents, start);
    if (!embed) {
      console.error("Embed null (tidak ada event valid).");
      process.exit(1);
    }
    const channel = await client.channels.fetch(CHANNEL_ID);
    if (channel?.isTextBased() && "send" in channel) {
      await channel.send({ content: "🧪 **MOCK / PREVIEW** (data dummy Sabtu, bukan data asli)", embeds: [embed] });
      console.log(`Terkirim ke channel ${CHANNEL_ID} (tanggal mock: ${start.toDateString()}).`);
    } else {
      console.error("Channel bukan text-based / tidak ditemukan.");
    }
  } catch (e) {
    console.error("Gagal kirim:", e);
  } finally {
    await client.destroy();
    process.exit(0);
  }
});

client.login(TOKEN);
