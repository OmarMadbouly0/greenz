import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/../generated/prisma/client";
import { getPrisma } from "@/infrastructure/database/prisma";
import { pickupService } from "@/services/pickup.service";
import { withdrawalService } from "@/services/withdrawal.service";
import { ConflictError } from "@/shared/errors/application-error";

const execFileAsync = promisify(execFile);
const prismaCliPath = createRequire(import.meta.url).resolve(
  "prisma/build/index.js",
);
const destinationPhone = "01000000000";

type LedgerEntry = {
  type: "payout" | "withdrawal" | "refund";
  amount: string;
  pickupId?: number;
  withdrawalId?: number;
};

function settle(
  operation: Promise<unknown>,
): Promise<PromiseSettledResult<unknown>> {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

describe("Pickup payouts competing with wallet withdrawals", () => {
  let container: StartedPostgreSqlContainer | undefined;
  let prisma: PrismaClient;
  let serviceClient: PrismaClient | undefined;
  let control: Pool;
  let customerId: number;
  let adminId: number;
  let walletId: number;
  let pickupId: number;
  let otherWalletId: number;
  const originalUrl = process.env.DATABASE_URL;
  const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
  const originalClient = globalForPrisma.prisma;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = container.getConnectionUri();
    process.env.DATABASE_URL = databaseUrl;
    delete globalForPrisma.prisma;
    await execFileAsync(process.execPath, [
      prismaCliPath,
      "migrate",
      "deploy",
      "--config",
      "prisma7.config.ts",
    ]);
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }),
    });
    await prisma.$connect();
    serviceClient = getPrisma();
    control = new Pool({ connectionString: databaseUrl, max: 2 });
  }, 180_000);

  afterAll(async () => {
    try {
      await Promise.all([
        serviceClient?.$disconnect(),
        prisma?.$disconnect(),
        control?.end(),
      ]);
    } finally {
      try {
        await container?.stop();
      } finally {
        globalForPrisma.prisma = originalClient;
        if (originalUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = originalUrl;
      }
    }
  });

  beforeEach(async () => {
    await prisma.walletTransaction.deleteMany();
    await prisma.withdrawalRequest.deleteMany();
    await prisma.pickupItem.deleteMany();
    await prisma.pickup.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.user.deleteMany();
    await prisma.material.deleteMany();
    const customer = await prisma.user.create({
      data: {
        full_name: "Wallet customer",
        email: "wallet-customer@example.com",
        password_hash: "unused-service-test",
        role: "customer",
      },
    });
    const admin = await prisma.user.create({
      data: {
        full_name: "Wallet admin",
        email: "wallet-admin@example.com",
        password_hash: "unused-service-test",
        role: "admin",
      },
    });
    customerId = customer.id;
    adminId = admin.id;
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customerId,
        phone: destinationPhone,
        balance: "500.50",
      },
    });
    walletId = wallet.id;
    const other = await prisma.user.create({
      data: {
        full_name: "Other customer",
        email: "other-customer@example.com",
        password_hash: "unused-service-test",
        role: "customer",
      },
    });
    const otherWallet = await prisma.wallet.create({
      data: {
        user_id: other.id,
        phone: "01000000001",
        balance: "700.10",
      },
    });
    otherWalletId = otherWallet.id;
    const material = await prisma.material.create({
      data: {
        name: "Paper",
        unit: "kg",
        current_price: "9.50",
      },
    });
    const pickup = await prisma.pickup.create({
      data: {
        customer_id: customerId,
        status: "completed",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
          },
        },
      },
    });
    pickupId = pickup.id;
  });

  async function waitForBlockedOperations(count: number) {
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      const result = await control.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND cardinality(pg_blocking_pids(pid)) > 0
      `);
      if (result.rows[0].count >= count) return;
      // Poll actual database lock state rather than assuming a scheduling delay.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${count} competing database operations to block`);
  }

  async function contend(operations: (() => Promise<unknown>)[]) {
    const blocker = await control.connect();
    const pending: Promise<PromiseSettledResult<unknown>>[] = [];
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM wallets WHERE id = $1 FOR UPDATE", [
        walletId,
      ]);
      for (const operation of operations) {
        pending.push(settle(operation()));
        // Confirm each contender has reached a real row lock before starting the next.
        await waitForBlockedOperations(pending.length);
      }
      await blocker.query("COMMIT");
      return await Promise.all(pending);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.all(pending);
    }
  }

  it("preserves both committed amounts when payout reaches the wallet first", async () => {
    const operations = [
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ];
    const results = await contend(operations);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const withdrawals = await prisma.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]).toMatchObject({
      wallet_id: walletId,
      status: "pending",
      destination_phone: destinationPhone,
    });
    expect(withdrawals[0].amount.toFixed(2)).toBe("200.00");

    const expectedEntries: LedgerEntry[] = [
      { type: "payout", amount: "23.75", pickupId },
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawals[0].id },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("324.25");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });

  it("preserves both committed amounts when withdrawal reaches the wallet first", async () => {
    const operations = [
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
    ];
    const results = await contend(operations);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const withdrawals = await prisma.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);
    expect(withdrawals[0]).toMatchObject({
      wallet_id: walletId,
      status: "pending",
      destination_phone: destinationPhone,
    });
    expect(withdrawals[0].amount.toFixed(2)).toBe("200.00");

    const expectedEntries: LedgerEntry[] = [
      { type: "payout", amount: "23.75", pickupId },
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawals[0].id },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("324.25");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });

  it("checks available funds after locking when payout reaches the wallet first", async () => {
    await prisma.wallet.update({
      where: { id: walletId },
      data: { balance: 190 },
    });
    const results = await contend([
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
    ]);
    const withdrawals = await prisma.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);

    const expectedEntries: LedgerEntry[] = [
      { type: "payout", amount: "23.75", pickupId },
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawals[0].id },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("13.75");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });

  it("checks available funds after locking when withdrawal reaches the wallet first", async () => {
    await prisma.wallet.update({
      where: { id: walletId },
      data: { balance: 190 },
    });
    const results = await contend([
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
    ]);

    expect(results[0].status).toBe("rejected");
    if (results[0].status !== "rejected") throw new Error("Expected rejection");
    expect(results[0].reason).toBeInstanceOf(ConflictError);
    expect(results[0].reason.message).toBe("Insufficient wallet balance.");

    expect(results[1].status).toBe("fulfilled");
    expect(await prisma.withdrawalRequest.count()).toBe(0);

    const expectedEntries: LedgerEntry[] = [
      { type: "payout", amount: "23.75", pickupId },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("213.75");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });

  it("credits a duplicate payout only once while a withdrawal commits", async () => {
    const results = await contend([
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("fulfilled");

    expect(results[2].status).toBe("rejected");
    if (results[2].status !== "rejected") throw new Error("Expected rejection");
    expect(results[2].reason).toBeInstanceOf(ConflictError);
    expect(results[2].reason.message).toBe("Payout has already been done.");

    const withdrawals = await prisma.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);

    const expectedEntries: LedgerEntry[] = [
      { type: "payout", amount: "23.75", pickupId },
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawals[0].id },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("324.25");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });

  it("prevents competing withdrawals from spending the same funds during a payout", async () => {
    await prisma.wallet.update({
      where: { id: walletId },
      data: { balance: 300 },
    });
    const results = await contend([
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("fulfilled");

    expect(results[2].status).toBe("rejected");
    if (results[2].status !== "rejected") throw new Error("Expected rejection");
    expect(results[2].reason).toBeInstanceOf(ConflictError);
    expect(results[2].reason.message).toBe("Insufficient wallet balance.");

    const withdrawals = await prisma.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);

    const expectedEntries: LedgerEntry[] = [
      { type: "payout", amount: "23.75", pickupId },
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawals[0].id },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("123.75");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });

  it("refunds a withdrawal only once while a pickup payout commits", async () => {
    const withdrawal = await withdrawalService.createWithdrawal(customerId, {
      amount: 200,
      destinationPhone,
    });
    const refund = () =>
      withdrawalService.updateWithdrawalStatus(adminId, withdrawal.id, {
        status: "cancelled",
      });
    const results = await contend([
      refund,
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
      refund,
    ]);
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("fulfilled");

    expect(results[2].status).toBe("rejected");
    if (results[2].status !== "rejected") throw new Error("Expected rejection");
    expect(results[2].reason).toBeInstanceOf(ConflictError);
    expect(results[2].reason.message).toBe(
      "Withdrawal has already been handled.",
    );

    expect(
      await prisma.withdrawalRequest.findUniqueOrThrow({
        where: { id: withdrawal.id },
      }),
    ).toMatchObject({
      status: "cancelled",
      admin_id: adminId,
      paid_at: null,
      cancelled_at: expect.any(Date),
    });
    expect(await prisma.withdrawalRequest.count()).toBe(1);

    const expectedEntries: LedgerEntry[] = [
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawal.id },
      { type: "refund", amount: "200.00", withdrawalId: withdrawal.id },
      { type: "payout", amount: "23.75", pickupId },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("524.25");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });

  it("rolls back a failed payout increment while preserving a concurrent withdrawal", async () => {
    const existing = await prisma.walletTransaction.create({
      data: {
        wallet_id: walletId,
        pickup_id: pickupId,
        type: "payout",
        amount: "23.75",
      },
    });
    const before = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    const results = await contend([
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        withdrawalService.createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ]);
    expect(results[0].status).toBe("rejected");
    if (results[0].status !== "rejected")
      throw new Error("Expected payout failure");
    expect(results[0].reason).toBeInstanceOf(Error);
    expect(results[1].status).toBe("fulfilled");
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: pickupId },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: existing.id },
      }),
    ).toEqual(existing);
    const withdrawals = await prisma.withdrawalRequest.findMany();
    expect(withdrawals).toHaveLength(1);

    const expectedEntries: LedgerEntry[] = [
      { type: "payout", amount: "23.75", pickupId },
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawals[0].id },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("300.50");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");
  });

  it("rolls back a failed refund increment while preserving a concurrent payout", async () => {
    const withdrawal = await withdrawalService.createWithdrawal(customerId, {
      amount: 200,
      destinationPhone,
    });
    // This conflict makes refund ledger insertion fail after the wallet increment.
    const existing = await prisma.walletTransaction.create({
      data: {
        wallet_id: walletId,
        withdrawal_id: withdrawal.id,
        type: "refund",
        amount: "200",
      },
    });
    const refund = () =>
      withdrawalService.updateWithdrawalStatus(adminId, withdrawal.id, {
        status: "cancelled",
      });
    const results = await contend([
      refund,
      () => pickupService.updatePayoutStatus(pickupId, { status: "paid" }),
    ]);
    expect(results[0].status).toBe("rejected");
    if (results[0].status !== "rejected")
      throw new Error("Expected refund failure");
    expect(results[0].reason).toBeInstanceOf(Error);
    expect(results[1].status).toBe("fulfilled");
    expect(
      await prisma.withdrawalRequest.findUniqueOrThrow({
        where: { id: withdrawal.id },
      }),
    ).toEqual(withdrawal);
    expect(await prisma.withdrawalRequest.count()).toBe(1);
    expect(
      await prisma.walletTransaction.findUniqueOrThrow({
        where: { id: existing.id },
      }),
    ).toEqual(existing);

    const expectedEntries: LedgerEntry[] = [
      { type: "withdrawal", amount: "200.00", withdrawalId: withdrawal.id },
      { type: "refund", amount: "200.00", withdrawalId: withdrawal.id },
      { type: "payout", amount: "23.75", pickupId },
    ];
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: walletId },
    });
    expect(wallet.balance.toFixed(2)).toBe("324.25");
    const rows = await prisma.walletTransaction.findMany();
    expect(rows).toHaveLength(expectedEntries.length);
    expect(
      rows.map((row) => ({
        walletId: row.wallet_id,
        type: row.type,
        amount: row.amount.toFixed(2),
        pickupId: row.pickup_id,
        withdrawalId: row.withdrawal_id,
      })),
    ).toEqual(
      expect.arrayContaining(
        expectedEntries.map((entry) => ({
          walletId,
          type: entry.type,
          amount: entry.amount,
          pickupId: entry.pickupId ?? null,
          withdrawalId: entry.withdrawalId ?? null,
        })),
      ),
    );
    const other = await prisma.wallet.findUniqueOrThrow({
      where: { id: otherWalletId },
    });
    expect(other.balance.toFixed(2)).toBe("700.10");

    const pickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickupId },
      include: { items: true },
    });
    expect(pickup).toMatchObject({
      status: "completed",
      payout_status: "paid",
    });
    expect(pickup.payout?.toFixed(2)).toBe("23.75");
    expect(pickup.completed_at).toEqual(new Date("2026-01-01T10:00:00Z"));
    expect(pickup.items).toHaveLength(1);
    expect(pickup.items[0].quantity.toFixed(2)).toBe("2.50");
    expect(pickup.items[0].price_per_unit.toFixed(2)).toBe("9.50");
  });
});
