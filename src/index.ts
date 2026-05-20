import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./config/env.js";
import { DiscordWebhookNotifier } from "./deliveree/discordNotifier.js";
import {
  activeMockDelivereeBookingIds,
  mockDelivereeClient,
  mockDelivereeStateStore
} from "./deliveree/mockRuntime.js";
import { startDelivereePoller } from "./deliveree/poller.js";
import { startDelivereeExtensionIntake } from "./deliveree/extensionIntake.js";
import { startDelivereeWebMonitor } from "./deliveree/webMonitor.js";
import { handleInteractionCreate } from "./events/interaction-create.js";
import { handleReady } from "./events/ready.js";
import { startBirthdayNowScheduler } from "./schedulers/birthday-now.js";
import { registerGuildSlashCommands } from "./services/slash-commands.js";

startDelivereePoller({
  activeBookingIds: activeMockDelivereeBookingIds,
  client: mockDelivereeClient,
  intervalMs: env.POLL_INTERVAL_SECONDS * 1000,
  notifier: new DiscordWebhookNotifier(env.DISCORD_WEBHOOK_URL),
  stateStore: mockDelivereeStateStore
});

if (!env.DISCORD_TOKEN) {
  console.warn("DISCORD_TOKEN belum diisi. Discord bot client dilewati; Deliveree mock poller tetap berjalan.");
} else {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once(Events.ClientReady, (readyClient) => {
    handleReady(readyClient);
    startBirthdayNowScheduler(readyClient);
    startDelivereeExtensionIntake(readyClient);
    startDelivereeWebMonitor(readyClient);
  });
  client.on(Events.Error, (error) => {
    console.error("Discord client error", error);
  });
  client.on(Events.InteractionCreate, handleInteractionCreate);

  await registerGuildSlashCommands();

  console.log("Menghubungkan bot ke Discord...");
  await client.login(env.DISCORD_TOKEN);
}
