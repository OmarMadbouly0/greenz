import { z } from "zod";
import { phoneNumber, requiredInt } from "@/shared/validation/field";
import { paginationQuerySchema } from "@/shared/validation/pagination.schema";

export const createWithdrawalSchema = z
  .object({
    amount: requiredInt("Amount", 200, 100000),
    destinationPhone: phoneNumber("Destination phone number"),
  })
  .strict();

export type CreateWithdrawalInput = z.output<typeof createWithdrawalSchema>;

export const updateWithdrawalStatusSchema = z
  .object({
    status: z.enum(["paid", "cancelled"]),
  })
  .strict();

export type UpdateWithdrawalStatusInput = z.output<
  typeof updateWithdrawalStatusSchema
>;

export const withdrawalListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(["pending", "paid", "cancelled"]).optional(),
});

export type WithdrawalListQuery = z.output<typeof withdrawalListQuerySchema>;
