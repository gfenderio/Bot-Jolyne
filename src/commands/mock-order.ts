import { SlashCommandBuilder } from "discord.js";
import { buildMockOrderCreatedEmbed } from "../deliveree/mockOrderEmbed.js";
import { createMockOrderForSlot, isMockOrderSlot } from "../deliveree/mockOrderGenerator.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("mock-order")
    .setDescription("Buat mock order Deliveree slot 1-10 untuk demo recovery.")
    .addIntegerOption((option) => {
      return option
        .setName("slot")
        .setDescription("Slot skenario mock order, 1 sampai 10.")
        .setRequired(true);
    }),

  async execute(interaction) {
    const slot = interaction.options.getInteger("slot", true);

    if (!isMockOrderSlot(slot)) {
      await interaction.reply({
        content: "Slot mock order hanya tersedia dari 1 sampai 10.",
        flags: ["Ephemeral"]
      });
      return;
    }

    const order = createMockOrderForSlot(slot);

    await interaction.reply({
      embeds: [buildMockOrderCreatedEmbed(order)]
    });
  }
};
