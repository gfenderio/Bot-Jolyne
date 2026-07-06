import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import { env } from "../config/env.js";
import {
  buildOripaLiveRecap,
  resolveCustomRecapRange,
  resolveRecapRange
} from "../services/oripaLiveRecap.js";
import type { OripaLiveRecapPeriod, OripaLiveRecapRange } from "../services/oripaLiveRecap.js";

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
        .setDescription("Periode rekap (abaikan kalau pakai tanggal custom)")
        .setRequired(false)
        .addChoices(
          { name: "Minggu ini", value: "minggu-ini" },
          { name: "Bulan ini", value: "bulan-ini" },
          { name: "Bulan lalu", value: "bulan-lalu" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("dari")
        .setDescription("Tanggal awal custom, mis. 2026-07-01 atau 01-07-2026")
        .setRequired(false)
    )
    .addStringOption((option) =>
      option
        .setName("sampai")
        .setDescription("Tanggal akhir custom (kosong = sampai hari ini)")
        .setRequired(false)
    ),

  async execute(interaction) {
    if (!isRecapUserAllowed(interaction.user.id)) {
      await interaction.reply({
        content: "❌ Kamu tidak memiliki izin untuk melihat rekap live oripa.",
        ephemeral: true
      });
      return;
    }

    const periodOption = interaction.options.getString("periode") as OripaLiveRecapPeriod | null;
    const dari = interaction.options.getString("dari");
    const sampai = interaction.options.getString("sampai");

    if (!periodOption && !dari) {
      await interaction.reply({
        content:
          "⚠️ Pilih salah satu: opsi `periode` (minggu ini/bulan ini/bulan lalu) **atau** isi `dari` (+ `sampai` opsional) untuk rentang tanggal custom.",
        ephemeral: true
      });
      return;
    }

    if (sampai && !dari) {
      await interaction.reply({
        content: "⚠️ Opsi `sampai` hanya bisa dipakai bersama `dari`.",
        ephemeral: true
      });
      return;
    }

    let range: OripaLiveRecapRange;

    if (dari) {
      const custom = resolveCustomRecapRange(dari, sampai);

      if (!custom.ok) {
        await interaction.reply({ content: `❌ ${custom.error}`, ephemeral: true });
        return;
      }

      range = custom.range;
    } else {
      range = resolveRecapRange(periodOption as OripaLiveRecapPeriod);
    }

    await interaction.deferReply();

    try {
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
