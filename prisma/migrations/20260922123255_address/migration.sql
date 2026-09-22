/*
  Warnings:

  - You are about to drop the column `address_id` on the `pickups` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "pickups" DROP CONSTRAINT "pickups_address_id_fkey";

-- AlterTable
ALTER TABLE "pickups" DROP COLUMN "address_id";
