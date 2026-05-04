import { REST, Routes } from "discord.js";
import { commandData } from "./commands/index.js";
import { env } from "./config/env.js";

const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

try {
  console.log(`Deploy ${commandData.length} slash command...`);

  await rest.put(
    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID),
    { body: commandData }
  );

  console.log("Slash command berhasil dideploy.");
} catch (error) {
  console.error("Gagal deploy slash command.", error);
  process.exitCode = 1;
}
