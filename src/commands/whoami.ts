import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("whoami")
    .setDescription("Tampilkan Discord user ID kamu untuk konfigurasi owner bot."),

  async execute(interaction) {
    await interaction.reply({
      content: [
        `User: ${interaction.user.globalName ?? interaction.user.username}`,
        `Discord user ID: \`${interaction.user.id}\``
      ].join("\n"),
      flags: ["Ephemeral"]
    });
  }
};

