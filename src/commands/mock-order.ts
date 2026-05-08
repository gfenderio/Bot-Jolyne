import { SlashCommandBuilder } from "discord.js";
import { buildMockOrderCreatedEmbed } from "../deliveree/mockOrderEmbed.js";
import { createMockOrderForSlot, isMockOrderSlot, type MockOrderSlot } from "../deliveree/mockOrderGenerator.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("mock-order")
    .setDescription("Buat mock order Deliveree secara acak untuk demo recovery."),

  async execute(interaction) {
    const randomSlot = Math.floor(Math.random() * 10) + 1 as MockOrderSlot;

    if (!isMockOrderSlot(randomSlot)) {
      await interaction.reply({
        content: "Gagal memilih slot acak.",
        flags: ["Ephemeral"]
      });
      return;
    }

    const order = createMockOrderForSlot(randomSlot);

    await interaction.reply({
      embeds: [buildMockOrderCreatedEmbed(order)]
    });
  }
};
