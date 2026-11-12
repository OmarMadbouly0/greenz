import { z } from "zod";
import {
  optionalText,
  requiredId,
  requiredNumber,
} from "@/shared/validation/field";
import { paginationQuerySchema } from "@/shared/validation/pagination.schema";
import { pickupStatuses } from "@/modules/pickup/domain/types";

export const createPickupSchema = z
  .object({
    note: optionalText("Note", 500),

    items: z
      .array(
        z
          .object({
            materialId: requiredId("Material"),
            quantity: requiredNumber("Quantity", 0.25, 100000),
            note: optionalText("Item note", 500),
          })
          .strict(),
      )
      .min(1, "At least one material required."),
  })
  .strict();

export type CreatePickupInput = z.output<typeof createPickupSchema>;

export const updatePickupStatusSchema = z
  .object({
    status: z.enum(["on_the_way", "arrived", "completed"]),
  })
  .strict();

export type UpdatePickupStatusInput = z.output<typeof updatePickupStatusSchema>;

export const assignPickupToCollectorSchema = z
  .object({
    collectorId: requiredId("Collector"),
  })
  .strict();

export type AssignPickupToCollectorInput = z.output<
  typeof assignPickupToCollectorSchema
>;

export const updatePayoutStatusSchema = z
  .object({
    status: z.enum(["paid", "cancelled"]),
  })
  .strict();

export type UpdatePayoutStatusInput = z.output<typeof updatePayoutStatusSchema>;

export const pickupListQuerySchema = paginationQuerySchema
  .extend({
    status: z.enum(pickupStatuses).optional(),
  })
  .strict();

export type PickupListQuery = z.output<typeof pickupListQuerySchema>;
