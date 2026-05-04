import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("server")
    .setDescription("Tampilkan informasi server."),

  async execute(interaction) {
    const guild = interaction.guild;

    if (!guild) {
      await interaction.reply({
        content: "Command ini hanya bisa digunakan di server.",
        flags: ["Ephemeral"]
      });
      return;
    }

    await interaction.reply({
      content: [
        `Server: ${guild.name}`,
        `Member: ${guild.memberCount}`,
        `Dibuat: <t:${Math.floor(guild.createdTimestamp / 1000)}:D>`
      ].join("\n")
    });
  }
};
