import { SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import { addNotionTask, getPendingTasks } from "../services/notion.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("task")
    .setDescription("Kelola tugas di Notion Tracker (Jolyne)")
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Tambah tugas baru")
        .addStringOption(option => option.setName("nama").setDescription("Nama tugas").setRequired(true))
        .addStringOption(option => 
          option.setName("urgency")
            .setDescription("Tingkat urgensi")
            .setRequired(false)
            .addChoices(
              { name: "High", value: "High" },
              { name: "Medium", value: "Medium" },
              { name: "Low", value: "Low" }
            )
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("Lihat daftar tugas yang belum selesai")
    ),

  async execute(interaction) {
    await interaction.deferReply();
    const sub = interaction.options.getSubcommand();
    
    if (sub === "add") {
      const name = interaction.options.getString("nama", true);
      const urgency = interaction.options.getString("urgency") || "Medium";
      await addNotionTask(name, urgency, "Jolyne");
      await interaction.editReply(`✅ Tugas **${name}** [${urgency}] ditambahkan ke Jolyne Notion Tracker!`);
    } else if (sub === "list") {
      const tasks = await getPendingTasks("Jolyne");
      if (!tasks.length) {
        await interaction.editReply("🎉 Tidak ada tugas Jolyne yang tertunda. Kerja bagus!");
      } else {
        const list = tasks.map(t => {
          const title = t.properties['Task Name'].title[0]?.plain_text || 'Untitled';
          const urgency = t.properties['Urgency'].select?.name || 'Low';
          const status = t.properties['Status'].status?.name || 'To-Do';
          const emoji = urgency === 'High' ? '🔴' : (urgency === 'Medium' ? '🟡' : '🟢');
          return `${emoji} **${title}** (${status})`;
        }).join('\\n');
        await interaction.editReply(`📋 **Daftar Tugas Jolyne:**\\n${list}`);
      }
    }
  }
};
