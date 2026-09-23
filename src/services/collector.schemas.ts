import { optionalText, requiredString } from "@/shared/validation/field";
import { requiredEmail } from "@/shared/validation/field";
import { requiredId } from "@/shared/validation/field";
import { z } from "zod";
export const registerCollectorSchema = z.object({
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

export type RegisterCollectorInput = z.output<typeof registerCollectorSchema>;
