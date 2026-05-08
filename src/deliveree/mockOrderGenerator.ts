import { mockDelivereeClient } from "./mockRuntime.js";
import { resetMockDelivereeTrackingState, trackMockDelivereeBookingId } from "./mockRuntime.js";
import type { MockDelivereeOrderSnapshot, MockDelivereeOrderTimeline } from "./mockData.js";
import type { DelivereeMockScenario, DelivereeStatus } from "./types.js";

export type MockOrderSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type CreatedMockOrder = {
  bookingId: string;
  initialStatus: DelivereeStatus;
  outcome: string;
  scenario: DelivereeMockScenario;
  slot: MockOrderSlot;
};

const replacementCountBySourceBookingId = new Map<string, number>();

const legacySlotByBookingId: Record<string, MockOrderSlot> = {
  "19320032": 1,
  "19320033": 2
};

const scenarioBySlot: Record<MockOrderSlot, DelivereeMockScenario> = {
  1: "normal_completed",
  2: "cancelled",
  3: "stuck_driver_warning",
  4: "stuck_driver_critical",
  5: "normal_completed",
  6: "repeated_cancel",
  7: "cancelled",
  8: "normal_completed",
  9: "stuck_driver_warning",
  10: "stuck_driver_critical"
};

const outcomeByScenario: Record<DelivereeMockScenario, string> = {
  cancelled: "Order akan cancelled setelah driver assigned. Gunakan flow confirm reorder jika perlu.",
  normal_completed: "Order bergerak normal sampai completed tanpa alert kecil.",
  repeated_cancel: "Order akan cancelled sebagai simulasi retry/replacement yang gagal.",
  stuck_driver_critical: "Driver assigned lalu stuck. Warning muncul setelah 20 menit, critical setelah 40 menit.",
  stuck_driver_warning: "Driver assigned lalu stuck. Warning muncul setelah 20 menit tanpa progress."
};

const driverBySlot: Record<MockOrderSlot, { driverName: string; vehiclePlate: string }> = {
  1: { driverName: "Budi", vehiclePlate: "B 1001 JLY" },
  2: { driverName: "Sari", vehiclePlate: "B 1002 JLY" },
  3: { driverName: "Agus", vehiclePlate: "B 1003 JLY" },
  4: { driverName: "Dewi", vehiclePlate: "B 1004 JLY" },
  5: { driverName: "Raka", vehiclePlate: "B 1005 JLY" },
  6: { driverName: "Mira", vehiclePlate: "B 1006 JLY" },
  7: { driverName: "Fajar", vehiclePlate: "B 1007 JLY" },
  8: { driverName: "Nina", vehiclePlate: "B 1008 JLY" },
  9: { driverName: "Tono", vehiclePlate: "B 1009 JLY" },
  10: { driverName: "Lina", vehiclePlate: "B 1010 JLY" }
};

export function isMockOrderSlot(value: number): value is MockOrderSlot {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

export function getMockBookingId(slot: MockOrderSlot) {
  return `MOCK-${String(slot).padStart(3, "0")}`;
}

export function getMockOrderSlotFromBookingId(bookingId: string): MockOrderSlot | undefined {
  const legacySlot = legacySlotByBookingId[bookingId];

  if (legacySlot) {
    return legacySlot;
  }

  const match = /^MOCK-(\d{3})(?:-R\d+)?$/.exec(bookingId);

  if (!match) {
    return undefined;
  }

  const slot = Number(match[1]);
  return isMockOrderSlot(slot) ? slot : undefined;
}

export function getMockOrderScenario(slot: MockOrderSlot) {
  return scenarioBySlot[slot];
}

export function getMockOrderOutcome(scenario: DelivereeMockScenario) {
  return outcomeByScenario[scenario];
}

function createSearchingSnapshot(): MockDelivereeOrderSnapshot {
  return {
    atSeconds: 0,
    eta: "Demo",
    status: "searching_driver"
  };
}

function createAssignedSnapshot(slot: MockOrderSlot, atSeconds: number): MockDelivereeOrderSnapshot {
  const driver = driverBySlot[slot];

  return {
    atSeconds,
    driverName: driver.driverName,
    eta: "Demo",
    status: "driver_assigned",
    vehiclePlate: driver.vehiclePlate
  };
}

function createNormalCompletedTimeline(slot: MockOrderSlot): MockDelivereeOrderSnapshot[] {
  const driver = driverBySlot[slot];

  return [
    createSearchingSnapshot(),
    createAssignedSnapshot(slot, 5),
    {
      atSeconds: 10,
      driverName: driver.driverName,
      eta: "Demo",
      status: "arrived_at_pickup",
      vehiclePlate: driver.vehiclePlate
    },
    {
      atSeconds: 15,
      driverName: driver.driverName,
      eta: "Demo",
      status: "on_delivery",
      vehiclePlate: driver.vehiclePlate
    },
    {
      atSeconds: 25,
      driverName: driver.driverName,
      status: "completed",
      vehiclePlate: driver.vehiclePlate
    }
  ];
}

function createCancelledTimeline(slot: MockOrderSlot): MockDelivereeOrderSnapshot[] {
  const driver = driverBySlot[slot];

  return [
    createSearchingSnapshot(),
    createAssignedSnapshot(slot, 5),
    {
      atSeconds: 12,
      driverName: driver.driverName,
      status: "cancelled",
      vehiclePlate: driver.vehiclePlate
    }
  ];
}

function createStuckTimeline(slot: MockOrderSlot): MockDelivereeOrderSnapshot[] {
  return [
    createSearchingSnapshot(),
    createAssignedSnapshot(slot, 5)
  ];
}

function buildMockOrderTimeline(
  slot: MockOrderSlot,
  options: {
    bookingId?: string;
    scenario?: DelivereeMockScenario;
  } = {}
): MockDelivereeOrderTimeline {
  const bookingId = options.bookingId ?? getMockBookingId(slot);
  const scenario = options.scenario ?? getMockOrderScenario(slot);
  const snapshots = scenario === "normal_completed"
    ? createNormalCompletedTimeline(slot)
    : scenario === "cancelled" || scenario === "repeated_cancel"
      ? createCancelledTimeline(slot)
      : createStuckTimeline(slot);

  return {
    bookingId,
    progression: "elapsed_time",
    retryCount: scenario === "repeated_cancel" ? 1 : undefined,
    scenario,
    snapshots,
    suppressRoutineStatusUpdates: true
  };
}

export function createMockOrderForSlot(slot: MockOrderSlot): CreatedMockOrder {
  const timeline = buildMockOrderTimeline(slot);
  const initialStatus = timeline.snapshots[0].status;
  const scenario = getMockOrderScenario(slot);

  mockDelivereeClient.registerOrderTimeline(timeline);
  resetMockDelivereeTrackingState(timeline.bookingId);
  trackMockDelivereeBookingId(timeline.bookingId);

  return {
    bookingId: timeline.bookingId,
    initialStatus,
    outcome: getMockOrderOutcome(scenario),
    scenario,
    slot
  };
}

export function createReplacementMockOrder(sourceBookingId: string): CreatedMockOrder | undefined {
  const slot = getMockOrderSlotFromBookingId(sourceBookingId);

  if (!slot) {
    return undefined;
  }

  const baseBookingId = getMockBookingId(slot);
  const replacementCount = (replacementCountBySourceBookingId.get(baseBookingId) ?? 0) + 1;
  replacementCountBySourceBookingId.set(baseBookingId, replacementCount);

  const timeline = buildMockOrderTimeline(slot, {
    bookingId: `${baseBookingId}-R${replacementCount}`,
    scenario: "normal_completed"
  });
  const initialStatus = timeline.snapshots[0].status;

  mockDelivereeClient.registerOrderTimeline(timeline);
  resetMockDelivereeTrackingState(timeline.bookingId);
  trackMockDelivereeBookingId(timeline.bookingId);

  return {
    bookingId: timeline.bookingId,
    initialStatus,
    outcome: getMockOrderOutcome(timeline.scenario!),
    scenario: timeline.scenario!,
    slot
  };
}
