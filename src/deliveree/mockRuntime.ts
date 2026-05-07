import { defaultActiveBookingIds } from "./mockData.js";
import { MockDelivereeClient } from "./mockDelivereeClient.js";
import { InMemoryDelivereeStateStore } from "./stateStore.js";
import type { DelivereeOrderSnapshot, DelivereeStatus } from "./types.js";

export const activeMockDelivereeBookingIds: string[] = [];
export const availableMockDelivereeBookingIds = [...defaultActiveBookingIds];
export const mockDelivereeClient = new MockDelivereeClient();
export const mockDelivereeStateStore = new InMemoryDelivereeStateStore();

export type MockTrackingResult = {
  changed: boolean;
  order: DelivereeOrderSnapshot | null;
  previousStatus?: DelivereeStatus;
};

export async function getNextMockDelivereeTrackingResult(bookingId: string): Promise<MockTrackingResult> {
  const order = await mockDelivereeClient.getOrderStatus(bookingId);

  if (!order) {
    return {
      changed: false,
      order
    };
  }

  const previousState = mockDelivereeStateStore.getLastOrderState(bookingId);
  const changed = previousState?.status !== order.status;

  if (changed) {
    mockDelivereeStateStore.setLastOrderState(bookingId, {
      status: order.status,
      observedAt: new Date().toISOString()
    });
  }

  return {
    changed,
    order,
    previousStatus: previousState?.status
  };
}

export function trackMockDelivereeBookingId(bookingId: string) {
  if (!availableMockDelivereeBookingIds.includes(bookingId)) {
    availableMockDelivereeBookingIds.push(bookingId);
  }

  if (!activeMockDelivereeBookingIds.includes(bookingId)) {
    activeMockDelivereeBookingIds.push(bookingId);
  }
}

export function resetMockDelivereeTrackingState(bookingId: string) {
  mockDelivereeStateStore.deleteLastOrderState(bookingId);
}
