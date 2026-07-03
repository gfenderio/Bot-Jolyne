import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { sendBaitoAttendanceForm } from "../schedulers/baito-attendance.js";

import type { SlashCommand } from "../types/command.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("baito-test")
    .setDescription("Test kirim form absensi baito ke DM Anda"),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      await sendBaitoAttendanceForm(interaction.client, interaction.user.id);
      await interaction.editReply("✅ Form absensi berhasil dikirim ke DM Anda.");
    } catch (error) {
      console.error("Gagal tes form absensi", error);
      await interaction.editReply("❌ Gagal mengirim form absensi. Cek console log.");
    }
  }
};
