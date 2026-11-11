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
import { PATCH as unassignPickupRoute } from "@/app/api/admin/pickups/[pickupId]/unassign/route";
import { PATCH as progressPickupRoute } from "@/app/api/pickups/[pickupId]/route";
import { getPrisma } from "@/infrastructure/database/prisma";
import { generateToken } from "@/modules/identity/application/jwt";

const execFileAsync = promisify(execFile);
const prismaCliPath = createRequire(import.meta.url).resolve(
  "prisma/build/index.js",
);

let container: StartedPostgreSqlContainer | undefined;
let prisma: PrismaClient;
let serviceClient: PrismaClient | undefined;
let control: Pool;
let adminCookie: string;
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
  const admin = await prisma.user.create({
    data: {
      full_name: "Unassignment route admin",
      email: "unassignment-route-admin@example.com",
      password_hash: "unused-for-cookie-authentication",
      role: "admin",
    },
  });
  adminCookie = `token=${generateToken(admin.id)}`;
});

function patchUnassignment(pickupId: number | string, cookie = adminCookie) {
  return unassignPickupRoute(
    new Request(`http://localhost/api/admin/pickups/${pickupId}/unassign`, {
      method: "PATCH",
      headers: { cookie },
    }),
    { params: Promise.resolve({ pickupId: String(pickupId) }) },
  );
}

function patchProgress(collectorId: number, pickupId: number) {
  return progressPickupRoute(
    new Request(`http://localhost/api/pickups/${pickupId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `token=${generateToken(collectorId)}`,
      },
      body: JSON.stringify({ status: "on_the_way" }),
    }),
    { params: Promise.resolve({ pickupId: String(pickupId) }) },
  );
}

function settleResponse(operation: Promise<Response>): Promise<PromiseSettledResult<Response>> {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function waitForBlockedRequests(count: number) {
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${count} requests waiting on the pickup row lock`);
}

async function runConcurrently(pickupId: number, operations: (() => Promise<Response>)[]) {
  const blocker = await control.connect();
  const pending: Promise<PromiseSettledResult<Response>>[] = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM pickups WHERE id = $1 FOR UPDATE", [pickupId]);
    for (const operation of operations) {
      pending.push(settleResponse(operation()));
      await waitForBlockedRequests(pending.length);
    }
    await blocker.query("COMMIT");
    const outcomes = await Promise.all(pending);
    return outcomes.map((outcome) => {
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

describe("PATCH /api/admin/pickups/[pickupId]/unassign", () => {
  it("unassigns an assigned pickup, clears its collector, and returns it to pending", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment success customer",
        email: "unassign-success-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment success collector",
        email: "unassign-success-collector@example.com",
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
        name: "Unassignment success paper",
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

    const response = await patchUnassignment(before.id);
    expect(response.status).toBe(200);
    const result = await response.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      collector_id: null,
      status: "pending",
      updated_at: new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(JSON.parse(JSON.stringify(savedFields)));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("rejects unassignment of a nonexistent pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment missing customer",
        email: "unassign-missing-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment missing collector",
        email: "unassign-missing-collector@example.com",
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
        name: "Unassignment missing paper",
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

    const unassignment = await patchUnassignment(deletedPickup.id);
    expect(unassignment.status).toBe(404);
    expect(await unassignment.json()).toEqual({ error: "Pickup not found." });
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

  it("rejects unassignment of a pending pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment pending customer",
        email: "unassign-pending-customer@example.com",
        password_hash: "unused",
        role: "customer",
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
        name: "Unassignment pending paper",
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

    const unassignment = await patchUnassignment(before.id);
    expect(unassignment.status).toBe(409);
    expect(await unassignment.json()).toEqual({ error: "Pickup is not assigned to a collector." });
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

  it("rejects unassignment when the pickup is on_the_way", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment on-the-way customer",
        email: "unassign-on-the-way-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment on-the-way collector",
        email: "unassign-on-the-way-collector@example.com",
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
        name: "Unassignment on-the-way paper",
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

    const unassignment = await patchUnassignment(before.id);
    expect(unassignment.status).toBe(409);
    expect(await unassignment.json()).toEqual({ error: "Pickup is not assigned to a collector." });
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

  it("rejects unassignment when the pickup is arrived", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment arrived customer",
        email: "unassign-arrived-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment arrived collector",
        email: "unassign-arrived-collector@example.com",
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
        name: "Unassignment arrived paper",
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

    const unassignment = await patchUnassignment(before.id);
    expect(unassignment.status).toBe(409);
    expect(await unassignment.json()).toEqual({ error: "Pickup is not assigned to a collector." });
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

  it("rejects unassignment when the pickup is completed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment completed customer",
        email: "unassign-completed-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment completed collector",
        email: "unassign-completed-collector@example.com",
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
        name: "Unassignment completed paper",
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

    const unassignment = await patchUnassignment(before.id);
    expect(unassignment.status).toBe(409);
    expect(await unassignment.json()).toEqual({ error: "Pickup is not assigned to a collector." });
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

  it("rejects unassignment when the pickup is cancelled", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment cancelled customer",
        email: "unassign-cancelled-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment cancelled collector",
        email: "unassign-cancelled-collector@example.com",
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
        name: "Unassignment cancelled paper",
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

    const unassignment = await patchUnassignment(before.id);
    expect(unassignment.status).toBe(409);
    expect(await unassignment.json()).toEqual({ error: "Pickup is not assigned to a collector." });
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

  it("rejects a second unassignment without changing the saved state", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment repeat customer",
        email: "unassign-repeat-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment repeat collector",
        email: "unassign-repeat-collector@example.com",
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
        name: "Unassignment repeat paper",
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

    const response = await patchUnassignment(before.id);
    expect(response.status).toBe(200);
    const result = await response.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      collector_id: null,
      status: "pending",
      updated_at: new Date(result.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(JSON.parse(JSON.stringify(savedFields)));
    expect(items).toEqual(before.items);

    const secondUnassignment = await patchUnassignment(before.id);
    expect(secondUnassignment.status).toBe(409);
    expect(await secondUnassignment.json()).toEqual({ error: "Pickup is not assigned to a collector." });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(saved);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it("allows exactly one of two concurrent unassignment requests to succeed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment concurrent customer",
        email: "unassign-concurrent-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment concurrent collector",
        email: "unassign-concurrent-collector@example.com",
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
        name: "Unassignment concurrent paper",
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

    const responses = await runConcurrently(before.id, [
      () => patchUnassignment(before.id),
      () => patchUnassignment(before.id),
    ]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const successResponse = responses.find((response) => response.status === 200);
    const failureResponse = responses.find((response) => response.status !== 200);
    if (!successResponse || !failureResponse) {
      throw new Error("Expected one successful response and one failure response.");
    }
    const success = await successResponse.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(failureResponse.status).toBe(409);
    expect(await failureResponse.json()).toEqual({ error: "Pickup is not assigned to a collector." });
    expect(saved).toEqual({
      ...before,
      collector_id: null,
      status: "pending",
      updated_at: new Date(success.updated_at),
    });
    const { items, ...savedFields } = saved;
    expect(success).toEqual(JSON.parse(JSON.stringify(savedFields)));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it.each(["unassignment", "progress"] as const)("allows only one of unassignment and collector progress to succeed concurrently (%s first)", async (first) => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Unassignment progress-race customer",
        email: "unassign-progress-race-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Unassignment progress-race collector",
        email: "unassign-progress-race-collector@example.com",
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
        name: "Unassignment progress-race paper",
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

    const operations = [
      () => patchUnassignment(before.id),
      () => patchProgress(collector.id, before.id),
    ];
    if (first === "progress") operations.reverse();
    const responses = await runConcurrently(before.id, operations);
    // Both requests were observed waiting on the row lock before release.
    expect(responses[0].status).toBe(200);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const successResponse = responses.find((response) => response.status === 200);
    const failureResponse = responses.find((response) => response.status !== 200);
    if (!successResponse || !failureResponse) {
      throw new Error("Expected one successful response and one failure response.");
    }
    const success = await successResponse.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    if (first === "unassignment") {
      expect(failureResponse.status).toBe(404);
      expect(await failureResponse.json()).toEqual({ error: "Pickup not found." });
      expect(saved).toEqual({
        ...before,
        collector_id: null,
        status: "pending",
        updated_at: new Date(success.updated_at),
      });
    } else {
      expect(failureResponse.status).toBe(409);
      expect(await failureResponse.json()).toEqual({
        error: "Pickup is not assigned to a collector.",
      });
      expect(saved).toEqual({
        ...before,
        status: "on_the_way",
        updated_at: new Date(success.updated_at),
      });
    }
    const { items, ...savedFields } = saved;
    expect(success).toEqual(JSON.parse(JSON.stringify(savedFields)));
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });

  it.each(["missing", "invalid", "deleted", "customer", "collector"] as const)(
    "rejects %s authentication without changing persisted state",
    async (auth) => {
      const customer = await prisma.user.create({
        data: {
          full_name: "Unassignment success customer",
          email: "unassign-success-customer@example.com",
          password_hash: "unused",
          role: "customer",
        },
      });
      const collector = await prisma.user.create({
        data: {
          full_name: "Unassignment success collector",
          email: "unassign-success-collector@example.com",
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
          name: "Unassignment success paper",
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

      let cookie = "";
      if (auth === "invalid") cookie = "token=invalid-jwt";
      if (auth === "customer") cookie = `token=${generateToken(customer.id)}`;
      if (auth === "collector") cookie = `token=${generateToken(collector.id)}`;
      if (auth === "deleted") {
        const deleted = await prisma.user.create({
          data: { full_name: "Deleted admin", email: "deleted@example.com", password_hash: "unused", role: "admin" },
        });
        cookie = `token=${generateToken(deleted.id)}`;
        await prisma.user.delete({ where: { id: deleted.id } });
      }
      const response = await patchUnassignment(before.id, cookie);
      const forbidden = auth === "customer" || auth === "collector";
      expect(response.status).toBe(forbidden ? 403 : 401);
      expect(await response.json()).toEqual({
        error: forbidden ? "User does not have the required role."
          : auth === "missing" ? "Authentication required / Token not found."
          : auth === "deleted" ? "User not found." : "Invalid or expired token.",
      });
      expect(await prisma.pickup.findUniqueOrThrow({ where: { id: before.id }, include: { items: true } })).toEqual(before);
      expect(await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).toEqual(wallet);
      expect(await prisma.walletTransaction.count()).toBe(0);
    },
  );
});
