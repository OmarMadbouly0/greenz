-- CreateEnum
CREATE TYPE "withdrawal_statuses" AS ENUM ('pending', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "wallet_transaction_types" AS ENUM ('payout', 'withdrawal', 'refund', 'adjustment');

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "type" "wallet_transaction_types" NOT NULL DEFAULT 'payout',
ADD COLUMN     "withdrawal_id" INTEGER,
ALTER COLUMN "pickup_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" SERIAL NOT NULL,
    "wallet_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "destination_phone" TEXT NOT NULL,
    "status" "withdrawal_statuses" NOT NULL DEFAULT 'pending',
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "admin_id" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "withdrawal_requests_wallet_id_requested_at_idx" ON "withdrawal_requests"("wallet_id", "requested_at");

-- CreateIndex
CREATE INDEX "withdrawal_requests_status_requested_at_idx" ON "withdrawal_requests"("status", "requested_at");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transactions_withdrawal_id_type_key" ON "wallet_transactions"("withdrawal_id", "type");

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_withdrawal_id_fkey" FOREIGN KEY ("withdrawal_id") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Business constraints not expressible in the Prisma schema.
ALTER TABLE "withdrawal_requests"
ADD CONSTRAINT "withdrawal_requests_amount_check" CHECK ("amount" >= 200),
ADD CONSTRAINT "withdrawal_requests_status_timestamps_check" CHECK (
    ("status" = 'pending' AND "paid_at" IS NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'paid' AND "paid_at" IS NOT NULL AND "cancelled_at" IS NULL)
    OR ("status" = 'cancelled' AND "paid_at" IS NULL AND "cancelled_at" IS NOT NULL)
);

-- Existing pickup amounts are preserved. Withdrawal debits are negative;
-- refunds are positive, and neither can also reference a pickup.
ALTER TABLE "wallet_transactions"
ADD CONSTRAINT "wallet_transactions_reference_check" CHECK (
    ("type" = 'payout' AND "pickup_id" IS NOT NULL AND "withdrawal_id" IS NULL)
    OR ("type" = 'withdrawal' AND "pickup_id" IS NULL AND "withdrawal_id" IS NOT NULL AND "amount" < 0)
    OR ("type" = 'refund' AND "pickup_id" IS NULL AND "withdrawal_id" IS NOT NULL AND "amount" > 0)
    OR ("type" = 'adjustment' AND "pickup_id" IS NULL AND "withdrawal_id" IS NULL)
);
