import {
  LabelBuilder,
  ModalBuilder,
  RadioGroupBuilder,
  RadioGroupOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";
import type { ModalSubmitInteraction } from "discord.js";
import { env } from "../config/env.js";
import {
  buildOripaLiveRecap,
  resolveCustomRecapRange,
  resolveRecapRange
} from "../services/oripaLiveRecap.js";
import type { OripaLiveRecapPeriod, OripaLiveRecapRange } from "../services/oripaLiveRecap.js";

export const ORIPA_LIVE_RECAP_MODAL_ID = "oripa_live_recap_modal";

export function isOripaLiveRecapUserAllowed(userId: string): boolean {
  return (env.ORIPA_LIVE_RECAP_USER_IDS ?? []).includes(userId);
}

export function buildOripaLiveRecapModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(ORIPA_LIVE_RECAP_MODAL_ID)
    .setTitle("Rekap Live Oripa")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Periode")
        .setRadioGroupComponent(
          new RadioGroupBuilder()
            .setCustomId("recap_period")
            .addOptions(
              new RadioGroupOptionBuilder().setLabel("Minggu ini").setValue("minggu-ini"),
              new RadioGroupOptionBuilder().setLabel("Bulan ini").setValue("bulan-ini"),
              new RadioGroupOptionBuilder().setLabel("Bulan lalu").setValue("bulan-lalu"),
              new RadioGroupOptionBuilder()
                .setLabel("Tanggal custom")
                .setDescription("Isi kolom tanggal di bawah")
                .setValue("custom")
            )
        ),
      new LabelBuilder()
        .setLabel("Dari tanggal (untuk custom)")
        .setDescription("Contoh: 2026-07-01 atau 01-07-2026")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("recap_dari")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(12)
        ),
      new LabelBuilder()
        .setLabel("Sampai tanggal (untuk custom)")
        .setDescription("Kosongkan untuk sampai hari ini.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("recap_sampai")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(12)
        )
    );
}

export async function handleOripaLiveRecapModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply();

  if (!isOripaLiveRecapUserAllowed(interaction.user.id)) {
    await interaction.editReply("❌ Kamu tidak memiliki izin untuk melihat rekap live oripa.");
    return;
  }

  const period = interaction.fields.getRadioGroup("recap_period", true);
  const dari = interaction.fields.getTextInputValue("recap_dari").trim();
  const sampai = interaction.fields.getTextInputValue("recap_sampai").trim();

  let range: OripaLiveRecapRange;

  if (dari !== "") {
    // Tanggal diisi → pakai rentang custom, apapun pilihan radionya.
    const custom = resolveCustomRecapRange(dari, sampai || null);

    if (!custom.ok) {
      await interaction.editReply(`❌ ${custom.error}`);
      return;
    }

    range = custom.range;
  } else if (period === "custom") {
    await interaction.editReply(
      "⚠️ Kamu memilih **Tanggal custom** tapi kolom `Dari tanggal` kosong. Ulangi `/live-recap` dan isi tanggalnya (contoh: `2026-07-01`)."
    );
    return;
  } else {
    range = resolveRecapRange(period as OripaLiveRecapPeriod);
  }

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
