import type { DelivereeStatus } from "./types.js";

export type StoredDelivereeOrderState = {
  status: DelivereeStatus;
  observedAt: string;
};

export interface DelivereeStateStore {
  getLastOrderState(bookingId: string): StoredDelivereeOrderState | undefined;
  setLastOrderState(bookingId: string, state: StoredDelivereeOrderState): void;
}

export class InMemoryDelivereeStateStore implements DelivereeStateStore {
  private readonly stateByBookingId = new Map<string, StoredDelivereeOrderState>();

  getLastOrderState(bookingId: string) {
    return this.stateByBookingId.get(bookingId);
  }

  setLastOrderState(bookingId: string, state: StoredDelivereeOrderState) {
    this.stateByBookingId.set(bookingId, state);
  }
}
