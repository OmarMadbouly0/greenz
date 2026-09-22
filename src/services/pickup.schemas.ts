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
