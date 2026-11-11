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
import { Prisma } from "@/../generated/prisma/client";
import { generateToken } from "@/modules/identity/application/jwt";
import { PATCH as payoutRoute } from "@/app/api/admin/pickups/[pickupId]/payout/route";

const execFileAsync = promisify(execFile);

const prismaCliPath = createRequire(import.meta.url).resolve(
  "prisma/build/index.js",
);

let container: StartedPostgreSqlContainer | undefined;

let prisma: PrismaClient;

let serviceClient: PrismaClient | undefined;

let control: Pool;

let adminId: number;

const originalDatabaseUrl = process.env.DATABASE_URL;

const originalJwtSecret = process.env.JWT_SECRET;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; };

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

beforeEach(async () => {
  await prisma.walletTransaction.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.pickup.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();
  await prisma.material.deleteMany();
  const admin = await prisma.user.create({
    data: {
      full_name: "Direct route admin",
      email: "direct-route-admin@example.com",
      password_hash: "unused-for-cookie-authentication",
      role: "admin",
    },
  });
  adminId = admin.id;
});

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if ("toJSON" in value && typeof value.toJSON === "function") return value.toJSON();
  if (Array.isArray(value)) return value.map(jsonValue);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
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
    await blocker.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    for (const operation of operations) {
      pending.push(operation().then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      ));
      const deadline = performance.now() + 2000;
      let blocked = false;
      while (performance.now() < deadline) {
        const result = await control.query<{ count: number; }>(`
          SELECT count(*)::int AS count FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND cardinality(pg_blocking_pids(pid)) > 0
        `);
        if (result.rows[0].count >= pending.length) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!blocked) throw new Error(`Expected ${pending.length} requests waiting on the ${table} row lock`);
    }
    await blocker.query("COMMIT");
    return (await Promise.all(pending)).map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return outcome.value;
    });
  } finally {
    try { await blocker.query("ROLLBACK"); }
    finally { blocker.release(); await Promise.all(pending); }
  }
}

function makeRequest(method: string, pickupId: number, userId: number, body?: unknown, payout = false) {
  return new Request(`http://localhost/api/${payout ? "admin/" : ""}pickups/${pickupId}${payout ? "/payout" : ""}`, {
    method,
    headers: { cookie: `token=${generateToken(userId)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function context(pickupId: number) { return { params: Promise.resolve({ pickupId: String(pickupId) }) }; }

function updatePayoutStatus(pickupId: number, input: { status: string; }) { return payoutRoute(makeRequest("PATCH", pickupId, adminId, input, true), context(pickupId)); }

describe("Direct pickup payout routes (service scenario parity)", () => {
  it("pays a completed pickup and credits only the correct wallet by the exact saved amount", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });
    const otherCustomer = await prisma.user.create({
      data: {
        full_name: "Other customer",
        email: "other@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const otherWallet = await prisma.wallet.create({
      data: {
        user_id: otherCustomer.id,
        phone: "01100000002",
        balance: "700.10",
      },
    });

    const resultResponse = await updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      payout_status: "paid",
      updated_at: new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    const savedWallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(savedWallet).toEqual({
      ...wallet,
      balance: new Prisma.Decimal("149.25"),
      updated_at: savedWallet.updated_at,
    });
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: otherWallet.id } }),
    ).toEqual(otherWallet);
    const transactions = await prisma.walletTransaction.findMany();
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      wallet_id: wallet.id,
      pickup_id: before.id,
      withdrawal_id: null,
      type: "payout",
      amount: new Prisma.Decimal("23.75"),
    });
  });

  it("cancels a pending payout without changing the wallet", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const resultResponse = await updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      payout_status: "cancelled",
      updated_at: new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("allows payout cancellation when the customer has no wallet", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const resultResponse = await updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      payout_status: "cancelled",
      updated_at: new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    expect(await prisma.wallet.count()).toBe(0);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects payout updates for a nonexistent pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });
    const deleted = await prisma.pickup.create({
      data: { customer_id: customer.id, status: "completed", payout: "10.00" },
    });
    await prisma.pickup.delete({ where: { id: deleted.id } });

    const payment = updatePayoutStatus(deleted.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(404);
    expect(await (await payment).json()).toEqual({ error: "Pickup not found." });
    const cancellation = updatePayoutStatus(deleted.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(404);
    expect(await (await cancellation).json()).toEqual({ error: "Pickup not found." });
    expect(
      await prisma.pickup.findUnique({ where: { id: deleted.id } }),
    ).toBeNull();
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects payment when the customer has no wallet", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(404);
    expect(await (await payment).json()).toEqual({ error: "Customer wallet not found." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(await prisma.wallet.count()).toBe(0);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects a pickup with no payout amount", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: null,
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Pickup has no payout amount." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Pickup has no payout amount." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects payout updates for a pending pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "pending",
        payout_status: "pending",
        payout: "23.75",
        completed_at: null,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects payout updates for a assigned pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: "23.75",
        completed_at: null,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects payout updates for a on_the_way pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "on_the_way",
        payout_status: "pending",
        payout: "23.75",
        completed_at: null,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects payout updates for a arrived pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "arrived",
        payout_status: "pending",
        payout: "23.75",
        completed_at: null,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects payout updates for a cancelled pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "cancelled",
        payout_status: "pending",
        payout: "23.75",
        completed_at: null,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Payout can only be updated for completed pickups." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects paying an already paid pickup without crediting it again", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "paid",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });
    const existingTransaction = await prisma.walletTransaction.create({
      data: {
        wallet_id: wallet.id,
        pickup_id: before.id,
        type: "payout",
        amount: "23.75",
      },
    });

    const update = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({ error: "Payout has already been done." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.findMany()).toEqual([
      existingTransaction,
    ]);
  });

  it("rejects cancelling an already paid payout", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "paid",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });
    const existingTransaction = await prisma.walletTransaction.create({
      data: {
        wallet_id: wallet.id,
        pickup_id: before.id,
        type: "payout",
        amount: "23.75",
      },
    });

    const update = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({ error: "Payout has already been done." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.findMany()).toEqual([
      existingTransaction,
    ]);
  });

  it("rejects paying a cancelled payout", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "cancelled",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({ error: "Payout has already been done." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects cancelling an already cancelled payout", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "cancelled",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({ error: "Payout has already been done." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("allows exactly one of two concurrent payments to succeed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const results = await contendOnRow(control, "pickups", before.id, [() => updatePayoutStatus(before.id, { status: "paid" }),
    () => updatePayoutStatus(before.id, { status: "paid" })]);
    const fulfilled = results.filter((result) => result.status === 200);
    const rejected = results.filter((result) => result.status !== 200);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(409);
    const successBody = await fulfilled[0].json();
    expect(await rejected[0].json()).toEqual({ error: "Payout has already been done." });
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    const winningStatus = "paid";
    expect(saved).toEqual({
      ...before,
      payout_status: winningStatus,
      updated_at: successBody.updated_at === null ? null : new Date(successBody.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(successBody).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    const savedWallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    const transactions = await prisma.walletTransaction.findMany();
    expect(savedWallet.balance.toFixed(2)).toBe("149.25");
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      wallet_id: wallet.id,
      pickup_id: before.id,
      type: "payout",
      amount: new Prisma.Decimal("23.75"),
    });
  });

  it.each(["payment", "cancellation"] as const)("allows only one of payment and payout cancellation to succeed concurrently (%s first)", async (first) => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const operations = [
      () => updatePayoutStatus(before.id, { status: "paid" }),
      () => updatePayoutStatus(before.id, { status: "cancelled" }),
    ];
    if (first === "cancellation") operations.reverse();
    const results = await contendOnRow(control, "pickups", before.id, operations);
    expect(results[0].status).toBe(200);
    if (first === "cancellation") results.reverse();
    const fulfilled = results.filter((result) => result.status === 200);
    const rejected = results.filter((result) => result.status !== 200);
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(409);
    const successBody = await fulfilled[0].json();
    expect(await rejected[0].json()).toEqual({ error: "Payout has already been done." });
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    const winningStatus =
      results[0].status === 200 ? "paid" : "cancelled";
    expect(saved).toEqual({
      ...before,
      payout_status: winningStatus,
      updated_at: successBody.updated_at === null ? null : new Date(successBody.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(successBody).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    const savedWallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    const transactions = await prisma.walletTransaction.findMany();
    if (winningStatus === "paid") {
      expect(savedWallet.balance.toFixed(2)).toBe("149.25");
      expect(transactions).toHaveLength(1);
      expect(transactions[0]).toMatchObject({
        wallet_id: wallet.id,
        pickup_id: before.id,
        type: "payout",
        amount: new Prisma.Decimal("23.75"),
      });
    } else {
      expect(savedWallet).toEqual(wallet);
      expect(transactions).toHaveLength(0);
    }
  });

  it("credits two different pickups paid concurrently into the same wallet", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });
    const second = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "10.27",
        completed_at: new Date("2026-01-02T10:00:00Z"),
        items: {
          create: {
            material_id: material.id,
            quantity: "1.00",
            price_per_unit: "10.27",
          },
        },
      },
      include: { items: true },
    });

    const operations = [() => updatePayoutStatus(before.id, { status: "paid" }),
    () => updatePayoutStatus(second.id, { status: "paid" })];
    const results = await contendOnRow(control, "wallets", wallet.id, operations);
    expect(results.map((result) => result.status)).toEqual([
      200,
      200,
    ]);
    const savedFirst = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    const savedSecond = await prisma.pickup.findUniqueOrThrow({
      where: { id: second.id },
      include: { items: true },
    });
    const { items: firstItems, ...firstFields } = savedFirst;
    const { items: secondItems, ...secondFields } = savedSecond;
    expect(await results[0].json()).toEqual(jsonValue(firstFields));
    expect(await results[1].json()).toEqual(jsonValue(secondFields));
    expect(firstItems).toEqual(before.items);
    expect(secondItems).toEqual(second.items);
    expect(savedFirst).toEqual({
      ...before,
      payout_status: "paid",
      updated_at: savedFirst.updated_at,
    });
    expect(savedSecond).toEqual({
      ...second,
      payout_status: "paid",
      updated_at: savedSecond.updated_at,
    });
    const savedWallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(savedWallet.balance.toFixed(2)).toBe("159.52");
    const transactions = await prisma.walletTransaction.findMany({
      orderBy: { pickup_id: "asc" },
    });
    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      wallet_id: wallet.id,
      pickup_id: before.id,
      type: "payout",
      amount: new Prisma.Decimal("23.75"),
    });
    expect(transactions[1]).toMatchObject({
      wallet_id: wallet.id,
      pickup_id: second.id,
      type: "payout",
      amount: new Prisma.Decimal("10.27"),
    });
  });

  it("rolls back the wallet increment when payout transaction creation violates uniqueness", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });
    const existingTransaction = await prisma.walletTransaction.create({
      data: {
        wallet_id: wallet.id,
        pickup_id: before.id,
        type: "payout",
        amount: "23.75",
      },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(500);
    expect(await (await payment).json()).toEqual({ error: "Internal server error." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.findMany()).toEqual([
      existingTransaction,
    ]);
  });

  it("rejects a zero payout amount", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "0.00",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Pickup payout amount must be at least 1." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Pickup payout amount must be at least 1." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects a negative payout amount", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Payout customer",
        email: "payout-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Payout collector",
        email: "payout-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000001",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: "99.00" },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: "-23.75",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: "2.50",
            price_per_unit: "9.50",
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });

    const payment = updatePayoutStatus(before.id, {
      status: "paid",
    });
    expect((await payment).status).toBe(409);
    expect(await (await payment).json()).toEqual({ error: "Pickup payout amount must be at least 1." });
    const cancellation = updatePayoutStatus(before.id, {
      status: "cancelled",
    });
    expect((await cancellation).status).toBe(409);
    expect(await (await cancellation).json()).toEqual({ error: "Pickup payout amount must be at least 1." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });
});
