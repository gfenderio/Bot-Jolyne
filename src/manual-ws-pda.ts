import { Client, Events, GatewayIntentBits } from "discord.js";
import { env } from "./config/env.js";
import { executeWsInboxDailyReport } from "./machitan/wsInboxDailyReportScheduler.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async (readyClient) => {
    console.log("Logged in, running report...");
    await executeWsInboxDailyReport(readyClient);
    console.log("Done");
    process.exit(0);
});

client.login(env.DISCORD_TOKEN);
