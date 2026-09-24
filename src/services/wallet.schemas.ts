import { z } from "zod";
import { phoneNumber } from "@/shared/validation/field";

export const createWalletSchema = z.object({
  phone: phoneNumber("Phone number"),
});

export type CreateWalletInput = z.output<typeof createWalletSchema>;
