import { z } from "zod";
import {
  optionalText,
  requiredNumber,
  requiredString,
} from "@/shared/validation/field";
import { materialUnit } from "@/modules/material/domain/types";

export const createMaterialSchema = z.object({
  name: requiredString("Name", 50),
  description: requiredString("Description", 500),
  price: requiredNumber("Price", 1, 1000000),
  unit: z.enum(
    materialUnit,
    "Unit must be one of the following: kg, g, l, ml, piece.",
  ),
});

export type CreateMaterialInput = z.infer<typeof createMaterialSchema>;

export const updateMaterialSchema = z.object({
  name: optionalText("Name", 50),
  description: optionalText("Description", 500),
  price: requiredNumber("Price", 1, 1000000).optional(),
  unit: z
    .enum(
      materialUnit,
      "Unit must be one of the following: kg, g, l, ml, piece.",
    )
    .optional(),
});

export type UpdateMaterialInput = z.infer<typeof updateMaterialSchema>;
