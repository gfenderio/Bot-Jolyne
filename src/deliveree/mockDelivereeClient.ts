import { mockDelivereeOrders } from "./mockData.js";
import type { DelivereeClient, DelivereeOrderSnapshot } from "./types.js";
import type { MockDelivereeOrderTimeline } from "./mockData.js";

export class MockDelivereeClient implements DelivereeClient {
  private readonly timelineByBookingId = new Map<string, MockDelivereeOrderTimeline>();
  private readonly currentIndexByBookingId = new Map<string, number>();
  private readonly startedAtByBookingId = new Map<string, number>();

  constructor(timelines = mockDelivereeOrders) {
    for (const timeline of timelines) {
      this.registerOrderTimeline(timeline);
    }
  }

  registerOrderTimeline(timeline: MockDelivereeOrderTimeline, startedAtMs = Date.now()) {
    this.timelineByBookingId.set(timeline.bookingId, timeline);
    this.currentIndexByBookingId.delete(timeline.bookingId);

    if (timeline.progression === "elapsed_time") {
      this.startedAtByBookingId.set(timeline.bookingId, startedAtMs);
      return;
    }

    this.startedAtByBookingId.delete(timeline.bookingId);
  }

  resetOrder(bookingId: string, startedAtMs = Date.now()) {
    const timeline = this.timelineByBookingId.get(bookingId);

    if (!timeline) {
      return false;
    }

    this.currentIndexByBookingId.delete(bookingId);

    if (timeline.progression === "elapsed_time") {
      this.startedAtByBookingId.set(bookingId, startedAtMs);
    }

    return true;
  }

  async getOrderStatus(bookingId: string): Promise<DelivereeOrderSnapshot | null> {
    const timeline = this.timelineByBookingId.get(bookingId);

    if (!timeline) {
      return null;
    }

    if (timeline.progression === "elapsed_time") {
      const startedAtMs = this.startedAtByBookingId.get(bookingId) ?? Date.now();
      const elapsedSeconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
      const snapshot = timeline.snapshots.reduce((latestSnapshot, nextSnapshot) => {
        const nextAtSeconds = nextSnapshot.atSeconds ?? 0;

        if (nextAtSeconds <= elapsedSeconds) {
          return nextSnapshot;
        }

        return latestSnapshot;
      }, timeline.snapshots[0]);
      const { atSeconds = 0, ...snapshotData } = snapshot;

      return {
        bookingId,
        ...snapshotData,
        retryCount: snapshotData.retryCount ?? timeline.retryCount,
        scenario: snapshotData.scenario ?? timeline.scenario,
        statusChangedAt: new Date(startedAtMs + atSeconds * 1000).toISOString(),
        suppressRoutineStatusUpdates: snapshotData.suppressRoutineStatusUpdates ?? timeline.suppressRoutineStatusUpdates,
        updatedAt: new Date().toISOString()
      };
    }

    const currentIndex = this.currentIndexByBookingId.get(bookingId) ?? 0;
    const snapshot = timeline.snapshots[Math.min(currentIndex, timeline.snapshots.length - 1)];
    const snapshotData = { ...snapshot };
    delete snapshotData.atSeconds;

    if (currentIndex < timeline.snapshots.length - 1) {
      this.currentIndexByBookingId.set(bookingId, currentIndex + 1);
    }

    return {
      bookingId,
      ...snapshotData,
      retryCount: snapshotData.retryCount ?? timeline.retryCount,
      scenario: snapshotData.scenario ?? timeline.scenario,
      suppressRoutineStatusUpdates: snapshotData.suppressRoutineStatusUpdates ?? timeline.suppressRoutineStatusUpdates,
      updatedAt: new Date().toISOString()
    };
  }
}
