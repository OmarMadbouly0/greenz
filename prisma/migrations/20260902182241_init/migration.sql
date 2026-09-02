-- CreateEnum
CREATE TYPE "user_roles" AS ENUM ('customer', 'admin', 'collector');

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "full_name" TEXT NOT NULL,
    "role" "user_roles" NOT NULL DEFAULT 'customer',
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "last_login_at" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
