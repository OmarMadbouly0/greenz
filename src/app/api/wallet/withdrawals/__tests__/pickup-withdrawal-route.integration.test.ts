import { Pool } from "pg";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/../generated/prisma/client";
import { getPrisma } from "@/infrastructure/database/prisma";
import { generateToken } from "@/modules/identity/application/jwt";
import { PATCH as payoutRoute } from "@/app/api/admin/pickups/[pickupId]/payout/route";
import { POST as withdrawalRoute } from "@/app/api/wallet/withdrawals/route";
import { PATCH as withdrawalStatusRoute } from "@/app/api/admin/wallets/withdrawals/[withdrawalId]/route";

const execFileAsync = promisify(execFile);

const prismaCliPath = createRequire(import.meta.url).resolve(
  "prisma/build/index.js",
);

let container: StartedPostgreSqlContainer | undefined;

let prisma: PrismaClient;

let serviceClient: PrismaClient | undefined;

let control: Pool;

const originalDatabaseUrl = process.env.DATABASE_URL;

const originalJwtSecret = process.env.JWT_SECRET;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const originalClient = globalForPrisma.prisma;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const databaseUrl = container.getConnectionUri();
  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = "pickup-route-disposable-test-secret";
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
      prisma?.$disconnect(),
      serviceClient?.$disconnect(),
      control?.end(),
    ]);
  } finally {
    try {
      await container?.stop();
    } finally {
      globalForPrisma.prisma = originalClient;
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = originalJwtSecret;
    }
  }
});

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if ("toJSON" in value && typeof value.toJSON === "function")
    return value.toJSON();
  if (Array.isArray(value)) return value.map(jsonValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
  );
}

async function contendOnRow(
  control: Pool,
  table: "pickups" | "wallets",
  id: number,
  operations: (() => Promise<Response>)[],
): Promise<Response[]> {
  const blocker = await control.connect();
  const pending: Promise<PromiseSettledResult<Response>>[] = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [
      id,
    ]);
    for (const operation of operations) {
      pending.push(
        operation().then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
      );
      const deadline = performance.now() + 2000;
      let blocked = false;
      while (performance.now() < deadline) {
        const result = await control.query<{ count: number }>(`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0
        `);
        if (result.rows[0].count >= pending.length) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!blocked)
        throw new Error(
          `Expected ${pending.length} requests waiting on the ${table} row lock`,
        );
    }
    await blocker.query("COMMIT");
    return (await Promise.all(pending)).map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
  } finally {
    try {
      await blocker.query("ROLLBACK");
    } finally {
      blocker.release();
      await Promise.all(pending);
    }
  }
}

let customerId: number;

let adminId: number;

let walletId: number;

let pickupId: number;

let otherWalletId: number;

const destinationPhone = "01000000000";

type LedgerEntry = {
  type: "payout" | "withdrawal" | "refund";
  amount: string;
  pickupId?: number;
  withdrawalId?: number;
};

function makeRequest(
  path: string,
  method: string,
  userId: number,
  body: unknown,
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      cookie: `token=${generateToken(userId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function updatePayoutStatus(id: number, input: { status: string }) {
  return payoutRoute(
    makeRequest(`/api/admin/pickups/${id}/payout`, "PATCH", adminId, input),
    { params: Promise.resolve({ pickupId: String(id) }) },
  );
}

function createWithdrawal(
  userId: number,
  input: { amount: number; destinationPhone: string },
) {
  return withdrawalRoute(
    makeRequest("/api/wallet/withdrawals", "POST", userId, input),
  );
}

function updateWithdrawalStatus(
  userId: number,
  id: number,
  input: { status: string },
) {
  return withdrawalStatusRoute(
    makeRequest(`/api/admin/wallets/withdrawals/${id}`, "PATCH", userId, input),
    { params: Promise.resolve({ withdrawalId: String(id) }) },
  );
}

async function contend(operations: (() => Promise<Response>)[]) {
  const responses = await contendOnRow(
    control,
    "wallets",
    walletId,
    operations,
  );
  for (const response of responses) {
    if (!response.ok) continue;
    const body = await response.clone().json();
    const saved =
      "payout_status" in body
        ? await prisma.pickup.findUniqueOrThrow({ where: { id: body.id } })
        : await prisma.withdrawalRequest.findUniqueOrThrow({
            where: { id: body.id },
          });
    expect(body).toEqual(jsonValue(saved));
  }
  return responses;
}

describe("Direct payout and withdrawal routes competing for wallet funds", () => {
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

  it("preserves both committed amounts when payout reaches the wallet first", async () => {
    const operations = [
      () => updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ];
    const results = await contend(operations);
    expect(results.map((result) => result.status)).toEqual([200, 201]);
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
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => updatePayoutStatus(pickupId, { status: "paid" }),
    ];
    const results = await contend(operations);
    expect(results.map((result) => result.status)).toEqual([201, 200]);
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
      () => updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 201]);
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
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => updatePayoutStatus(pickupId, { status: "paid" }),
    ]);

    expect(results[0].status).toBe(409);
    expect(await results[0].json()).toEqual({
      error: "Insufficient wallet balance.",
    });

    expect(results[1].status).toBe(200);
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
      () => updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => updatePayoutStatus(pickupId, { status: "paid" }),
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(201);

    expect(results[2].status).toBe(409);
    expect(await results[2].json()).toEqual({
      error: "Payout has already been done.",
    });

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
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
      () => updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ]);
    expect(results[0].status).toBe(201);
    expect(results[1].status).toBe(200);

    expect(results[2].status).toBe(409);
    expect(await results[2].json()).toEqual({
      error: "Insufficient wallet balance.",
    });

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
    const withdrawalResponse = await createWithdrawal(customerId, {
      amount: 200,
      destinationPhone,
    });
    expect(withdrawalResponse.status).toBe(201);
    const withdrawal: { id: number } = await withdrawalResponse.json();
    const refund = () =>
      updateWithdrawalStatus(adminId, withdrawal.id, {
        status: "cancelled",
      });
    const results = await contend([
      refund,
      () => updatePayoutStatus(pickupId, { status: "paid" }),
      refund,
    ]);
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);

    expect(results[2].status).toBe(409);
    expect(await results[2].json()).toEqual({
      error: "Withdrawal has already been handled.",
    });

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
      () => updatePayoutStatus(pickupId, { status: "paid" }),
      () =>
        createWithdrawal(customerId, {
          amount: 200,
          destinationPhone,
        }),
    ]);
    expect(results[0].status).toBe(500);
    expect(await results[0].json()).toEqual({
      error: "Internal server error.",
    });
    expect(results[1].status).toBe(201);
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
    const withdrawalResponse = await createWithdrawal(customerId, {
      amount: 200,
      destinationPhone,
    });
    expect(withdrawalResponse.status).toBe(201);
    const withdrawal: { id: number } = await withdrawalResponse.json();
    const withdrawalBefore = await prisma.withdrawalRequest.findUniqueOrThrow({
      where: { id: withdrawal.id },
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
      updateWithdrawalStatus(adminId, withdrawal.id, {
        status: "cancelled",
      });
    const results = await contend([
      refund,
      () => updatePayoutStatus(pickupId, { status: "paid" }),
    ]);
    expect(results[0].status).toBe(500);
    expect(await results[0].json()).toEqual({
      error: "Internal server error.",
    });
    expect(results[1].status).toBe(200);
    expect(
      await prisma.withdrawalRequest.findUniqueOrThrow({
        where: { id: withdrawal.id },
      }),
    ).toEqual(withdrawalBefore);
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
