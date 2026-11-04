import { PrismaClient } from "@/../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { pickupService } from "@/services/pickup.service";
import { getPrisma } from "@/infrastructure/database/prisma";
import {
  ConflictError,
  NotFoundError,
} from "@/shared/errors/application-error";

const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);
const prismaCliPath = requireFromTest.resolve("prisma/build/index.js");

describe("PickupService.assignPickupToCollector", () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = container.getConnectionUri();
    process.env.DATABASE_URL = databaseUrl;
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
  }, 180_000);

  beforeEach(async () => {
    await prisma.walletTransaction.deleteMany();
    await prisma.withdrawalRequest.deleteMany();
    await prisma.pickupItem.deleteMany();
    await prisma.pickup.deleteMany();
    await prisma.wallet.deleteMany();
    await prisma.address.deleteMany();
    await prisma.user.deleteMany();
    await prisma.material.deleteMany();
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await getPrisma().$disconnect();
        await prisma.$disconnect();
      }
    } finally {
      await container?.stop();
    }
  });

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

    const result = await pickupService.assignPickupToCollector(
      collector.id,
      before.id,
    );
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      collector_id: collector.id,
      status: "assigned",
      updated_at: result.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
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

    const assignment = pickupService.assignPickupToCollector(
      collector.id,
      deletedPickup.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignment).rejects.toThrow("Pickup not found.");
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

    const assignment = pickupService.assignPickupToCollector(
      collector.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignment).rejects.toThrow("Collector not found.");
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

    const assignment = pickupService.assignPickupToCollector(
      customer.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignment).rejects.toThrow("Collector not found.");
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

    const assignment = pickupService.assignPickupToCollector(
      admin.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(NotFoundError);
    await expect(assignment).rejects.toThrow("Collector not found.");
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

    const assignment = pickupService.assignPickupToCollector(
      otherCollector.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(ConflictError);
    await expect(assignment).rejects.toThrow(
      "Only pending, unassigned pickups can be assigned.",
    );
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

    const assignment = pickupService.assignPickupToCollector(
      otherCollector.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(ConflictError);
    await expect(assignment).rejects.toThrow(
      "Only pending, unassigned pickups can be assigned.",
    );
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

    const assignment = pickupService.assignPickupToCollector(
      otherCollector.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(ConflictError);
    await expect(assignment).rejects.toThrow(
      "Only pending, unassigned pickups can be assigned.",
    );
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

    const assignment = pickupService.assignPickupToCollector(
      otherCollector.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(ConflictError);
    await expect(assignment).rejects.toThrow(
      "Only pending, unassigned pickups can be assigned.",
    );
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

    const assignment = pickupService.assignPickupToCollector(
      otherCollector.id,
      before.id,
    );
    await expect(assignment).rejects.toBeInstanceOf(ConflictError);
    await expect(assignment).rejects.toThrow(
      "Only pending, unassigned pickups can be assigned.",
    );
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

    const results = await Promise.allSettled([
      pickupService.assignPickupToCollector(collector.id, before.id),
      pickupService.assignPickupToCollector(otherCollector.id, before.id),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const success = results.find((result) => result.status === "fulfilled");
    const failure = results.find((result) => result.status === "rejected");
    if (success?.status !== "fulfilled" || failure?.status !== "rejected") {
      throw new Error("Expected one successful assignment and one rejection.");
    }
    expect(failure.reason).toBeInstanceOf(ConflictError);
    expect(failure.reason.message).toBe(
      "Only pending, unassigned pickups can be assigned.",
    );
    const expectedCollectorId =
      results[0].status === "fulfilled" ? collector.id : otherCollector.id;
    expect(success.value.collector_id).toBe(expectedCollectorId);

    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      collector_id: expectedCollectorId,
      status: "assigned",
      updated_at: success.value.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(success.value).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });
});
