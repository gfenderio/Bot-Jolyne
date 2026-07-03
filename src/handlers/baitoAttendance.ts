import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ButtonInteraction,
  ModalSubmitInteraction
} from "discord.js";
import { env } from "../config/env.js";
import { markAttendedToday } from "../services/baitoAttendanceStore.js";

export async function handleBaitoButton(interaction: ButtonInteraction) {
  if (interaction.customId === "baito_btn_in") {
    const modal = new ModalBuilder()
      .setCustomId("baito_modal_in")
      .setTitle("Form Kehadiran (Masuk)");

    const nameInput = new TextInputBuilder()
      .setCustomId("nama")
      .setLabel("Nama")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const divInput = new TextInputBuilder()
      .setCustomId("divisi")
      .setLabel("Divisi")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const timeInput = new TextInputBuilder()
      .setCustomId("jam_masuk")
      .setLabel("Estimasi Jam Masuk (ex: 13:00 - 19:00)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(divInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(timeInput)
    );

    await interaction.showModal(modal);
  } else if (interaction.customId === "baito_btn_out") {
    const modal = new ModalBuilder()
      .setCustomId("baito_modal_out")
      .setTitle("Form Kehadiran (Tidak Masuk)");

    const nameInput = new TextInputBuilder()
      .setCustomId("nama")
      .setLabel("Nama")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const divInput = new TextInputBuilder()
      .setCustomId("divisi")
      .setLabel("Divisi")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const reasonInput = new TextInputBuilder()
      .setCustomId("alasan")
      .setLabel("Keterangan/Alasan")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(divInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput)
    );

    await interaction.showModal(modal);
  }
}

export async function handleBaitoModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const isMasuk = interaction.customId === "baito_modal_in";
  
  const nama = interaction.fields.getTextInputValue("nama");
  const divisi = interaction.fields.getTextInputValue("divisi");
  
  let jamMasuk = "";
  let alasan = "";
  
  if (isMasuk) {
    jamMasuk = interaction.fields.getTextInputValue("jam_masuk");
  } else {
    alasan = interaction.fields.getTextInputValue("alasan") || "-";
  }

  const embed = new EmbedBuilder()
    .setTitle("Laporan Kehadiran Baito")
    .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
    .addFields(
      { name: "Nama", value: nama, inline: true },
      { name: "Divisi", value: divisi, inline: true },
      { name: "Status", value: isMasuk ? "✅ Masuk" : "❌ Tidak Masuk", inline: false }
    )
    .setColor(isMasuk ? 0x00ff00 : 0xff0000)
    .setTimestamp();

  if (isMasuk) {
    embed.addFields({ name: "Estimasi Jam Masuk", value: jamMasuk, inline: false });
  } else {
    embed.addFields({ name: "Keterangan", value: alasan, inline: false });
  }

  try {
    const channelId = env.BAITO_ATTENDANCE_CHANNEL_ID;
    if (channelId) {
      const channel = await interaction.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [embed] });
      }
    }

    markAttendedToday(interaction.user.id);

    await interaction.editReply("✅ Terima kasih! Absensi Anda berhasil disubmit.");
  } catch (error) {
    console.error("Gagal memproses absensi baito", error);
    await interaction.editReply("❌ Gagal mengirim absensi ke channel. Hubungi admin.");
  }
}
