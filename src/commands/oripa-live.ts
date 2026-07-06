import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import {
  buildOripaLiveEndModal,
  buildOripaLiveStartModal,
  isOripaLiveUserAllowed
} from "../handlers/oripaLive.js";
import { getActiveLiveSession } from "../services/oripaLiveStore.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("live")
    .setDescription("Laporan live IG/TikTok staff oripa")
    .addSubcommand((sub) =>
      sub.setName("start").setDescription("Mulai sesi live (isi form selfie proof + keterangan)")
    )
    .addSubcommand((sub) =>
      sub.setName("end").setDescription("Akhiri sesi live (isi form foto insight + keterangan)")
    ),

  async execute(interaction) {
    if (!isOripaLiveUserAllowed(interaction.user.id)) {
      await interaction.reply({
        content: "❌ Kamu tidak memiliki izin untuk laporan live oripa.",
        ephemeral: true
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const active = getActiveLiveSession();

    if (subcommand === "start") {
      if (active) {
        await interaction.reply({
          content: "⚠️ Masih ada sesi live yang belum ditutup. Tutup dulu dengan `/live end`.",
          ephemeral: true
        });
        return;
      }

      await interaction.showModal(buildOripaLiveStartModal());
      return;
    }

    if (subcommand === "end") {
      if (!active) {
        await interaction.reply({
          content: "⚠️ Tidak ada sesi live yang sedang berjalan. Mulai dulu dengan `/live start`.",
          ephemeral: true
        });
        return;
      }

      await interaction.showModal(buildOripaLiveEndModal());
      return;
    }
  }
};
