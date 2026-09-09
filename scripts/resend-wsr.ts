/**
 * Sekali jalan: kirim ULANG pengumuman satu kiriman WSR ke channel-nya.
 *   npx tsx scripts/resend-wsr.ts <batchId> [--tag]
 * --tag = tetap pasang tag walau kirimannya sudah beres (untuk mengetes tag).
 */
import { Client, Events, GatewayIntentBits } from "discord.js";
import "dotenv/config";
import { kirimUlangPengumuman } from "../src/schedulers/wsr-shipment.js";

const batchId = Number(process.argv[2]);
const selaluTag = process.argv.includes("--tag");
if (!Number.isInteger(batchId)) throw new Error("batchId wajib angka.");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once(Events.ClientReady, async () => {
  try {
    await kirimUlangPengumuman(client, batchId, { selaluTag });
  } finally {
    await client.destroy();
  }
});
await client.login(process.env.DISCORD_TOKEN);
