import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from "discord.js";
import type { SlashCommand } from "../types/command.js";

export const TASK_MODAL_ID = "task_modal";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("task")
    .setDescription("Tambah task baru ke Notion Work Dashboard"),

  async execute(interaction) {
    const modal = new ModalBuilder()
      .setCustomId(TASK_MODAL_ID)
      .setTitle("Tambah Task Baru");

    const nameRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("task_name")
        .setLabel("Nama Task")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Contoh: Fix bug scan barcode di Pack Works")
        .setRequired(true)
    );

    const projectRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("task_project")
        .setLabel("Project")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("Machitan / Bot-Jolyne / Operasional / Infra")
        .setRequired(true)
    );

    const priorityRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("task_priority")
        .setLabel("Prioritas")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("High / Medium / Low")
        .setValue("Medium")
        .setRequired(true)
    );

    const descRow = new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId("task_desc")
        .setLabel("Deskripsi (opsional)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(500)
    );

    modal.addComponents(nameRow, projectRow, priorityRow, descRow);
    await interaction.showModal(modal);
  },
};
