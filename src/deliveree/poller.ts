import { isTerminalDelivereeStatus } from "./statusMapper.js";
import type { DelivereeClient } from "./types.js";
import type { DelivereeNotifier } from "./discordNotifier.js";
import type { DelivereeStateStore } from "./stateStore.js";

export type DelivereePollerOptions = {
  activeBookingIds: string[];
  client: DelivereeClient;
  intervalMs: number;
  notifier: DelivereeNotifier;
  stateStore: DelivereeStateStore;
};

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
        continue;
      }

      await options.notifier.sendOrderUpdate(order);
      options.stateStore.setLastOrderState(bookingId, {
        status: order.status,
        observedAt: new Date().toISOString()
      });

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

  console.log(
    `Deliveree mock poller aktif untuk booking ID ${options.activeBookingIds.join(", ")} setiap ${options.intervalMs / 1000} detik.`
  );

  return () => {
    clearInterval(interval);
  };
}
