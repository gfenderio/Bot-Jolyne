import type { DelivereeStatus } from "./types.js";

export type StoredDelivereeOrderState = {
  driverAssignedAt?: string;
  status: DelivereeStatus;
  stalledCriticalSent?: boolean;
  stalledWarningSent?: boolean;
  observedAt: string;
};

export interface DelivereeStateStore {
  deleteLastOrderState(bookingId: string): void;
  getLastOrderState(bookingId: string): StoredDelivereeOrderState | undefined;
  setLastOrderState(bookingId: string, state: StoredDelivereeOrderState): void;
}

export class InMemoryDelivereeStateStore implements DelivereeStateStore {
  private readonly stateByBookingId = new Map<string, StoredDelivereeOrderState>();

  deleteLastOrderState(bookingId: string) {
    this.stateByBookingId.delete(bookingId);
  }

  getLastOrderState(bookingId: string) {
    return this.stateByBookingId.get(bookingId);
  }

  setLastOrderState(bookingId: string, state: StoredDelivereeOrderState) {
    this.stateByBookingId.set(bookingId, state);
  }
}
