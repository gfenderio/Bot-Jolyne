import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import { getMockOrderOutcome } from "./mockOrderGenerator.js";
import type { CreatedMockOrder } from "./mockOrderGenerator.js";
import { mapDelivereeStatusToLabel } from "./statusMapper.js";
import type { DelivereeMockScenario, DelivereeOrderSnapshot, DelivereeStatus } from "./types.js";

const JAKARTA_TIME_ZONE = "Asia/Jakarta";

export type MockOrderDecision = {
  decidedAt: string;
  type: "cancel" | "reorder";
  userLabel: string;
};

export type MockOrderViewState = {
  bookingId: string;
  changed?: boolean;
  createdOrder?: CreatedMockOrder;
  decision?: MockOrderDecision;
  notice?: string;
  order?: DelivereeOrderSnapshot;
  previousStatus?: DelivereeStatus;
};

type MockOrderMessageOptions = {
  controlsDisabled?: boolean;
};

function formatOptional(value: string | number | undefined) {
  return value === undefined || value === "" ? "-" : String(value);
}

function formatDateTime(value: string | undefined) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return `${new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: JAKARTA_TIME_ZONE,
    year: "numeric"
  }).format(date)} WIB`;
}

function getViewStatus(state: MockOrderViewState) {
  return state.order?.status ?? state.createdOrder?.initialStatus;
}

function getViewScenario(state: MockOrderViewState): DelivereeMockScenario | undefined {
  return state.order?.scenario ?? state.createdOrder?.scenario;
}

function getStatusColor(status: DelivereeStatus | undefined, decision: MockOrderDecision | undefined) {
  if (decision?.type === "cancel" || status === "cancelled") {
    return 0xeb5757;
  }

  if (decision?.type === "reorder") {
    return 0x27ae60;
  }

  if (status === "completed") {
    return 0x219653;
  }

  if (status === "driver_assigned" || status === "arrived_at_pickup" || status === "on_delivery") {
    return 0x2f80ed;
  }

  return 0xf2c94c;
}

function buildStatusSummary(state: MockOrderViewState) {
  if (state.decision?.type === "reorder") {
    return "Recovery dipilih: reorder. Tim bisa lanjut menyiapkan replacement order dan tetap memantau status terakhir.";
  }

  if (state.decision?.type === "cancel") {
    return "Recovery dipilih: cancel. Tracking mock order dihentikan untuk simulasi ini.";
  }

  if (state.notice) {
    return state.notice;
  }

  const status = getViewStatus(state);

  if (!status) {
    return "Mock tracking siap dipantau.";
  }

  if (state.changed === false) {
    return "Status belum berubah dari pengecekan terakhir. Gunakan refresh untuk mengambil snapshot berikutnya.";
  }

  if (status === "searching_driver") {
    return "Order masuk dan sedang mencari driver.";
  }

  if (status === "driver_assigned") {
    return "Driver sudah assigned. Pantau progress pickup dan siapkan recovery jika status berhenti terlalu lama.";
  }

  if (status === "arrived_at_pickup") {
    return "Driver sudah tiba di pickup point.";
  }

  if (status === "on_delivery" || status === "near_destination") {
    return "Order sedang berjalan menuju tujuan.";
  }

  if (status === "completed") {
    return "Order selesai. Tidak ada recovery action yang diperlukan.";
  }

  return "Order cancelled. Pilih reorder untuk replacement atau cancel untuk menutup simulasi recovery.";
}

function buildOutcome(state: MockOrderViewState) {
  const scenario = getViewScenario(state);
  const baseOutcome = state.createdOrder?.outcome
    ?? (scenario ? getMockOrderOutcome(scenario) : undefined);

  if (state.order?.status === "cancelled") {
    return [
      baseOutcome ?? "Order cancelled.",
      "Opsi recovery: pilih Reorder untuk replacement, atau Cancel untuk menutup simulasi."
    ].join("\n");
  }

  if (state.order?.status === "driver_assigned" && scenario?.startsWith("stuck_driver")) {
    return [
      baseOutcome,
      "Jika status berhenti terlalu lama, gunakan Reorder atau Cancel dari tombol recovery."
    ].filter(Boolean).join("\n");
  }

  if (state.order?.status === "completed") {
    return "Order completed. Simulasi bisa ditutup tanpa action tambahan.";
  }

  return baseOutcome ?? "Refresh status untuk melanjutkan simulasi perjalanan order.";
}

function formatDecision(decision: MockOrderDecision) {
  const action = decision.type === "reorder" ? "Reorder" : "Cancel";

  return [
    `Action: **${action}**`,
    `Dipilih oleh: ${decision.userLabel}`,
    `Waktu: ${formatDateTime(decision.decidedAt)}`
  ].join("\n");
}

export function buildMockOrderEmbed(state: MockOrderViewState) {
  const status = getViewStatus(state);
  const statusLabel = status ? mapDelivereeStatusToLabel(status) : "-";
  const scenario = getViewScenario(state);
  const previousStatusLabel = state.previousStatus ? mapDelivereeStatusToLabel(state.previousStatus) : "-";
  const bookingDetails = [
    `Booking ID: \`${state.bookingId}\``,
    `Status: **${statusLabel}**`,
    `Scenario: ${scenario ? `\`${scenario}\`` : "-"}`,
    `Slot demo: ${state.createdOrder?.slot ?? "-"}`
  ].join("\n");
  const driverDetails = [
    `Driver: ${formatOptional(state.order?.driverName)}`,
    `Plat: ${formatOptional(state.order?.vehiclePlate)}`,
    `ETA: ${formatOptional(state.order?.eta)}`
  ].join("\n");
  const trackingDetails = [
    `Status sebelumnya: ${previousStatusLabel}`,
    `Status berubah: ${state.changed === undefined ? "-" : state.changed ? "Ya" : "Belum"}`,
    `Update terakhir: ${formatDateTime(state.order?.updatedAt)}`
  ].join("\n");
  const embed = new EmbedBuilder()
    .setColor(getStatusColor(status, state.decision))
    .setTitle("[Jolyne] Deliveree Mock Order")
    .setDescription(buildStatusSummary(state))
    .addFields(
      {
        name: "Order",
        value: bookingDetails,
        inline: false
      },
      {
        name: "Driver & ETA",
        value: driverDetails,
        inline: true
      },
      {
        name: "Tracking",
        value: trackingDetails,
        inline: true
      },
      {
        name: "Outcome Simulasi",
        value: buildOutcome(state),
        inline: false
      }
    )
    .setFooter({ text: "Jolyne Deliveree Recovery" })
    .setTimestamp();

  if (state.decision) {
    embed.addFields({
      name: "Recovery Action",
      value: formatDecision(state.decision),
      inline: false
    });
  }

  return embed;
}

export function buildMockOrderControls(state: MockOrderViewState, options: MockOrderMessageOptions = {}) {
  const status = getViewStatus(state);
  const controlsDisabled = options.controlsDisabled || state.decision?.type === "cancel" || status === "completed";
  const recoveryDisabled = Boolean(options.controlsDisabled || state.decision || status === "completed");

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mock-order:refresh:${state.bookingId}`)
        .setLabel("Refresh Status")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(controlsDisabled),
      new ButtonBuilder()
        .setCustomId(`mock-order:reorder:${state.bookingId}`)
        .setLabel("Reorder")
        .setStyle(ButtonStyle.Success)
        .setDisabled(recoveryDisabled),
      new ButtonBuilder()
        .setCustomId(`mock-order:cancel:${state.bookingId}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(recoveryDisabled)
    )
  ];
}

export function buildMockOrderMessage(state: MockOrderViewState, options: MockOrderMessageOptions = {}) {
  return {
    components: buildMockOrderControls(state, options),
    embeds: [buildMockOrderEmbed(state)]
  };
}
