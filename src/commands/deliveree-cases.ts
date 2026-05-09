import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { createDelivereeCaseStore } from "../deliveree/liveRuntime.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import type { SlashCommand } from "../types/command.js";

function toDiscordTimestamp(value: string) {
  return `<t:${Math.floor(new Date(value).getTime() / 1000)}:R>`;
}

function caseStateLabel(recoveryCase: {
  closedAt?: string;
  silencedAt?: string;
}) {
  if (recoveryCase.closedAt) {
    return "closed";
  }

  if (recoveryCase.silencedAt) {
    return "silenced";
  }

  return "active";
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-cases")
    .setDescription("Lihat daftar recovery case Deliveree terbaru")
    .addStringOption((option) =>
      option
        .setName("state")
        .setDescription("Filter status case")
        .addChoices(
          {
            name: "Active",
            value: "active"
          },
          {
            name: "Closed",
            value: "closed"
          },
          {
            name: "Silenced",
            value: "silenced"
          },
          {
            name: "All",
            value: "all"
          }
        )
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

    await interaction.deferReply({ flags: ["Ephemeral"] });

    const state = interaction.options.getString("state") ?? "active";
    const store = createDelivereeCaseStore();
    const cases = await store.listCases();
    const filteredCases = cases
      .filter((recoveryCase) => state === "all" || caseStateLabel(recoveryCase) === state)
      .sort((left, right) => new Date(right.lastObservedAt).getTime() - new Date(left.lastObservedAt).getTime())
      .slice(0, 10);

    const embed = new EmbedBuilder()
      .setColor(0x2f80ed)
      .setTitle("[Jolyne] Deliveree Cases")
      .setDescription(filteredCases.length
        ? `Menampilkan ${filteredCases.length} case terbaru. Gunakan \`/deliveree-case booking_id:<id>\` untuk detail.`
        : `Tidak ada Deliveree case dengan filter \`${state}\`.`)
      .setTimestamp();

    for (const recoveryCase of filteredCases) {
      const details = [
        `State: \`${caseStateLabel(recoveryCase)}\``,
        `Status: \`${recoveryCase.status}\`${recoveryCase.statusText ? ` (${recoveryCase.statusText})` : ""}`,
        `Last seen: ${toDiscordTimestamp(recoveryCase.lastObservedAt)}`
      ];

      if (recoveryCase.driverName) {
        details.push(`Driver: ${recoveryCase.driverName}`);
      }

      if (recoveryCase.plateNumber) {
        details.push(`Plat: \`${recoveryCase.plateNumber}\``);
      }

      if (recoveryCase.failureReason) {
        details.push(`Reason: ${recoveryCase.failureReason}`);
      }

      embed.addFields({
        inline: false,
        name: `#${recoveryCase.bookingId}`,
        value: details.join("\n")
      });
    }

    await interaction.editReply({
      embeds: [embed]
    });
  }
};
