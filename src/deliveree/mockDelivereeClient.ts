import { mockDelivereeOrders } from "./mockData.js";
import type { DelivereeClient, DelivereeOrderSnapshot } from "./types.js";
import type { MockDelivereeOrderTimeline } from "./mockData.js";

export class MockDelivereeClient implements DelivereeClient {
  private readonly timelineByBookingId: Map<string, MockDelivereeOrderTimeline>;
  private readonly currentIndexByBookingId = new Map<string, number>();

  constructor(timelines = mockDelivereeOrders) {
    this.timelineByBookingId = new Map(
      timelines.map((timeline) => [timeline.bookingId, timeline])
    );
  }

  async getOrderStatus(bookingId: string): Promise<DelivereeOrderSnapshot | null> {
    const timeline = this.timelineByBookingId.get(bookingId);

    if (!timeline) {
      return null;
    }

    const currentIndex = this.currentIndexByBookingId.get(bookingId) ?? 0;
    const snapshot = timeline.snapshots[Math.min(currentIndex, timeline.snapshots.length - 1)];

    if (currentIndex < timeline.snapshots.length - 1) {
      this.currentIndexByBookingId.set(bookingId, currentIndex + 1);
    }

    return {
      bookingId,
      ...snapshot,
      updatedAt: new Date().toISOString()
    };
  }
}
