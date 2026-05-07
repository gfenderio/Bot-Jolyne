import type { DelivereeStatus } from "./types.js";

const delivereeStatusLabels: Record<DelivereeStatus, string> = {
  searching_driver: "Searching Driver",
  driver_assigned: "Driver Assigned",
  arrived_at_pickup: "Arrived at Pickup",
  on_delivery: "On Delivery",
  near_destination: "Near Destination",
  completed: "Completed",
  cancelled: "Cancelled"
};

export function mapDelivereeStatusToLabel(status: DelivereeStatus) {
  return delivereeStatusLabels[status];
}

export function isTerminalDelivereeStatus(status: DelivereeStatus) {
  return status === "completed" || status === "cancelled";
}
