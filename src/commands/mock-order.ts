import { SlashCommandBuilder } from "discord.js";
import { buildMockOrderMessage } from "../deliveree/mockOrderEmbed.js";
import { createMockOrderForSlot, isMockOrderSlot, type MockOrderSlot } from "../deliveree/mockOrderGenerator.js";
import { getNextMockDelivereeTrackingResult } from "../deliveree/mockRuntime.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("mock-order")
    .setDescription("Buat mock order Deliveree secara acak untuk demo recovery."),

  async execute(interaction) {
    const randomSlot = (Math.floor(Math.random() * 10) + 1) as MockOrderSlot;

    if (!isMockOrderSlot(randomSlot)) {
      await interaction.reply({
        content: "Gagal memilih slot acak.",
        flags: ["Ephemeral"]
      });
      return;
    }

    const createdOrder = createMockOrderForSlot(randomSlot);
    const trackingResult = await getNextMockDelivereeTrackingResult(createdOrder.bookingId);
    const state = {
      bookingId: createdOrder.bookingId,
      changed: trackingResult.changed,
      createdOrder,
      order: trackingResult.order ?? undefined,
      previousStatus: trackingResult.previousStatus
    };

    await interaction.reply(buildMockOrderMessage(state));
  }
};
