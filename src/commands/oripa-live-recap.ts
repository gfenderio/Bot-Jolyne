import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import {
  buildOripaLiveRecapModal,
  isOripaLiveRecapUserAllowed
} from "../handlers/oripaLiveRecap.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("live-recap")
    .setDescription("Rekap sesi live oripa untuk HR (pilih periode di popup)"),

  async execute(interaction) {
    if (!isOripaLiveRecapUserAllowed(interaction.user.id)) {
      await interaction.reply({
        content: "❌ Kamu tidak memiliki izin untuk melihat rekap live oripa.",
        ephemeral: true
      });
      return;
    }

    await interaction.showModal(buildOripaLiveRecapModal());
  }
};
