import { SlashCommandBuilder } from "discord.js";
import { buildMockOrderMessage } from "../deliveree/mockOrderEmbed.js";
import { availableMockDelivereeBookingIds, getNextMockDelivereeTrackingResult } from "../deliveree/mockRuntime.js";
import type { SlashCommand } from "../types/command.js";

const DEFAULT_BOOKING_ID = "19320032";

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
        ...buildMockOrderMessage({
          bookingId,
          notice: [
            `Booking ID \`${bookingId}\` tidak ada di mock data.`,
            `Coba salah satu: ${availableMockDelivereeBookingIds.map((id) => `\`${id}\``).join(", ")}.`
          ].join("\n")
        }, {
          controlsDisabled: true
        }),
        flags: ["Ephemeral"]
      });
      return;
    }

    const state = {
      bookingId: result.order.bookingId,
      changed: result.changed,
      order: result.order,
      previousStatus: result.previousStatus
    };

    await interaction.reply({
      ...buildMockOrderMessage(state),
      flags: ["Ephemeral"]
    });
  }
};
