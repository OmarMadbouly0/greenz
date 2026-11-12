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
import { PATCH as statusRoute } from "@/app/api/pickups/[pickupId]/route";

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

beforeEach(async () => {
  await prisma.walletTransaction.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.pickup.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();
  await prisma.material.deleteMany();
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

function makeRequest(
  method: string,
  pickupId: number,
  userId: number,
  body?: unknown,
  payout = false,
) {
  return new Request(
    `http://localhost/api/${payout ? "admin/" : ""}pickups/${pickupId}${payout ? "/payout" : ""}`,
    {
      method,
      headers: {
        cookie: `token=${generateToken(userId)}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

function context(pickupId: number) {
  return { params: Promise.resolve({ pickupId: String(pickupId) }) };
}

function updatePickupStatus(
  userId: number,
  pickupId: number,
  input: { status: string },
) {
  return statusRoute(
    makeRequest("PATCH", pickupId, userId, input),
    context(pickupId),
  );
}

describe("Direct pickup status routes (service scenario parity)", () => {
  it("moves an assigned pickup to on_the_way", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer awaiting collector progress",
        email: "status-assigned-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Collector starting pickup progress",
        email: "status-assigned-collector@example.com",
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
      data: {
        name: "Pickup progress paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const resultResponse = await updatePickupStatus(collector.id, before.id, {
      status: "on_the_way",
    });
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      status: "on_the_way",
      updated_at:
        result.updated_at === null ? null : new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("moves an on_the_way pickup to arrived", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status arrive customer",
        email: "status-arrive-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status arrive collector",
        email: "status-arrive-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000002",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status arrive paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "on_the_way",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });
    const resultResponse = await updatePickupStatus(collector.id, before.id, {
      status: "arrived",
    });
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      status: "arrived",
      updated_at:
        result.updated_at === null ? null : new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("completes an arrived pickup and records its completion time without paying it", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status complete customer",
        email: "status-complete-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status complete collector",
        email: "status-complete-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000003",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status complete paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "arrived",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const started = Date.now();
    const resultResponse = await updatePickupStatus(collector.id, before.id, {
      status: "completed",
    });
    expect(resultResponse.status).toBe(200);
    const result = await resultResponse.json();
    const ended = Date.now();
    expect(result.completed_at).toEqual(expect.any(String));
    if (result.completed_at === null) {
      throw new Error("Expected the pickup completion time to be recorded.");
    }
    expect(new Date(result.completed_at).getTime()).toBeGreaterThanOrEqual(
      started,
    );
    expect(new Date(result.completed_at).getTime()).toBeLessThanOrEqual(ended);
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      status: "completed",
      completed_at:
        result.completed_at === null ? null : new Date(result.completed_at),
      updated_at:
        result.updated_at === null ? null : new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("prevents another collector from updating the pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status other-collector customer",
        email: "status-other-collector-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status other-collector collector",
        email: "status-other-collector-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Collector without this assignment",
        email: "status-unassigned-reader@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000004",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status other-collector paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(otherCollector.id, before.id, {
      status: "on_the_way",
    });
    expect((await update).status).toBe(404);
    expect(await (await update).json()).toEqual({ error: "Pickup not found." });

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

  it("rejects progress updates for an unassigned pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status unassigned customer",
        email: "status-unassigned-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status unassigned collector",
        email: "status-unassigned-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000005",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status unassigned paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: null,
        status: "pending",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "on_the_way",
    });
    expect((await update).status).toBe(404);
    expect(await (await update).json()).toEqual({ error: "Pickup not found." });

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

  it("returns not-found when updating a nonexistent pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status missing customer",
        email: "status-missing-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status missing collector",
        email: "status-missing-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000006",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status missing paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });
    const deletedPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 40,
      },
    });
    await prisma.pickup.delete({ where: { id: deletedPickup.id } });

    const update = updatePickupStatus(collector.id, deletedPickup.id, {
      status: "on_the_way",
    });
    expect((await update).status).toBe(404);
    expect(await (await update).json()).toEqual({ error: "Pickup not found." });

    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.pickup.findUnique({ where: { id: deletedPickup.id } }),
    ).toBeNull();
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects skipping from assigned to arrived", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status skip-arrival customer",
        email: "status-skip-arrival-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status skip-arrival collector",
        email: "status-skip-arrival-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000007",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status skip-arrival paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "arrived",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup must move from assigned to on_the_way.",
    });

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

  it("rejects skipping from assigned to completed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status skip-assigned-completion customer",
        email: "status-skip-assigned-completion-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status skip-assigned-completion collector",
        email: "status-skip-assigned-completion-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000008",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status skip-assigned-completion paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "completed",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup must move from assigned to on_the_way.",
    });

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

  it("rejects skipping from on_the_way to completed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status skip-travel-completion customer",
        email: "status-skip-travel-completion-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status skip-travel-completion collector",
        email: "status-skip-travel-completion-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000009",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status skip-travel-completion paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "on_the_way",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "completed",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup must move from on_the_way to arrived.",
    });

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

  it("rejects moving an arrived pickup back to on_the_way", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status backwards customer",
        email: "status-backwards-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status backwards collector",
        email: "status-backwards-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000010",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status backwards paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "arrived",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "on_the_way",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup must move from arrived to completed.",
    });

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

  it("rejects repeating the on_the_way status", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status repeat-travel customer",
        email: "status-repeat-travel-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status repeat-travel collector",
        email: "status-repeat-travel-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000011",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status repeat-travel paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "on_the_way",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "on_the_way",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup must move from on_the_way to arrived.",
    });

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

  it("rejects repeating the arrived status", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status repeat-arrival customer",
        email: "status-repeat-arrival-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status repeat-arrival collector",
        email: "status-repeat-arrival-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000012",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status repeat-arrival paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "arrived",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "arrived",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup must move from arrived to completed.",
    });

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

  it("rejects completing an already completed pickup and preserves its completion time", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status repeat-completion customer",
        email: "status-repeat-completion-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status repeat-completion collector",
        email: "status-repeat-completion-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000013",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status repeat-completion paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        completed_at: new Date("2026-01-01T10:00:00Z"),
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "completed",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup has already been handled.",
    });

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

  it("rejects progress updates for a cancelled pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status cancelled customer",
        email: "status-cancelled-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status cancelled collector",
        email: "status-cancelled-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000014",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status cancelled paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "cancelled",
        payout_status: "cancelled",
        payout: 23.75,
        note: "Collect from reception.",
        cancelled_at: new Date("2026-01-01T10:00:00Z"),
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const update = updatePickupStatus(collector.id, before.id, {
      status: "on_the_way",
    });
    expect((await update).status).toBe(409);
    expect(await (await update).json()).toEqual({
      error: "Pickup has already been handled.",
    });

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

  it("allows exactly one of two concurrent completion requests to succeed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Status concurrent-completion customer",
        email: "status-concurrent-completion-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Status concurrent-completion collector",
        email: "status-concurrent-completion-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000015",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Status concurrent-completion paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "arrived",
        payout_status: "pending",
        payout: 23.75,
        note: "Collect from reception.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });

    const started = Date.now();
    const results = await contendOnRow(control, "pickups", before.id, [
      () =>
        updatePickupStatus(collector.id, before.id, {
          status: "completed",
        }),
      () =>
        updatePickupStatus(collector.id, before.id, {
          status: "completed",
        }),
    ]);
    const ended = Date.now();

    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect(results.filter((result) => result.status !== 200)).toHaveLength(1);
    const success = results.find((result) => result.status === 200);
    const failure = results.find((result) => result.status !== 200);
    if (!success || !failure) {
      throw new Error("Expected one successful completion and one rejection.");
    }
    expect(failure.status).toBe(409);
    const successBody = await success.json();
    expect(await failure.json()).toEqual({
      error: "Pickup has already been handled.",
    });
    expect(successBody.completed_at).toEqual(expect.any(String));
    if (successBody.completed_at === null) {
      throw new Error("Expected the pickup completion time to be recorded.");
    }
    expect(new Date(successBody.completed_at).getTime()).toBeGreaterThanOrEqual(
      started,
    );
    expect(new Date(successBody.completed_at).getTime()).toBeLessThanOrEqual(
      ended,
    );

    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      status: "completed",
      completed_at:
        successBody.completed_at === null
          ? null
          : new Date(successBody.completed_at),
      updated_at:
        successBody.updated_at === null
          ? null
          : new Date(successBody.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(successBody).toEqual(jsonValue(savedFields));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });
});
