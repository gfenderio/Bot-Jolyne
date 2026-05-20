import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { createDelivereeCaseStore } from "../deliveree/liveRuntime.js";
import {
  getLatestDelivereeExtensionPageState,
  type StoredDelivereeExtensionPageState
} from "../deliveree/extensionIntake.js";
import { getDelivereeAccessDeniedReason } from "../security/discordAccess.js";
import type { SlashCommand } from "../types/command.js";

const STALE_AFTER_MS = 45_000;
const activeOrderStatuses = new Set([
  "searching_driver",
  "active_booking",
  "driver_assigned",
  "going_to_pickup",
  "waiting_pickup",
  "going_to_destination",
  "arrived_destination"
]);

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

  if (state.status && activeOrderStatuses.has(state.status)) {
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

  if (state.status === "active_booking") {
    return `Order aktif terbaca selama ${formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)}.`;
  }

  if (state.status === "driver_assigned") {
    return `Driver sudah terdeteksi selama ${formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)}.`;
  }

  if (state.status === "going_to_pickup") {
    return `Driver sedang menuju lokasi penjemputan selama ${formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)}.`;
  }

  if (state.status === "waiting_pickup") {
    return `Driver menunggu proses pickup selama ${formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)}.`;
  }

  if (state.status === "going_to_destination") {
    return `Driver sedang menuju tujuan${state.etaText ? ` dengan ETA ${state.etaText}` : ""}.`;
  }

  if (state.status === "arrived_destination") {
    return "Driver sudah sampai di tujuan. Pantau sampai order selesai.";
  }

  if (state.status === "no_driver_found") {
    return "Order gagal karena belum mendapatkan driver.";
  }

  if (state.status === "cancelled") {
    return "Order terdeteksi cancelled.";
  }

  if (state.status === "completed") {
    return "Order Deliveree sudah selesai.";
  }

  return "Deliveree terbuka dan extension mengirim status terakhir.";
}

async function getLatestStoredCaseState(): Promise<StoredDelivereeExtensionPageState | undefined> {
  const cases = await createDelivereeCaseStore().listCases();
  const latest = cases
    .filter((recoveryCase) => recoveryCase.deviceId && recoveryCase.lastHeartbeatAt)
    .sort((left, right) => String(right.lastHeartbeatAt).localeCompare(String(left.lastHeartbeatAt)))[0];

  if (!latest?.deviceId || !latest.lastHeartbeatAt) {
    return undefined;
  }

  return {
    bookingId: latest.bookingId,
    deviceId: latest.deviceId,
    driverName: latest.driverName,
    etaText: latest.etaText,
    failureReason: latest.failureReason,
    lateText: latest.lateText,
    observedAt: latest.lastObservedAt,
    pageKind: latest.lastPageKind ?? "booking_detail",
    pageUrl: latest.url,
    plateNumber: latest.plateNumber,
    receivedAt: latest.lastHeartbeatAt,
    schemaVersion: 1,
    status: latest.status,
    statusStartedAt: latest.lastStatusChangeAt,
    statusText: latest.statusText,
    vehicleDescription: latest.vehicleDescription
  };
}

async function getStatusState() {
  return getLatestDelivereeExtensionPageState() ?? await getLatestStoredCaseState();
}

function buildStatusEmbed(state: StoredDelivereeExtensionPageState | undefined) {
  const nowMs = Date.now();

  if (!state) {
    return new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle("Kyou Deliveree Status")
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

  const stale = isStale(state, nowMs);
  const fields = [
    {
      inline: true,
      name: "Device",
      value: `\`${state.deviceId}\``
    },
    {
      inline: true,
      name: "Heartbeat",
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

  if (state.statusText) {
    fields.push({
      inline: false,
      name: "Info Status",
      value: state.statusText
    });
  }

  if (state.statusStartedAt) {
    fields.push({
      inline: true,
      name: "Status Berubah",
      value: `<t:${toUnixSeconds(state.statusStartedAt)}:R>`
    });
  }

  if (state.status && activeOrderStatuses.has(state.status)) {
    fields.push({
      inline: true,
      name: "Durasi Status",
      value: formatDuration(state.statusStartedAt ?? state.observedAt, nowMs)
    });
  }

  if (state.driverName) {
    fields.push({
      inline: true,
      name: "Driver",
      value: state.driverName
    });
  }

  if (state.plateNumber) {
    fields.push({
      inline: true,
      name: "Plat",
      value: `\`${state.plateNumber}\``
    });
  }

  if (state.etaText) {
    fields.push({
      inline: true,
      name: "ETA",
      value: state.etaText
    });
  }

  if (state.lateText) {
    fields.push({
      inline: true,
      name: "Keterlambatan",
      value: state.lateText
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
    ? `Kyou Deliveree #${state.bookingId}`
    : "Kyou Deliveree Status";

  if (stale) {
    fields.push({
      inline: false,
      name: "Action",
      value: "Heartbeat sudah stale. Pastikan Chrome, tab Deliveree, extension, dan local intake masih aktif."
    });
  }

  return new EmbedBuilder()
    .setColor(stale ? 0x95a5a6 : colorForState(state))
    .setTitle(title)
    .setURL(state.pageUrl)
    .setDescription(stale
      ? `Data terakhir ada, tapi heartbeat sudah stale selama ${formatDuration(state.receivedAt, nowMs)}. Status terakhir: ${state.status ? `\`${state.status}\`` : "-"}`
      : describeState(state, nowMs))
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
      embeds: [buildStatusEmbed(await getStatusState())],
      flags: ["Ephemeral"]
    });
  }
};
