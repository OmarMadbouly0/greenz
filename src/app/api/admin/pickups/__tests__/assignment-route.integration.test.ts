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
import { PATCH as assignPickupRoute } from "@/app/api/admin/pickups/[pickupId]/assign/route";
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
      full_name: "Assignment route admin",
      email: "assignment-route-admin@example.com",
      password_hash: "unused-for-cookie-authentication",
      role: "admin",
    },
  });
  adminCookie = `token=${generateToken(admin.id)}`;
});

function patchAssignment(collectorId: number, pickupId: number) {
  return assignPickupRoute(
    new Request(`http://localhost/api/admin/pickups/${pickupId}/assign`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ collectorId }),
    }),
    { params: Promise.resolve({ pickupId: String(pickupId) }) },
  );
}

function settleResponse(
  operation: Promise<Response>,
): Promise<PromiseSettledResult<Response>> {
  return operation.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function waitForBlockedAssignments(count: number) {
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
  throw new Error(
    `Expected ${count} assignments waiting on the pickup row lock`,
  );
}

async function assignConcurrently(pickupId: number, collectorIds: number[]) {
  const blocker = await control.connect();
  const pending: Promise<PromiseSettledResult<Response>>[] = [];
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM pickups WHERE id = $1 FOR UPDATE", [
      pickupId,
    ]);
    for (const collectorId of collectorIds) {
      pending.push(settleResponse(patchAssignment(collectorId, pickupId)));
      await waitForBlockedAssignments(pending.length);
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

describe("PATCH /api/admin/pickups/[pickupId]/assign", () => {
  it("assigns a pending pickup to a collector without changing its items or financial state", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Pending assignment customer",
        email: "assign-pending-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Pending assignment collector",
        email: "assign-pending-collector@example.com",
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
        name: "Assignment paper",
        unit: "kg",
        current_price: 25,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
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

    const response = await patchAssignment(collector.id, before.id);
    expect(response.status).toBe(200);
    const result = await response.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      collector_id: collector.id,
      status: "assigned",
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

  it("rejects assignment of a nonexistent pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment missing-pickup customer",
        email: "assign-missing-pickup-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment missing-pickup collector",
        email: "assign-missing-pickup-collector@example.com",
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
        name: "Assignment missing-pickup paper",
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
    const deletedPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "pending",
        payout: 40,
      },
    });
    await prisma.pickup.delete({ where: { id: deletedPickup.id } });

    const response = await patchAssignment(collector.id, deletedPickup.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Pickup not found.",
    });
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

  it("rejects assignment to a nonexistent collector", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment missing-collector customer",
        email: "assign-missing-collector-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment missing-collector collector",
        email: "assign-missing-collector-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    await prisma.user.delete({ where: { id: collector.id } });
    const wallet = await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01100000003",
        balance: "125.50",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "Assignment missing-collector paper",
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

    const response = await patchAssignment(collector.id, before.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Collector not found.",
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

  it("rejects assigning a customer as the collector", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment customer-role customer",
        email: "assign-customer-role-customer@example.com",
        password_hash: "unused",
        role: "customer",
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
        name: "Assignment customer-role paper",
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

    const response = await patchAssignment(customer.id, before.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Collector not found.",
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

  it("rejects assigning an admin as the collector", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment admin-role customer",
        email: "assign-admin-role-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const admin = await prisma.user.create({
      data: {
        full_name: "Admin who cannot collect",
        email: "assign-admin-role@example.com",
        password_hash: "unused",
        role: "admin",
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
        name: "Assignment admin-role paper",
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

    const response = await patchAssignment(admin.id, before.id);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Collector not found.",
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

  it("rejects replacing the collector of an already assigned pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment already-assigned customer",
        email: "assign-already-assigned-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment already-assigned collector",
        email: "assign-already-assigned-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Alternative assignment collector",
        email: "assign-already-assigned-other-collector@example.com",
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
        name: "Assignment already-assigned paper",
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

    const response = await patchAssignment(otherCollector.id, before.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Only pending, unassigned pickups can be assigned.",
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

  it("rejects assignment when the pickup is on_the_way", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment on-the-way customer",
        email: "assign-on-the-way-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment on-the-way collector",
        email: "assign-on-the-way-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Alternative assignment collector",
        email: "assign-on-the-way-other-collector@example.com",
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
        name: "Assignment on-the-way paper",
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

    const response = await patchAssignment(otherCollector.id, before.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Only pending, unassigned pickups can be assigned.",
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

  it("rejects assignment when the pickup is arrived", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment arrived customer",
        email: "assign-arrived-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment arrived collector",
        email: "assign-arrived-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Alternative assignment collector",
        email: "assign-arrived-other-collector@example.com",
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
        name: "Assignment arrived paper",
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

    const response = await patchAssignment(otherCollector.id, before.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Only pending, unassigned pickups can be assigned.",
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

  it("rejects assignment when the pickup is completed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment completed customer",
        email: "assign-completed-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment completed collector",
        email: "assign-completed-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Alternative assignment collector",
        email: "assign-completed-other-collector@example.com",
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
        name: "Assignment completed paper",
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

    const response = await patchAssignment(otherCollector.id, before.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Only pending, unassigned pickups can be assigned.",
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

  it("rejects assignment when the pickup is cancelled", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment cancelled customer",
        email: "assign-cancelled-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment cancelled collector",
        email: "assign-cancelled-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Alternative assignment collector",
        email: "assign-cancelled-other-collector@example.com",
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
        name: "Assignment cancelled paper",
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

    const response = await patchAssignment(otherCollector.id, before.id);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Only pending, unassigned pickups can be assigned.",
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

  it("allows exactly one of two collectors to receive the same pickup concurrently", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assignment concurrent customer",
        email: "assign-concurrent-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assignment concurrent collector",
        email: "assign-concurrent-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Alternative assignment collector",
        email: "assign-concurrent-other-collector@example.com",
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
        name: "Assignment concurrent paper",
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

    const responses = await assignConcurrently(before.id, [
      collector.id,
      otherCollector.id,
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const successResponse = responses.find(
      (response) => response.status === 200,
    );
    const failureResponse = responses.find(
      (response) => response.status === 409,
    );
    if (!successResponse || !failureResponse) {
      throw new Error(
        "Expected one successful assignment and one conflict response.",
      );
    }
    const success = await successResponse.json();
    expect(await failureResponse.json()).toEqual({
      error: "Only pending, unassigned pickups can be assigned.",
    });
    const expectedCollectorId =
      responses[0].status === 200 ? collector.id : otherCollector.id;
    expect(success.collector_id).toBe(expectedCollectorId);

    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      collector_id: expectedCollectorId,
      status: "assigned",
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
});
