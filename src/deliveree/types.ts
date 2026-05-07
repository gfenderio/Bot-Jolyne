export const DELIVEREE_STATUSES = [
  "searching_driver",
  "driver_assigned",
  "arrived_at_pickup",
  "on_delivery",
  "near_destination",
  "completed",
  "cancelled"
] as const;

export type DelivereeStatus = (typeof DELIVEREE_STATUSES)[number];

export const DELIVEREE_MOCK_SCENARIOS = [
  "normal_completed",
  "cancelled",
  "stuck_driver_warning",
  "stuck_driver_critical",
  "repeated_cancel"
] as const;

export type DelivereeMockScenario = (typeof DELIVEREE_MOCK_SCENARIOS)[number];

export type DelivereeOrderSnapshot = {
  bookingId: string;
  status: DelivereeStatus;
  driverName?: string;
  vehiclePlate?: string;
  eta?: string;
  statusChangedAt?: string;
  updatedAt: string;
  scenario?: DelivereeMockScenario;
  retryCount?: number;
  suppressRoutineStatusUpdates?: boolean;
};

export interface DelivereeClient {
  getOrderStatus(bookingId: string): Promise<DelivereeOrderSnapshot | null>;
}
