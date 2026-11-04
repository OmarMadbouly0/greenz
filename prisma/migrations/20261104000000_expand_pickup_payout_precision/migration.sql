-- Allow the inclusive payout maximum of 100,000,000.00.
ALTER TABLE "pickups" ALTER COLUMN "payout" TYPE DECIMAL(11, 2);
