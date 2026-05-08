import { SlashCommandBuilder } from "discord.js";
import { env } from "../config/env.js";
import { createDelivereeCaseStore, createDelivereeWebClient } from "../deliveree/liveRuntime.js";
import { getDelivereeRuntimeMode } from "../deliveree/runtimeControl.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import type { SlashCommand } from "../types/command.js";

function getDefaultWatchUrl() {
  return env.DELIVEREE_WATCH_URLS[0];
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-status")
    .setDescription("Cek status order Deliveree secara read-only.")
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

    if (!env.DELIVEREE_WEB_AUTOMATION_APPROVED) {
      await interaction.reply({
        content: [
          "Live Deliveree web automation masih dikunci oleh compliance gate.",
          "Aktifkan `DELIVEREE_WEB_AUTOMATION_APPROVED=true` hanya setelah ada izin/approval yang jelas untuk akses otomatis Deliveree."
        ].join("\n"),
        flags: ["Ephemeral"]
      });
      return;
    }

    const url = interaction.options.getString("url")?.trim() || getDefaultWatchUrl();

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

    const webClient = createDelivereeWebClient();
    const inspection = await webClient.inspectBooking(url);
    await createDelivereeCaseStore().upsertObservation({
      bookingId: inspection.bookingId,
      screenshotPath: inspection.screenshotPath,
      status: inspection.classification.status,
      url
    });

    await interaction.editReply([
      `Deliveree #${inspection.bookingId}`,
      `Status: \`${inspection.classification.status}\``,
      `Mode: \`${getDelivereeRuntimeMode()}\``,
      inspection.classification.summary,
      `Rekomendasi: ${inspection.classification.recommendedAction}`,
      `Screenshot lokal: \`${inspection.screenshotPath}\``
    ].join("\n"));
  }
};

