import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import {
  getLatestDelivereeExtensionPageState,
  type StoredDelivereeExtensionPageState
} from "../deliveree/extensionIntake.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import type { SlashCommand } from "../types/command.js";

const STALE_AFTER_MS = 45_000;

function toUnixSeconds(value: string) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function formatDuration(from: string, nowMs = Date.now()) {
  const elapsedMs = Math.max(0, nowMs - new Date(from).getTime());
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${seconds} detik`;
  }

  return `${minutes} menit ${seconds} detik`;
}

function isStale(state: StoredDelivereeExtensionPageState, nowMs = Date.now()) {
  return nowMs - new Date(state.receivedAt).getTime() > STALE_AFTER_MS;
}

function colorForState(state: StoredDelivereeExtensionPageState) {
  if (state.status === "cancelled" || state.status === "no_driver_found") {
    return 0xeb5757;
  }

  if (state.status === "searching_driver" || state.status === "driver_assigned") {
    return 0xf2c94c;
  }

  if (state.pageKind === "front_page" || state.pageKind === "draft_page") {
    return 0x95a5a6;
  }

  return 0x2f80ed;
}

function describeState(state: StoredDelivereeExtensionPageState, nowMs: number) {
  if (state.pageKind === "front_page" || state.pageKind === "draft_page" || !state.bookingId) {
    return "Deliveree terbuka, tapi belum ada order aktif yang perlu dikirim.";
  }

  if (state.status === "searching_driver") {
    return `Order sedang mencari driver selama ${formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)}.`;
  }

  if (state.status === "driver_assigned") {
    return `Driver sudah terdeteksi selama ${formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)}.`;
  }

  if (state.status === "no_driver_found") {
    return "Order gagal karena belum mendapatkan driver.";
  }

  if (state.status === "cancelled") {
    return "Order terdeteksi cancelled.";
  }

  return "Deliveree terbuka dan extension mengirim status terakhir.";
}

function buildStatusEmbed(state: StoredDelivereeExtensionPageState | undefined) {
  const nowMs = Date.now();

  if (!state || isStale(state, nowMs)) {
    return new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle("[Jolyne] Deliveree Status")
      .setDescription("Deliveree belum terdeteksi terbuka dari extension lokal.")
      .addFields([
        {
          inline: false,
          name: "Action",
          value: "Buka halaman Deliveree di Chrome, pastikan extension aktif, lalu cek lagi."
        }
      ])
      .setTimestamp();
  }

  const fields = [
    {
      inline: true,
      name: "Device",
      value: `\`${state.deviceId}\``
    },
    {
      inline: true,
      name: "Last Seen",
      value: `<t:${toUnixSeconds(state.receivedAt)}:R>`
    }
  ];

  if (state.bookingId) {
    fields.push({
      inline: true,
      name: "Booking",
      value: `#${state.bookingId}`
    });
  }

  if (state.status) {
    fields.push({
      inline: true,
      name: "Status",
      value: `\`${state.status}\``
    });
  }

  if (state.status === "searching_driver" || state.status === "driver_assigned") {
    fields.push({
      inline: true,
      name: "Durasi Status",
      value: formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)
    });
  }

  if (state.failureReason) {
    fields.push({
      inline: false,
      name: "Reason",
      value: state.failureReason
    });
  }

  const title = state.bookingId
    ? `[Jolyne] Deliveree #${state.bookingId}`
    : "[Jolyne] Deliveree Status";

  return new EmbedBuilder()
    .setColor(colorForState(state))
    .setTitle(title)
    .setURL(state.pageUrl)
    .setDescription(describeState(state, nowMs))
    .addFields(fields)
    .setFooter({
      text: "Source: Chrome extension lokal"
    })
    .setTimestamp(new Date(state.receivedAt));
}

export const command: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName("deliveree-status")
    .setDescription("Cek status halaman Deliveree terakhir dari extension lokal."),

  async execute(interaction) {
    const deniedReason = getDelivereeAccessDeniedReason(interaction);

    if (deniedReason) {
      await interaction.reply({
        content: deniedReason,
        flags: ["Ephemeral"]
      });
      return;
    }

    await interaction.reply({
      embeds: [buildStatusEmbed(getLatestDelivereeExtensionPageState())],
      flags: ["Ephemeral"]
    });
  }
};
