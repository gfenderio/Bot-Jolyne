import { isTerminalDelivereeStatus } from "./statusMapper.js";
import type { DelivereeClient, DelivereeOrderSnapshot } from "./types.js";
import type { DelivereeNotifier } from "./discordNotifier.js";
import type { DelivereeStateStore, StoredDelivereeOrderState } from "./stateStore.js";

export type DelivereePollerOptions = {
  activeBookingIds: string[];
  client: DelivereeClient;
  intervalMs: number;
  notifier: DelivereeNotifier;
  stateStore: DelivereeStateStore;
};

const DRIVER_STUCK_WARNING_SECONDS = 20;
const DRIVER_STUCK_CRITICAL_SECONDS = 40;

function shouldSuppressRoutineStatusUpdates(order: DelivereeOrderSnapshot) {
  return Boolean(order.scenario || order.suppressRoutineStatusUpdates);
}

function buildNextState(
  order: DelivereeOrderSnapshot,
  previousState: StoredDelivereeOrderState | undefined
): StoredDelivereeOrderState {
  const driverAssignedAt = order.status === "driver_assigned"
    ? previousState?.status === "driver_assigned"
      ? previousState.driverAssignedAt ?? order.statusChangedAt ?? order.updatedAt
      : order.statusChangedAt ?? order.updatedAt
    : undefined;

  return {
    driverAssignedAt,
    observedAt: new Date().toISOString(),
    stalledCriticalSent: order.status === "driver_assigned" && previousState?.status === "driver_assigned"
      ? previousState.stalledCriticalSent
      : false,
    stalledWarningSent: order.status === "driver_assigned" && previousState?.status === "driver_assigned"
      ? previousState.stalledWarningSent
      : false,
    status: order.status
  };
}

async function notifyStatusChange(
  notifier: DelivereeNotifier,
  order: DelivereeOrderSnapshot
) {
  if (order.status === "cancelled") {
    await notifier.sendRecoveryAlert({
      bookingId: order.bookingId,
      driverName: order.driverName,
      reason: "Order Deliveree dibatalkan dan perlu keputusan recovery.",
      recommendation: "Konfirmasi apakah perlu reorder. Jika iya, lanjutkan ke flow reorder/replacement.",
      retryCount: order.retryCount,
      severity: "critical",
      status: order.status,
      vehiclePlate: order.vehiclePlate
    });
    return;
  }

  if (order.status === "completed") {
    await notifier.sendOrderUpdate(order);
    return;
  }

  if (!shouldSuppressRoutineStatusUpdates(order)) {
    await notifier.sendOrderUpdate(order);
  }
}

async function notifyStuckDriverIfNeeded(
  notifier: DelivereeNotifier,
  order: DelivereeOrderSnapshot,
  stateStore: DelivereeStateStore
) {
  if (order.status !== "driver_assigned") {
    return;
  }

  const state = stateStore.getLastOrderState(order.bookingId);
  const driverAssignedAt = state?.driverAssignedAt ?? order.statusChangedAt;

  if (!state || !driverAssignedAt) {
    return;
  }

  const stalledForSeconds = Math.floor((Date.now() - Date.parse(driverAssignedAt)) / 1000);
  const criticalAllowed = order.scenario !== "stuck_driver_warning";

  if (criticalAllowed && stalledForSeconds >= DRIVER_STUCK_CRITICAL_SECONDS && !state.stalledCriticalSent) {
    await notifier.sendRecoveryAlert({
      bookingId: order.bookingId,
      driverName: order.driverName,
      reason: "Driver sudah assigned tapi tidak ada progress dalam durasi critical.",
      recommendation: "Follow up driver sekarang. Jika tidak ada respon, cancel dan buat reorder/replacement.",
      retryCount: order.retryCount,
      severity: "critical",
      stalledForSeconds,
      status: order.status,
      vehiclePlate: order.vehiclePlate
    });
    stateStore.setLastOrderState(order.bookingId, {
      ...state,
      stalledCriticalSent: true,
      stalledWarningSent: true
    });
    return;
  }

  if (stalledForSeconds >= DRIVER_STUCK_WARNING_SECONDS && !state.stalledWarningSent) {
    await notifier.sendRecoveryAlert({
      bookingId: order.bookingId,
      driverName: order.driverName,
      reason: "Driver sudah assigned tapi belum ada progress.",
      recommendation: "Follow up driver dan siapkan opsi cancel/reorder jika status tidak bergerak.",
      retryCount: order.retryCount,
      severity: "warning",
      stalledForSeconds,
      status: order.status,
      vehiclePlate: order.vehiclePlate
    });
    stateStore.setLastOrderState(order.bookingId, {
      ...state,
      stalledWarningSent: true
    });
  }
}

export async function pollDelivereeOrders(options: DelivereePollerOptions) {
  for (const bookingId of options.activeBookingIds) {
    try {
      const order = await options.client.getOrderStatus(bookingId);

      if (!order) {
        console.warn(`Deliveree mock: booking ID ${bookingId} tidak ditemukan.`);
        continue;
      }

      const lastState = options.stateStore.getLastOrderState(bookingId);

      if (lastState?.status === order.status) {
        await notifyStuckDriverIfNeeded(options.notifier, order, options.stateStore);
        continue;
      }

      await notifyStatusChange(options.notifier, order);
      options.stateStore.setLastOrderState(bookingId, buildNextState(order, lastState));
      await notifyStuckDriverIfNeeded(options.notifier, order, options.stateStore);

      if (isTerminalDelivereeStatus(order.status)) {
        console.log(`Deliveree mock: booking ID ${bookingId} sudah ${order.status}.`);
      }
    } catch (error) {
      console.error(`Deliveree mock: gagal memproses booking ID ${bookingId}.`, error);
    }
  }
}

export function startDelivereePoller(options: DelivereePollerOptions) {
  let isPolling = false;

  const run = async () => {
    if (isPolling) {
      return;
    }

    isPolling = true;

    try {
      await pollDelivereeOrders(options);
    } finally {
      isPolling = false;
    }
  };

  void run();
  const interval = setInterval(() => {
    void run();
  }, options.intervalMs);

  const activeBookingIdsText = options.activeBookingIds.length > 0
    ? options.activeBookingIds.join(", ")
    : "dinamis via command";

  console.log(
    `Deliveree mock poller aktif untuk booking ID ${activeBookingIdsText} setiap ${options.intervalMs / 1000} detik.`
  );

  return () => {
    clearInterval(interval);
  };
}
