import { SlashCommandBuilder } from "discord.js";
import { formatDelivereeDiscordMessage } from "../deliveree/discordNotifier.js";
import { availableMockDelivereeBookingIds, getNextMockDelivereeTrackingResult } from "../deliveree/mockRuntime.js";
import { mapDelivereeStatusToLabel } from "../deliveree/statusMapper.js";
import type { SlashCommand } from "../types/command.js";

const DEFAULT_BOOKING_ID = "19320032";

function codeBlock(content: string) {
  return `\`\`\`text\n${content}\n\`\`\``;
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("track-test")
    .setDescription("Tes tracking Deliveree dari mock data lokal.")
    .addStringOption((option) => {
      return option
        .setName("booking_id")
        .setDescription(`Booking ID mock. Default: ${DEFAULT_BOOKING_ID}`)
        .setRequired(false);
    }),

  async execute(interaction) {
    const bookingId = interaction.options.getString("booking_id")?.trim() || DEFAULT_BOOKING_ID;
    const result = await getNextMockDelivereeTrackingResult(bookingId);

    if (!result.order) {
      await interaction.reply({
        content: [
          `Booking ID \`${bookingId}\` tidak ada di mock data.`,
          `Coba salah satu: ${availableMockDelivereeBookingIds.map((id) => `\`${id}\``).join(", ")}.`
        ].join("\n"),
        flags: ["Ephemeral"]
      });
      return;
    }

    if (!result.changed) {
      await interaction.reply({
        content: [
          `[Jolyne] Status Deliveree #${result.order.bookingId} belum berubah.`,
          `Status terakhir: ${mapDelivereeStatusToLabel(result.order.status)}`
        ].join("\n"),
        flags: ["Ephemeral"]
      });
      return;
    }

    await interaction.reply(codeBlock(formatDelivereeDiscordMessage(result.order)));
  }
};
