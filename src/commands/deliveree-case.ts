import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import { createDelivereeCaseStore } from "../deliveree/liveRuntime.js";

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
        name: "Retry Count",
        value: String(recoveryCase.retryCount)
      },
      {
        inline: true,
        name: "Case Status",
        value: recoveryCase.closedAt
          ? "❌ Closed"
          : recoveryCase.silencedAt
            ? "🔇 Silenced"
            : "✅ Active"
      },
      {
        inline: false,
        name: "Last Observed",
        value: `<t:${Math.floor(new Date(recoveryCase.lastObservedAt).getTime() / 1000)}:F>`
      },
      {
        inline: false,
        name: "Last Status Change",
        value: `<t:${Math.floor(new Date(recoveryCase.lastStatusChangeAt).getTime() / 1000)}:R>`
      }
    ];

    if (recoveryCase.stuckDriverAlertSentAt) {
      fields.push({
        inline: false,
        name: "Stuck Driver Alert",
        value: `Sent <t:${Math.floor(new Date(recoveryCase.stuckDriverAlertSentAt).getTime() / 1000)}:R>`
      });
    }

    if (recoveryCase.silencedAt) {
      fields.push({
        inline: false,
        name: "Silenced",
        value: `<t:${Math.floor(new Date(recoveryCase.silencedAt).getTime() / 1000)}:R>\n${recoveryCase.silenceReason || "No reason"}`
      });
    }

    if (recoveryCase.closedAt) {
      fields.push({
        inline: false,
        name: "Closed",
        value: `<t:${Math.floor(new Date(recoveryCase.closedAt).getTime() / 1000)}:R>`
      });
    }

    const recentActions = recoveryCase.actionLog
      .slice(-5)
      .reverse()
      .map((log) => `<t:${Math.floor(new Date(log.at).getTime() / 1000)}:t> - \`${log.action}\` ${log.note ? `- ${log.note}` : ""}`)
      .join("\n");

    if (recentActions) {
      fields.push({
        inline: false,
        name: "Recent Actions (last 5)",
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

    await interaction.editReply({ embeds: [embed] });
  }
};
