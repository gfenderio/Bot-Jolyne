import cron from "node-cron";
import type { Client } from "discord.js";
import { env } from "../config/env.js";
import { buildOripaLiveRecap, resolveRecapRange } from "../services/oripaLiveRecap.js";

export function startOripaLiveRecapScheduler(client: Client<true>) {
  // Setiap Senin 09:00 WIB: rekap sesi live minggu sebelumnya.
  cron.schedule(
    "0 9 * * 1",
    async () => {
      try {
        console.log("Running Oripa Live weekly recap scheduler...");
        const channelId = env.ORIPA_LIVE_CHANNEL_ID;

        if (!channelId) {
          console.error("ORIPA_LIVE_CHANNEL_ID belum diset, rekap mingguan dilewati.");
          return;
        }

        const channel = await client.channels.fetch(channelId);

        if (!channel?.isTextBased() || !("send" in channel)) {
          console.error("Channel rekap live oripa tidak ditemukan atau bukan text channel.");
          return;
        }

        const range = resolveRecapRange("minggu-lalu");
        const recap = await buildOripaLiveRecap(range);

        await channel.send({
          content: "📊 **Rekap Mingguan Live Oripa**",
          embeds: [recap.embed],
          files: recap.attachment ? [recap.attachment] : []
        });
      } catch (error) {
        console.error("Error di Oripa Live recap scheduler:", error);
      }
    },
    { timezone: "Asia/Jakarta" }
  );

  console.log(`Oripa Live weekly recap scheduler aktif untuk channel ${env.ORIPA_LIVE_CHANNEL_ID}.`);
}
