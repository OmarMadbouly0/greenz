/*
  Warnings:

  - A unique constraint covering the columns `[governorate_id,name]` on the table `cities` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "payout_statuses" ADD VALUE 'cancelled';

-- DropForeignKey
ALTER TABLE "addresses" DROP CONSTRAINT "addresses_user_id_fkey";

-- DropForeignKey
ALTER TABLE "wallet_transactions" DROP CONSTRAINT "wallet_transactions_wallet_id_fkey";

-- AlterTable
ALTER TABLE "pickup_items" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "pickups" ADD COLUMN     "note" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "cities_governorate_id_name_key" ON "cities"("governorate_id", "name");

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
