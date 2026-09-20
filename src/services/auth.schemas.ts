import {
  optionalId,
  optionalText,
  requiredString,
} from "@/shared/validation/field";
import { requiredEmail } from "@/shared/validation/field";
import { requiredId } from "@/shared/validation/field";
import { z } from "zod";
export const registerUserSchema = z.object({
  fullName: requiredString("Full name", 50),
  email: requiredEmail(),
  password: requiredString("Password", 20, 8),
  address: z.object({
    cityId: requiredId("City"),
    street: requiredString("Street", 50),
    building: requiredString("Building", 50),
    apartment: optionalText("Apartment", 50),
    floor: optionalText("Floor", 50),
  }),
});

export type RegisterInput = z.output<typeof registerUserSchema>;

export const loginUserSchema = z.object({
  email: requiredEmail(),
  password: requiredString("Password", 20, 8),
});

export type LoginInput = z.output<typeof loginUserSchema>;

export const updateProfileSchema = z.object({
  fullName: optionalText("Full name", 50),

  address: z
    .object({
      cityId: optionalId("City"),
      street: optionalText("Street", 50),
      building: optionalText("Building", 50),
      apartment: optionalText("Apartment", 50),
      floor: optionalText("Floor", 50),
    })
    .optional(),
});

export type UpdateProfileInput = z.output<typeof updateProfileSchema>;
