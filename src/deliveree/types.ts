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

export type DelivereeOrderSnapshot = {
  bookingId: string;
  status: DelivereeStatus;
  driverName?: string;
  vehiclePlate?: string;
  eta?: string;
  updatedAt: string;
};

export interface DelivereeClient {
  getOrderStatus(bookingId: string): Promise<DelivereeOrderSnapshot | null>;
}
