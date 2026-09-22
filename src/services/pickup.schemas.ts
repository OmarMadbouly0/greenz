import { z } from "zod";
import {
  optionalText,
  requiredId,
  requiredNumber,
} from "@/shared/validation/field";

export const createPickupSchema = z.object({
  note: optionalText("Note", 500),

  items: z
    .array(
      z.object({
        materialId: requiredId("Material"),
        quantity: requiredNumber("Quantity", 0.25, 100000),
        note: optionalText("Item note", 500),
      }),
    )
    .min(1, "At least one material required."),
});

export type CreatePickupInput = z.output<typeof createPickupSchema>;

export const updatePickupStatusSchema = z.object({
  status: z.enum(["on_the_way", "arrived", "completed"]),
});

export type UpdatePickupStatusInput = z.output<typeof updatePickupStatusSchema>;

export const assignPickupToCollectorSchema = z.object({
  collectorId: requiredId("Collector"),
});

export type AssignPickupToCollectorInput = z.output<
  typeof assignPickupToCollectorSchema
>;
