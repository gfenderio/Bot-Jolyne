import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./config/env.js";
import { handleInteractionCreate } from "./events/interaction-create.js";
import { handleReady } from "./events/ready.js";
import { startBirthdayNowScheduler } from "./schedulers/birthday-now.js";
import { startMachitanDailyReportScheduler } from "./machitan/dailyReportScheduler.js";
import { registerGuildSlashCommands } from "./services/slash-commands.js";
// Dinonaktifkan — lihat blok ready di bawah.
// import { startNotionStandupScheduler } from "./schedulers/notion-standup.js";
import { startMachitanHttpServer } from "./machitan/httpServer.js";

import { startBaitoAttendanceScheduler } from "./schedulers/baito-attendance.js";
// Dinonaktifkan — lihat blok ready di bawah.
// import { startOripaLiveRecapScheduler } from "./schedulers/oripa-live-recap.js";
import { startFulfillmentStaleScheduler } from "./schedulers/fulfillment-stale.js";
import { startPickTriageScheduler } from "./schedulers/pick-triage.js";
import { startSplitPrintScheduler } from "./schedulers/split-print.js";

if (!env.DISCORD_TOKEN) {
  console.warn("DISCORD_TOKEN belum diisi. Discord bot client dilewati.");
} else {
  // Cuma Guilds. Foto "barang rusak" dulu diminta lewat pesan biasa + message
  // collector, yang menuntut intent MessageContent (privileged) — dan kalau
  // intent itu dimatikan di Developer Portal, Discord menolak login dan SELURUH
  // bot mati. Sekarang fotonya diunggah langsung di dalam modal (komponen file
  // upload), jadi intent itu tidak diperlukan lagi. Jangan ditambahkan kembali.
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (readyClient) => {
    handleReady(readyClient);
    startMachitanHttpServer(readyClient);
    startBirthdayNowScheduler(readyClient);
    startMachitanDailyReportScheduler(readyClient);
    // Dinonaktifkan — tidak dipakai lagi (rekap task Jolyne Tracker ke Discord).
    // startNotionStandupScheduler(readyClient);
    startBaitoAttendanceScheduler(readyClient);
    // Dinonaktifkan — rekap live mingguan tidak perlu cron lagi.
    // startOripaLiveRecapScheduler(readyClient);
    startFulfillmentStaleScheduler(readyClient);
    startPickTriageScheduler(readyClient);
    startSplitPrintScheduler(readyClient);
  });
  client.on(Events.Error, (error) => {
    console.error("Discord client error", error);
  });
  client.on(Events.InteractionCreate, handleInteractionCreate);

  await registerGuildSlashCommands();

  console.log("Menghubungkan bot ke Discord...");
  await client.login(env.DISCORD_TOKEN);
}
