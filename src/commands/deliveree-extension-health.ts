import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { SlashCommand } from "../types/command.js";
import { env } from "../config/env.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import { createDelivereeCaseStore } from "../deliveree/liveRuntime.js";

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-extension-health")
    .setDescription("Lihat status extension device dan case terakhir"),
  async execute(interaction) {
    const deniedReason = getDelivereeAccessDeniedReason(interaction);

    if (deniedReason) {
      await interaction.reply({
        content: deniedReason,
        flags: ["Ephemeral"]
      });
      return;
    }

    await interaction.deferReply({ flags: ["Ephemeral"] });

    const store = createDelivereeCaseStore();
    const cases = await store.listCases();
    const activeCases = cases.filter((c) => !c.closedAt && !c.silencedAt);
    const recentCases = cases
      .sort((a, b) => new Date(b.lastObservedAt).getTime() - new Date(a.lastObservedAt).getTime())
      .slice(0, 5);

    const deviceActivity = new Map<string, { lastSeen: string; count: number }>();

    for (const recoveryCase of cases) {
      const deviceLog = recoveryCase.actionLog.find((log) => log.note?.includes("extension"));
      if (deviceLog) {
        const existing = deviceActivity.get("extension") || { count: 0, lastSeen: recoveryCase.lastObservedAt };
        deviceActivity.set("extension", {
          count: existing.count + 1,
          lastSeen: new Date(recoveryCase.lastObservedAt) > new Date(existing.lastSeen)
            ? recoveryCase.lastObservedAt
            : existing.lastSeen
        });
      }
    }

    const fields = [
      {
        inline: true,
        name: "Active Cases",
        value: String(activeCases.length)
      },
      {
        inline: true,
        name: "Total Cases",
        value: String(cases.length)
      },
      {
        inline: true,
        name: "Extension Enabled",
        value: env.DELIVEREE_EXTENSION_ENABLED ? "✅ Yes" : "❌ No"
      }
    ];

    if (deviceActivity.size > 0) {
      for (const [device, activity] of deviceActivity) {
        fields.push({
          inline: false,
          name: `Device: ${device}`,
          value: `Last seen: <t:${Math.floor(new Date(activity.lastSeen).getTime() / 1000)}:R> | Observations: ${activity.count}`
        });
      }
    }

    if (recentCases.length > 0) {
      fields.push({
        inline: false,
        name: "Recent Cases",
        value: recentCases
          .map((c) => `#${c.bookingId} - \`${c.status}\` - <t:${Math.floor(new Date(c.lastObservedAt).getTime() / 1000)}:R>`)
          .join("\n")
      });
    }

    const embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle("[Jolyne] Deliveree Extension Health")
      .setDescription("Status extension device dan recovery cases.")
      .addFields(fields)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
};
