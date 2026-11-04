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

describe("PickupService.cancelPickup", () => {
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

  it("allows a customer to cancel their own pending pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Pending cancellation customer",
        email: "cancel-pending@example.com",
        password_hash: "unused",
        role: "customer",
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
        name: "Pending cancellation plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "pending",
        payout_status: "pending",
        payout: 40,
        note: "Call at the gate.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Blue bags.",
          },
        },
      },
      include: { items: true },
    });
    const unrelated = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 20,
        note: "Keep this pickup.",
        items: {
          create: { material_id: material.id, quantity: 2, price_per_unit: 10 },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });

    const started = Date.now();
    const result = await pickupService.cancelPickup(customer.id, before.id);
    const ended = Date.now();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });

    expect(result.id).toBe(before.id);
    expect(result.status).toBe("cancelled");
    expect(result.payout_status).toBe("cancelled");
    expect(result.cancelled_at).toBeInstanceOf(Date);
    expect(result.cancelled_at!.getTime()).toBeGreaterThanOrEqual(started);
    expect(result.cancelled_at!.getTime()).toBeLessThanOrEqual(ended);
    expect(saved).toEqual({
      ...before,
      status: "cancelled",
      payout_status: "cancelled",
      cancelled_at: result.cancelled_at,
      updated_at: result.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: unrelated.id },
        include: { items: true },
      }),
    ).toEqual(unrelated);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("cancels an assigned pickup and retains its collector", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Assigned cancellation customer",
        email: "cancel-assigned@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assigned cancellation collector",
        email: "cancel-assigned-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000002", balance: 80 },
    });
    const material = await prisma.material.create({
      data: {
        name: "Assigned cancellation paper",
        unit: "kg",
        current_price: 12,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 36,
        note: "Side entrance.",
        items: {
          create: {
            material_id: material.id,
            quantity: 3,
            price_per_unit: 12,
            note: "Dry paper.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });

    const started = Date.now();
    const result = await pickupService.cancelPickup(customer.id, before.id);
    const ended = Date.now();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(result.id).toBe(before.id);
    expect(result.collector_id).toBe(collector.id);
    expect(result.status).toBe("cancelled");
    expect(result.payout_status).toBe("cancelled");
    expect(result.cancelled_at).toBeInstanceOf(Date);
    expect(result.cancelled_at!.getTime()).toBeGreaterThanOrEqual(started);
    expect(result.cancelled_at!.getTime()).toBeLessThanOrEqual(ended);
    expect(saved).toEqual({
      ...before,
      status: "cancelled",
      payout_status: "cancelled",
      cancelled_at: result.cancelled_at,
      updated_at: result.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("allows cancellation when the customer has no wallet", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "No wallet cancellation customer",
        email: "cancel-no-wallet@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const material = await prisma.material.create({
      data: {
        name: "No wallet cancellation plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "pending",
        payout_status: "pending",
        payout: 40,
        note: "No wallet required.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Packed.",
          },
        },
      },
      include: { items: true },
    });
    expect(
      await prisma.wallet.findUnique({ where: { user_id: customer.id } }),
    ).toBeNull();

    const started = Date.now();
    const result = await pickupService.cancelPickup(customer.id, before.id);
    const ended = Date.now();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(result.id).toBe(before.id);
    expect(result.status).toBe("cancelled");
    expect(result.payout_status).toBe("cancelled");
    expect(result.cancelled_at).toBeInstanceOf(Date);
    expect(result.cancelled_at!.getTime()).toBeGreaterThanOrEqual(started);
    expect(result.cancelled_at!.getTime()).toBeLessThanOrEqual(ended);
    expect(saved).toEqual({
      ...before,
      status: "cancelled",
      payout_status: "cancelled",
      cancelled_at: result.cancelled_at,
      updated_at: result.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUnique({ where: { user_id: customer.id } }),
    ).toBeNull();
    expect(
      await prisma.walletTransaction.count({ where: { pickup_id: before.id } }),
    ).toBe(0);
  });

  it("rejects cancellation of a nonexistent pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Missing pickup customer",
        email: "cancel-missing@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000004", balance: 90 },
    });
    const missingId = 2147483647;
    expect(
      await prisma.pickup.findUnique({ where: { id: missingId } }),
    ).toBeNull();
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(customer.id, missingId);
    await expect(result).rejects.toBeInstanceOf(NotFoundError);
    await expect(result).rejects.toThrow("Pickup not found.");
    expect(
      await prisma.pickup.findUnique({ where: { id: missingId } }),
    ).toBeNull();
    expect(
      await prisma.pickupItem.count({ where: { pickup_id: missingId } }),
    ).toBe(0);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("rejects cancellation of another customer's pending pickup", async () => {
    const owner = await prisma.user.create({
      data: {
        full_name: "Pending pickup owner",
        email: "cancel-other-pending-owner@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const caller = await prisma.user.create({
      data: {
        full_name: "Pending pickup caller",
        email: "cancel-other-pending-caller@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: owner.id, phone: "01100000005", balance: 100 },
    });
    const material = await prisma.material.create({
      data: { name: "Other pending plastic", unit: "kg", current_price: 10 },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: owner.id,
        status: "pending",
        payout_status: "pending",
        payout: 40,
        note: "Owner only.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Keep items.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(caller.id, before.id);
    await expect(result).rejects.toBeInstanceOf(NotFoundError);
    await expect(result).rejects.toThrow("Pickup not found.");
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("rejects cancellation of another customer's assigned pickup", async () => {
    const owner = await prisma.user.create({
      data: {
        full_name: "Assigned pickup owner",
        email: "cancel-other-assigned-owner@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const caller = await prisma.user.create({
      data: {
        full_name: "Assigned pickup caller",
        email: "cancel-other-assigned-caller@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Other assigned collector",
        email: "cancel-other-assigned-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: owner.id, phone: "01100000006", balance: 110 },
    });
    const material = await prisma.material.create({
      data: { name: "Other assigned plastic", unit: "kg", current_price: 10 },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: owner.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 40,
        note: "Owner only.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Keep items.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(caller.id, before.id);
    await expect(result).rejects.toBeInstanceOf(NotFoundError);
    await expect(result).rejects.toThrow("Pickup not found.");
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("returns not-found before checking another customer's completed pickup status", async () => {
    const owner = await prisma.user.create({
      data: {
        full_name: "Completed pickup owner",
        email: "cancel-other-completed-owner@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const caller = await prisma.user.create({
      data: {
        full_name: "Completed pickup caller",
        email: "cancel-other-completed-caller@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Other completed collector",
        email: "cancel-other-completed-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: owner.id, phone: "01100000007", balance: 120 },
    });
    const material = await prisma.material.create({
      data: { name: "Other completed plastic", unit: "kg", current_price: 10 },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: owner.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: 40,
        completed_at: new Date("2026-01-02T10:00:00Z"),
        note: "Owner only.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Collected.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(caller.id, before.id);
    await expect(result).rejects.toBeInstanceOf(NotFoundError);
    await expect(result).rejects.toThrow("Pickup not found.");
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("rejects cancellation when the pickup is on the way", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "On the way customer",
        email: "cancel-on-the-way@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "On the way collector",
        email: "cancel-on-the-way-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000008", balance: 130 },
    });
    const material = await prisma.material.create({
      data: { name: "On the way plastic", unit: "kg", current_price: 10 },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "on_the_way",
        payout_status: "pending",
        payout: 40,
        note: "In progress.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Packed.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(customer.id, before.id);
    await expect(result).rejects.toBeInstanceOf(ConflictError);
    await expect(result).rejects.toThrow(
      "Only pending or assigned pickups can be canceled.",
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
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("rejects cancellation when the pickup has arrived", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Arrived customer",
        email: "cancel-arrived@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Arrived collector",
        email: "cancel-arrived-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000009", balance: 140 },
    });
    const material = await prisma.material.create({
      data: { name: "Arrived plastic", unit: "kg", current_price: 10 },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "arrived",
        payout_status: "pending",
        payout: 40,
        note: "At the door.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Packed.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(customer.id, before.id);
    await expect(result).rejects.toBeInstanceOf(ConflictError);
    await expect(result).rejects.toThrow(
      "Only pending or assigned pickups can be canceled.",
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
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("rejects cancellation when the pickup is completed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Completed customer",
        email: "cancel-completed@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Completed collector",
        email: "cancel-completed-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000010", balance: 150 },
    });
    const material = await prisma.material.create({
      data: {
        name: "Completed cancellation plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "completed",
        payout_status: "pending",
        payout: 40,
        completed_at: new Date("2026-01-02T11:00:00Z"),
        note: "Collected.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Collected bags.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(customer.id, before.id);
    await expect(result).rejects.toBeInstanceOf(ConflictError);
    await expect(result).rejects.toThrow(
      "Only pending or assigned pickups can be canceled.",
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
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("rejects cancellation when the pickup is already cancelled", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Cancelled customer",
        email: "cancel-already-cancelled@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000011", balance: 160 },
    });
    const material = await prisma.material.create({
      data: {
        name: "Already cancelled plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "cancelled",
        payout_status: "cancelled",
        payout: 40,
        cancelled_at: new Date("2026-01-02T12:00:00Z"),
        note: "Previously cancelled.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Kept for history.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const result = pickupService.cancelPickup(customer.id, before.id);
    await expect(result).rejects.toBeInstanceOf(ConflictError);
    await expect(result).rejects.toThrow(
      "Only pending or assigned pickups can be canceled.",
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
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("rejects a second cancellation and preserves the original cancellation timestamp", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Repeated cancellation customer",
        email: "cancel-repeat@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000012", balance: 170 },
    });
    const material = await prisma.material.create({
      data: {
        name: "Repeated cancellation plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const pickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "pending",
        payout_status: "pending",
        payout: 40,
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Packed.",
          },
        },
      },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    await pickupService.cancelPickup(customer.id, pickup.id);
    const before = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });
    expect(before.cancelled_at).toBeInstanceOf(Date);
    const result = pickupService.cancelPickup(customer.id, pickup.id);
    await expect(result).rejects.toBeInstanceOf(ConflictError);
    await expect(result).rejects.toThrow(
      "Only pending or assigned pickups can be canceled.",
    );
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: pickup.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("allows exactly one of two concurrent cancellation requests to succeed", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Concurrent cancellation customer",
        email: "cancel-concurrent@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000013", balance: 180 },
    });
    const material = await prisma.material.create({
      data: {
        name: "Concurrent cancellation plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "pending",
        payout_status: "pending",
        payout: 40,
        note: "Cancel once.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Packed.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });
    const started = Date.now();
    const results = await Promise.allSettled([
      pickupService.cancelPickup(customer.id, before.id),
      pickupService.cancelPickup(customer.id, before.id),
    ]);
    const ended = Date.now();
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const success = results.find((result) => result.status === "fulfilled");
    const failure = results.find((result) => result.status === "rejected");
    if (success?.status !== "fulfilled" || failure?.status !== "rejected") {
      throw new Error(
        "Expected one successful cancellation and one rejection.",
      );
    }
    expect(failure.reason).toBeInstanceOf(ConflictError);
    expect(failure.reason.message).toBe(
      "Only pending or assigned pickups can be canceled.",
    );
    expect(success.value.cancelled_at!.getTime()).toBeGreaterThanOrEqual(
      started,
    );
    expect(success.value.cancelled_at!.getTime()).toBeLessThanOrEqual(ended);
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      status: "cancelled",
      payout_status: "cancelled",
      cancelled_at: success.value.cancelled_at,
      updated_at: success.value.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(success.value).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });

  it("allows only one of cancellation and collector progress to succeed concurrently", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Cancellation race customer",
        email: "cancel-progress-race@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Cancellation race collector",
        email: "cancel-progress-race-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01100000014", balance: 190 },
    });
    const material = await prisma.material.create({
      data: {
        name: "Cancellation race plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const before = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout_status: "pending",
        payout: 40,
        note: "Cancellation races with collector progress.",
        items: {
          create: {
            material_id: material.id,
            quantity: 4,
            price_per_unit: 10,
            note: "Packed bags.",
          },
        },
      },
      include: { items: true },
    });
    const transactions = await prisma.walletTransaction.count({
      where: { wallet_id: wallet.id },
    });

    const started = Date.now();
    const results = await Promise.allSettled([
      pickupService.cancelPickup(customer.id, before.id),
      pickupService.updatePickupStatus(collector.id, before.id, {
        status: "on_the_way",
      }),
    ]);
    const ended = Date.now();
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
    expect(failure.reason).toBeInstanceOf(ConflictError);

    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    if (results[0].status === "fulfilled") {
      expect(saved.status).toBe("cancelled");
      expect(saved.payout_status).toBe("cancelled");
      expect(saved.cancelled_at).toBeInstanceOf(Date);
      expect(saved.cancelled_at!.getTime()).toBeGreaterThanOrEqual(started);
      expect(saved.cancelled_at!.getTime()).toBeLessThanOrEqual(ended);
      expect(failure.reason.message).toBe("Pickup has already been handled.");
    } else {
      expect(saved.status).toBe("on_the_way");
      expect(saved.cancelled_at).toBeNull();
      expect(saved.payout_status).toBe("pending");
      expect(failure.reason.message).toBe(
        "Only pending or assigned pickups can be canceled.",
      );
    }
    expect(saved).toEqual({
      ...before,
      status: success.value.status,
      payout_status: success.value.payout_status,
      cancelled_at: success.value.cancelled_at,
      updated_at: success.value.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(success.value).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(transactions);
  });
});
