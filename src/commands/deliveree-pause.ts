import { SlashCommandBuilder } from "discord.js";
import { setDelivereeRuntimeMode } from "../deliveree/runtimeControl.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-pause")
    .setDescription("Emergency stop untuk Deliveree web monitor/action."),

  async execute(interaction) {
    const deniedReason = getDelivereeAccessDeniedReason(interaction, {
      requireAllowedChannel: false
    });

    if (deniedReason) {
      await interaction.reply({
        content: deniedReason,
        flags: ["Ephemeral"]
      });
      return;
    }

    setDelivereeRuntimeMode("paused");
    await interaction.reply({
      content: "Deliveree runtime mode sekarang `paused`. Monitor dan action Playwright dihentikan.",
      flags: ["Ephemeral"]
    });
  }
};

