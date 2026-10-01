BEGIN;

-- Ledger direction is represented by type; withdrawal amounts are positive.
ALTER TABLE "wallet_transactions"
DROP CONSTRAINT "wallet_transactions_reference_check";

-- Preserve existing withdrawal history while changing its sign convention.
UPDATE "wallet_transactions"
SET "amount" = -"amount"
WHERE "type" = 'withdrawal' AND "amount" < 0;

ALTER TABLE "wallet_transactions"
ADD CONSTRAINT "wallet_transactions_reference_check" CHECK (
    ("type" = 'payout' AND "pickup_id" IS NOT NULL AND "withdrawal_id" IS NULL)
    OR ("type" = 'withdrawal' AND "pickup_id" IS NULL AND "withdrawal_id" IS NOT NULL AND "amount" > 0)
    OR ("type" = 'refund' AND "pickup_id" IS NULL AND "withdrawal_id" IS NOT NULL AND "amount" > 0)
    OR ("type" = 'adjustment' AND "pickup_id" IS NULL AND "withdrawal_id" IS NULL)
);

COMMIT;
