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

describe("PickupService.unassignPickupFromCollector", () => {
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

    const result = await pickupService.unassignPickupFromCollector(before.id);
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      collector_id: null,
      status: "pending",
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

    const unassignment = pickupService.unassignPickupFromCollector(
      deletedPickup.id,
    );
    await expect(unassignment).rejects.toBeInstanceOf(NotFoundError);
    await expect(unassignment).rejects.toThrow("Pickup not found.");
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

    const unassignment = pickupService.unassignPickupFromCollector(before.id);
    await expect(unassignment).rejects.toBeInstanceOf(ConflictError);
    await expect(unassignment).rejects.toThrow(
      "Pickup is not assigned to a collector.",
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

    const unassignment = pickupService.unassignPickupFromCollector(before.id);
    await expect(unassignment).rejects.toBeInstanceOf(ConflictError);
    await expect(unassignment).rejects.toThrow(
      "Pickup is not assigned to a collector.",
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

    const unassignment = pickupService.unassignPickupFromCollector(before.id);
    await expect(unassignment).rejects.toBeInstanceOf(ConflictError);
    await expect(unassignment).rejects.toThrow(
      "Pickup is not assigned to a collector.",
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

    const unassignment = pickupService.unassignPickupFromCollector(before.id);
    await expect(unassignment).rejects.toBeInstanceOf(ConflictError);
    await expect(unassignment).rejects.toThrow(
      "Pickup is not assigned to a collector.",
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

    const unassignment = pickupService.unassignPickupFromCollector(before.id);
    await expect(unassignment).rejects.toBeInstanceOf(ConflictError);
    await expect(unassignment).rejects.toThrow(
      "Pickup is not assigned to a collector.",
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

    const result = await pickupService.unassignPickupFromCollector(before.id);
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(saved).toEqual({
      ...before,
      collector_id: null,
      status: "pending",
      updated_at: result.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
    expect(items).toEqual(before.items);

    const secondUnassignment = pickupService.unassignPickupFromCollector(
      before.id,
    );
    await expect(secondUnassignment).rejects.toBeInstanceOf(ConflictError);
    await expect(secondUnassignment).rejects.toThrow(
      "Pickup is not assigned to a collector.",
    );
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

    const results = await Promise.allSettled([
      pickupService.unassignPickupFromCollector(before.id),
      pickupService.unassignPickupFromCollector(before.id),
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
      throw new Error("Expected one successful operation and one rejection.");
    }
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(failure.reason).toBeInstanceOf(ConflictError);
    expect(failure.reason.message).toBe(
      "Pickup is not assigned to a collector.",
    );
    expect(saved).toEqual({
      ...before,
      collector_id: null,
      status: "pending",
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

  it("allows only one of unassignment and collector progress to succeed concurrently", async () => {
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

    const results = await Promise.allSettled([
      pickupService.unassignPickupFromCollector(before.id),
      pickupService.updatePickupStatus(collector.id, before.id, {
        status: "on_the_way",
      }),
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
      throw new Error("Expected one successful operation and one rejection.");
    }
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    if (results[0].status === "fulfilled") {
      expect(failure.reason).toBeInstanceOf(NotFoundError);
      expect(failure.reason.message).toBe("Pickup not found.");
      expect(saved).toEqual({
        ...before,
        collector_id: null,
        status: "pending",
        updated_at: success.value.updated_at,
      });
    } else {
      expect(failure.reason).toBeInstanceOf(ConflictError);
      expect(failure.reason.message).toBe(
        "Pickup is not assigned to a collector.",
      );
      expect(saved).toEqual({
        ...before,
        status: "on_the_way",
        updated_at: success.value.updated_at,
      });
    }
    const { items, ...savedFields } = saved;
    expect(success.value).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.count()).toBe(0);
  });
});
