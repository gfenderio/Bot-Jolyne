import { SlashCommandBuilder } from "discord.js";
import { env } from "../config/env.js";
import { createDelivereeCaseStore, createDelivereeWebClient } from "../deliveree/liveRuntime.js";
import { getDelivereeRuntimeMode } from "../deliveree/runtimeControl.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-prepare-reorder")
    .setDescription("Owner-only: siapkan review reorder Deliveree tanpa final submit.")
    .addStringOption((option) => {
      return option
        .setName("url")
        .setDescription("URL booking Deliveree. Default: URL pertama dari DELIVEREE_WATCH_URLS.")
        .setRequired(false);
    }),

  async execute(interaction) {
    const deniedReason = getDelivereeAccessDeniedReason(interaction);

    if (deniedReason) {
      await interaction.reply({
        content: deniedReason,
        flags: ["Ephemeral"]
      });
      return;
    }

    if (getDelivereeRuntimeMode() !== "prepare_reorder") {
      await interaction.reply({
        content: "Prepare reorder masih dikunci. Set `DELIVEREE_ACTION_MODE=prepare_reorder` setelah read-only monitor terbukti aman.",
        flags: ["Ephemeral"]
      });
      return;
    }

    const url = interaction.options.getString("url")?.trim() || env.DELIVEREE_WATCH_URLS[0];

    if (!url) {
      await interaction.reply({
        content: "Belum ada URL Deliveree. Isi `DELIVEREE_WATCH_URLS` atau berikan opsi `url`.",
        flags: ["Ephemeral"]
      });
      return;
    }

    await interaction.deferReply({
      flags: ["Ephemeral"]
    });

    const result = await createDelivereeWebClient().prepareReorderDraft(url);
    await createDelivereeCaseStore().upsertObservation({
      bookingId: result.inspection.bookingId,
      screenshotPath: result.inspection.screenshotPath,
      status: result.inspection.classification.status,
      url
    });

    await interaction.editReply([
      "Prepare reorder berhenti sebelum klik action apa pun.",
      result.reason,
      `Status: \`${result.inspection.classification.status}\``,
      `Screenshot lokal: \`${result.inspection.screenshotPath}\``
    ].join("\n"));
  }
};

