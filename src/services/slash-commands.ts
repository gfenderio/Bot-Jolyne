import { REST, Routes } from "discord.js";
import { commandData } from "../commands/index.js";
import { requireDiscordBotEnv } from "../config/env.js";

export async function registerGuildSlashCommands() {
  const env = requireDiscordBotEnv();
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);

  console.log(
    `Register ${commandData.length} slash command untuk guild ${env.DISCORD_GUILD_ID}...`
  );

  await rest.put(
    Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID),
    { body: commandData }
  );

  console.log("Slash command guild berhasil diregister.");
}
