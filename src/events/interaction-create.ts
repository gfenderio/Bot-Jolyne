import { DiscordAPIError } from "discord.js";
import type { Interaction } from "discord.js";
import { commands } from "../commands/index.js";
import { TASK_MODAL_ID } from "../commands/task.js";
import { createTask } from "../services/notion.js";

export async function handleInteractionCreate(interaction: Interaction) {
  if (interaction.isModalSubmit()) {
    if (interaction.customId === TASK_MODAL_ID) {
      await interaction.deferReply({ ephemeral: true });
      const name = interaction.fields.getTextInputValue("task_name");
      const project = interaction.fields.getTextInputValue("task_project");
      const priority = interaction.fields.getTextInputValue("task_priority");
      const desc = interaction.fields.getTextInputValue("task_desc");

      try {
        await createTask({ name, priority, project, description: desc || undefined });
        await interaction.editReply(
          `✅ Task ditambahkan!\n**${name}**\n> Project: ${project} · Prioritas: ${priority}`
        );
      } catch (err) {
        console.error("Gagal tambah task ke Notion", err);
        await interaction.editReply("❌ Gagal tambah task. Cek log dan pastikan NOTION_TOKEN sudah diset.");
      }
      return;
    }
  }

  if (interaction.isButton()) {
    // Deliveree buttons removed
    return;
  }

  if (!interaction.isChatInputCommand()) {
    return;
  }

  const availableCommands = [...commands.keys()].join(", ");
  console.log(`Slash command diterima: /${interaction.commandName}. Command aktif: ${availableCommands}`);

  const command = commands.get(interaction.commandName);

  if (!command) {
    await interaction.reply({
      content: `Command tidak ditemukan di runtime ini. Command aktif: ${availableCommands}.`,
      flags: ["Ephemeral"]
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Gagal menjalankan /${interaction.commandName}`, error);

    const response = {
      content: "Terjadi error saat menjalankan command.",
      flags: ["Ephemeral"] as const
    };

    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(response);
        return;
      }

      await interaction.reply(response);
    } catch (replyError) {
      if (replyError instanceof DiscordAPIError) {
        console.error("Gagal mengirim error response ke Discord.", {
          code: replyError.code,
          status: replyError.status
        });
        return;
      }

      throw replyError;
    }
  }
}
