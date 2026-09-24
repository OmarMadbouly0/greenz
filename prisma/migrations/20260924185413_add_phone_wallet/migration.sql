/*
  Warnings:

  - A unique constraint covering the columns `[phone]` on the table `wallets` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `phone` to the `wallets` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "phone" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "wallets_phone_key" ON "wallets"("phone");
