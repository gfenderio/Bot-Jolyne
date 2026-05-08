import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import { createDelivereeCaseStore } from "../deliveree/liveRuntime.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-silence")
    .setDescription("Mute alert untuk recovery case Deliveree tertentu")
    .addStringOption((option) =>
      option
        .setName("booking_id")
        .setDescription("Booking ID Deliveree")
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("reason")
        .setDescription("Alasan silence case ini")
        .setRequired(false)
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
    const reason = interaction.options.getString("reason") || "Silenced via slash command";

    await interaction.deferReply({ flags: ["Ephemeral"] });

    const store = createDelivereeCaseStore();
    const recoveryCase = await store.getCase(bookingId);

    if (!recoveryCase) {
      await interaction.editReply(`Recovery case untuk booking #${bookingId} tidak ditemukan.`);
      return;
    }

    if (recoveryCase.closedAt) {
      await interaction.editReply(`Recovery case #${bookingId} sudah ditutup.`);
      return;
    }

    if (recoveryCase.silencedAt) {
      await interaction.editReply(`Recovery case #${bookingId} sudah di-silence sebelumnya.`);
      return;
    }

    await store.silenceCase(bookingId, interaction.user.id, reason);

    await interaction.editReply(
      `Recovery case Deliveree #${bookingId} berhasil di-silence. Alert tidak akan muncul lagi untuk case ini.\n\nReason: ${reason}`
    );
  }
};
