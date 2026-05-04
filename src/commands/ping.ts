import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Cek latency bot."),

  async execute(interaction) {
    const latency = interaction.client.ws.ping;
    await interaction.reply(`Pong! Latency: ${latency}ms`);
  }
};
