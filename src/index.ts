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

if (!env.DISCORD_TOKEN) {
  console.warn("DISCORD_TOKEN belum diisi. Discord bot client dilewati.");
} else {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once(Events.ClientReady, (readyClient) => {
    handleReady(readyClient);
    startMachitanHttpServer(readyClient);
    startBirthdayNowScheduler(readyClient);
    startMachitanDailyReportScheduler(readyClient);
    startNotionStandupScheduler(readyClient);
    startBaitoAttendanceScheduler(readyClient);
    startOripaLiveRecapScheduler(readyClient);
  });
  client.on(Events.Error, (error) => {
    console.error("Discord client error", error);
  });
  client.on(Events.InteractionCreate, handleInteractionCreate);

  await registerGuildSlashCommands();

  console.log("Menghubungkan bot ke Discord...");
  await client.login(env.DISCORD_TOKEN);
}
