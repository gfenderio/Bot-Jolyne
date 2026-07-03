import { SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { sendBaitoAttendanceForm } from "../schedulers/baito-attendance.js";
import { env } from "../config/env.js";
import type { SlashCommand } from "../types/command.js";

const ALLOWED_USERS = [
  "419213146209779713", // ID Anda
  env.BAITO_REXY_USER_ID,
  env.BAITO_AZIS_USER_ID
].filter(Boolean) as string[];

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("baito")
    .setDescription("Kirim form absensi baito ke DM Anda (Khusus Baito/Admin)"),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!ALLOWED_USERS.includes(interaction.user.id)) {
      await interaction.reply({
        content: "❌ Anda tidak memiliki izin untuk menggunakan command ini.",
        ephemeral: true
      });
      return;
    }

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
