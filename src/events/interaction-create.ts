import { DiscordAPIError } from "discord.js";
import type { Interaction } from "discord.js";
import { commands } from "../commands/index.js";

export async function handleInteractionCreate(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commands.get(interaction.commandName);

  if (!command) {
    await interaction.reply({
      content: "Command tidak ditemukan.",
      flags: ["Ephemeral"]
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Gagal menjalankan /${interaction.commandName}`, error);

    const response = {
      content: "Terjadi error saat menjalankan command.",
      flags: ["Ephemeral"] as const
    };

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
        return;
      }

      await interaction.reply(response);
    } catch (replyError) {
      if (replyError instanceof DiscordAPIError) {
        console.error("Gagal mengirim error response ke Discord.", {
          code: replyError.code,
          status: replyError.status
        });
        return;
      }

      throw replyError;
    }
  }
}
