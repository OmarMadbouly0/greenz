/*
  Warnings:

  - You are about to drop the column `address_line` on the `addresses` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[user_id]` on the table `addresses` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `street` to the `addresses` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "addresses" DROP COLUMN "address_line",
ADD COLUMN     "street" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "addresses_user_id_key" ON "addresses"("user_id");
