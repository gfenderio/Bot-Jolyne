import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./config/env.js";
import { handleInteractionCreate } from "./events/interaction-create.js";
import { handleReady } from "./events/ready.js";
import { startBirthdayNowScheduler } from "./schedulers/birthday-now.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once(Events.ClientReady, (readyClient) => {
  handleReady(readyClient);
  startBirthdayNowScheduler(readyClient);
});
client.on(Events.Error, (error) => {
  console.error("Discord client error", error);
});
client.on(Events.InteractionCreate, handleInteractionCreate);

console.log("Menghubungkan bot ke Discord...");
await client.login(env.DISCORD_TOKEN);
