export const pickupStatuses = [
  "pending",
  "assigned",
  "on_the_way",
  "arrived",
  "completed",
  "cancelled",
] as const;

export type PickupStatus = (typeof pickupStatuses)[number];

export type PayoutStatus = "pending" | "paid" | "cancelled";
