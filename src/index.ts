import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./config/env.js";
import { handleInteractionCreate } from "./events/interaction-create.js";
import { handleReady } from "./events/ready.js";
import { startBirthdayNowScheduler } from "./schedulers/birthday-now.js";
import { startMachitanDailyReportScheduler } from "./machitan/dailyReportScheduler.js";
import { registerGuildSlashCommands } from "./services/slash-commands.js";
import { startNotionStandupScheduler } from "./schedulers/notion-standup.js";
import { startMachitanHttpServer } from "./machitan/httpServer.js";

import { startBaitoAttendanceScheduler } from "./schedulers/baito-attendance.js";
import { startOripaLiveRecapScheduler } from "./schedulers/oripa-live-recap.js";
import { startFulfillmentStaleScheduler } from "./schedulers/fulfillment-stale.js";
import { startPickTriageScheduler } from "./schedulers/pick-triage.js";

if (!env.DISCORD_TOKEN) {
  console.warn("DISCORD_TOKEN belum diisi. Discord bot client dilewati.");
} else {
  // MessageContent + GuildMessages hanya diminta kalau fitur foto "barang rusak"
  // dinyalakan: keduanya perlu buat membaca lampiran yang di-upload pelapor.
  // MessageContent itu privileged — kalau belum diizinkan di Developer Portal,
  // Discord menolak login dan seluruh bot mati. Karena itu opt-in lewat env.
  const intents = [GatewayIntentBits.Guilds];
  if (env.PICK_TRIAGE_PHOTO_ENABLED) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
    console.log("[pick-triage] fitur foto aktif — meminta intent GuildMessages + MessageContent.");
  }

  const client = new Client({ intents });

  client.once(Events.ClientReady, (readyClient) => {
    handleReady(readyClient);
    startMachitanHttpServer(readyClient);
    startBirthdayNowScheduler(readyClient);
    startMachitanDailyReportScheduler(readyClient);
    startNotionStandupScheduler(readyClient);
    startBaitoAttendanceScheduler(readyClient);
    startOripaLiveRecapScheduler(readyClient);
    startFulfillmentStaleScheduler(readyClient);
    startPickTriageScheduler(readyClient);
  });
  client.on(Events.Error, (error) => {
    console.error("Discord client error", error);
  });
  client.on(Events.InteractionCreate, handleInteractionCreate);

  await registerGuildSlashCommands();

  console.log("Menghubungkan bot ke Discord...");
  await client.login(env.DISCORD_TOKEN);
}
