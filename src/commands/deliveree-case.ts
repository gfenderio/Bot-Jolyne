import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { buildDelivereeExtensionManualComponents } from "../deliveree/extensionIntake.js";
import { createDelivereeCaseStore } from "../deliveree/liveRuntime.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import type { SlashCommand } from "../types/command.js";

function toDiscordTimestamp(value: string, format: "F" | "R" | "t" = "R") {
  return `<t:${Math.floor(new Date(value).getTime() / 1000)}:${format}>`;
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-case")
    .setDescription("Lihat detail recovery case Deliveree")
    .addStringOption((option) =>
      option
        .setName("booking_id")
        .setDescription("Booking ID Deliveree")
        .setRequired(true)
    ),

  async execute(interaction) {
    const deniedReason = getDelivereeAccessDeniedReason(interaction);

    if (deniedReason) {
      await interaction.reply({
        content: deniedReason,
        flags: ["Ephemeral"]
      });
      return;
    }

    const bookingId = interaction.options.getString("booking_id", true);
    await interaction.deferReply({ flags: ["Ephemeral"] });

    const store = createDelivereeCaseStore();
    const recoveryCase = await store.getCase(bookingId);

    if (!recoveryCase) {
      await interaction.editReply(`Recovery case untuk booking #${bookingId} tidak ditemukan.`);
      return;
    }

    const fields = [
      {
        inline: true,
        name: "Status",
        value: `\`${recoveryCase.status}\``
      },
      {
        inline: true,
        name: "Case Status",
        value: recoveryCase.closedAt
          ? "Closed"
          : recoveryCase.silencedAt
            ? "Silenced"
            : "Active"
      },
      {
        inline: true,
        name: "Retry Count",
        value: String(recoveryCase.retryCount)
      },
      {
        inline: false,
        name: "Last Observed",
        value: toDiscordTimestamp(recoveryCase.lastObservedAt, "F")
      },
      {
        inline: false,
        name: "Last Status Change",
        value: toDiscordTimestamp(recoveryCase.lastStatusChangeAt)
      }
    ];

    if (recoveryCase.statusText) {
      fields.push({
        inline: true,
        name: "Status Text",
        value: recoveryCase.statusText
      });
    }

    if (recoveryCase.deviceId) {
      fields.push({
        inline: true,
        name: "Device",
        value: `\`${recoveryCase.deviceId}\``
      });
    }

    if (recoveryCase.driverName) {
      fields.push({
        inline: true,
        name: "Driver",
        value: recoveryCase.driverName
      });
    }

    if (recoveryCase.plateNumber) {
      fields.push({
        inline: true,
        name: "Plat",
        value: `\`${recoveryCase.plateNumber}\``
      });
    }

    if (recoveryCase.etaText) {
      fields.push({
        inline: true,
        name: "ETA",
        value: recoveryCase.etaText
      });
    }

    if (recoveryCase.failureReason) {
      fields.push({
        inline: false,
        name: "Failure Reason",
        value: recoveryCase.failureReason
      });
    }

    if (recoveryCase.silencedAt) {
      fields.push({
        inline: false,
        name: "Silenced",
        value: `${toDiscordTimestamp(recoveryCase.silencedAt)}\n${recoveryCase.silenceReason || "No reason"}`
      });
    }

    if (recoveryCase.closedAt) {
      fields.push({
        inline: false,
        name: "Closed",
        value: toDiscordTimestamp(recoveryCase.closedAt)
      });
    }

    const recentActions = recoveryCase.actionLog
      .slice(-5)
      .reverse()
      .map((log) => `${toDiscordTimestamp(log.at, "t")} - \`${log.action}\`${log.note ? ` - ${log.note}` : ""}`)
      .join("\n");

    if (recentActions) {
      fields.push({
        inline: false,
        name: "Recent Actions",
        value: recentActions
      });
    }

    const embed = new EmbedBuilder()
      .setColor(recoveryCase.closedAt ? 0x95a5a6 : recoveryCase.silencedAt ? 0xf39c12 : 0x3498db)
      .setTitle(`[Jolyne] Deliveree Case #${recoveryCase.bookingId}`)
      .setDescription(`Case ID: \`${recoveryCase.caseId}\``)
      .addFields(fields)
      .setTimestamp();

    if (recoveryCase.url) {
      embed.setURL(recoveryCase.url);
    }

    await interaction.editReply({
      components: recoveryCase.closedAt || recoveryCase.silencedAt
        ? []
        : buildDelivereeExtensionManualComponents(recoveryCase.caseId),
      embeds: [embed]
    });
  }
};
