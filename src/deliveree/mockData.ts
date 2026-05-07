import type { DelivereeOrderSnapshot } from "./types.js";

export type MockDelivereeOrderTimeline = {
  bookingId: string;
  snapshots: Array<Omit<DelivereeOrderSnapshot, "bookingId" | "updatedAt">>;
};

export const mockDelivereeOrders: MockDelivereeOrderTimeline[] = [
  {
    bookingId: "19320032",
    snapshots: [
      {
        status: "searching_driver",
        eta: "14:10"
      },
      {
        status: "driver_assigned",
        driverName: "Budi",
        vehiclePlate: "B 1234 XYZ",
        eta: "14:30"
      },
      {
        status: "arrived_at_pickup",
        driverName: "Budi",
        vehiclePlate: "B 1234 XYZ",
        eta: "14:35"
      },
      {
        status: "on_delivery",
        driverName: "Budi",
        vehiclePlate: "B 1234 XYZ",
        eta: "15:05"
      },
      {
        status: "near_destination",
        driverName: "Budi",
        vehiclePlate: "B 1234 XYZ",
        eta: "15:15"
      },
      {
        status: "completed",
        driverName: "Budi",
        vehiclePlate: "B 1234 XYZ"
      }
    ]
  },
  {
    bookingId: "19320033",
    snapshots: [
      {
        status: "searching_driver",
        eta: "16:00"
      },
      {
        status: "driver_assigned",
        driverName: "Sari",
        vehiclePlate: "B 4321 KYO",
        eta: "16:20"
      },
      {
        status: "cancelled",
        driverName: "Sari",
        vehiclePlate: "B 4321 KYO"
      }
    ]
  }
];

export const defaultActiveBookingIds = mockDelivereeOrders.map((order) => order.bookingId);
