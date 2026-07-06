import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import { env } from "../config/env.js";
import { buildOripaLiveRecap, resolveRecapRange } from "../services/oripaLiveRecap.js";
import type { OripaLiveRecapPeriod } from "../services/oripaLiveRecap.js";

function isRecapUserAllowed(userId: string): boolean {
  return (env.ORIPA_LIVE_RECAP_USER_IDS ?? []).includes(userId);
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("live-recap")
    .setDescription("Rekap sesi live oripa untuk HR")
    .addStringOption((option) =>
      option
        .setName("periode")
        .setDescription("Periode rekap")
        .setRequired(true)
        .addChoices(
          { name: "Minggu ini", value: "minggu-ini" },
          { name: "Bulan ini", value: "bulan-ini" },
          { name: "Bulan lalu", value: "bulan-lalu" }
        )
    ),

  async execute(interaction) {
    if (!isRecapUserAllowed(interaction.user.id)) {
      await interaction.reply({
        content: "❌ Kamu tidak memiliki izin untuk melihat rekap live oripa.",
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply();

    try {
      const period = interaction.options.getString("periode", true) as OripaLiveRecapPeriod;
      const range = resolveRecapRange(period);
      const recap = await buildOripaLiveRecap(range);

      await interaction.editReply({
        embeds: [recap.embed],
        files: recap.attachment ? [recap.attachment] : []
      });
    } catch (error) {
      console.error("Gagal membuat rekap live oripa", error);
      await interaction.editReply("❌ Gagal membuat rekap live. Cek log bot.");
    }
  }
};
