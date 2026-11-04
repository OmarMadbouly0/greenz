import { Prisma, PrismaClient } from "@/../generated/prisma/client";
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
import { ConflictError, NotFoundError } from "@/shared/errors/application-error";

const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);
const prismaCliPath = requireFromTest.resolve("prisma/build/index.js");

describe("PickupService.updatePayoutStatus", () => {
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
      data: { user_id: otherCustomer.id, phone: "01100000002", balance: "700.10" },
    });

    const result = await pickupService.updatePayoutStatus(before.id, { status: "paid" });
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      payout_status: "paid",
      updated_at: result?.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
    expect(items).toEqual(before.items);
    const savedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(savedWallet).toEqual({
      ...wallet,
      balance: new Prisma.Decimal("149.25"),
      updated_at: savedWallet.updated_at,
    });
    expect(await prisma.wallet.findUniqueOrThrow({ where: { id: otherWallet.id } })).toEqual(otherWallet);
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

    const result = await pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      payout_status: "cancelled",
      updated_at: result?.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
    expect(items).toEqual(before.items);
    expect(await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } })).toEqual(wallet);
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

    const result = await pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    expect(saved).toEqual({
      ...before,
      payout_status: "cancelled",
      updated_at: result?.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(result).toEqual(savedFields);
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

    const payment = pickupService.updatePayoutStatus(deleted.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(NotFoundError);
    await expect(payment).rejects.toThrow("Pickup not found.");
    const cancellation = pickupService.updatePayoutStatus(deleted.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(NotFoundError);
    await expect(cancellation).rejects.toThrow("Pickup not found.");
    expect(await prisma.pickup.findUnique({ where: { id: deleted.id } })).toBeNull();
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(NotFoundError);
    await expect(payment).rejects.toThrow("Customer wallet not found.");
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Pickup has no payout amount.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Pickup has no payout amount.");
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Payout can only be updated for completed pickups.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Payout can only be updated for completed pickups.");
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Payout can only be updated for completed pickups.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Payout can only be updated for completed pickups.");
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Payout can only be updated for completed pickups.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Payout can only be updated for completed pickups.");
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Payout can only be updated for completed pickups.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Payout can only be updated for completed pickups.");
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Payout can only be updated for completed pickups.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Payout can only be updated for completed pickups.");
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

    const update = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(update).rejects.toBeInstanceOf(ConflictError);
    await expect(update).rejects.toThrow("Payout has already been done.");
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.findMany()).toEqual([existingTransaction]);
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

    const update = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(update).rejects.toBeInstanceOf(ConflictError);
    await expect(update).rejects.toThrow("Payout has already been done.");
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.findMany()).toEqual([existingTransaction]);
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

    const update = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(update).rejects.toBeInstanceOf(ConflictError);
    await expect(update).rejects.toThrow("Payout has already been done.");
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

    const update = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(update).rejects.toBeInstanceOf(ConflictError);
    await expect(update).rejects.toThrow("Payout has already been done.");
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

    const results = await Promise.allSettled([
      pickupService.updatePayoutStatus(before.id, { status: "paid" }),
      pickupService.updatePayoutStatus(before.id, { status: "paid" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    expect(rejected[0].reason.message).toBe("Payout has already been done.");
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    const winningStatus = "paid";
    expect(saved).toEqual({
      ...before,
      payout_status: winningStatus,
      updated_at: fulfilled[0].value?.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(fulfilled[0].value).toEqual(savedFields);
    expect(items).toEqual(before.items);
    const savedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
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

  it("allows only one of payment and payout cancellation to succeed concurrently", async () => {
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

    const results = await Promise.allSettled([
      pickupService.updatePayoutStatus(before.id, { status: "paid" }),
      pickupService.updatePayoutStatus(before.id, { status: "cancelled" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictError);
    expect(rejected[0].reason.message).toBe("Payout has already been done.");
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    const winningStatus = results[0].status === "fulfilled" ? "paid" : "cancelled";
    expect(saved).toEqual({
      ...before,
      payout_status: winningStatus,
      updated_at: fulfilled[0].value?.updated_at,
    });
    const { items, ...savedFields } = saved;
    expect(fulfilled[0].value).toEqual(savedFields);
    expect(items).toEqual(before.items);
    const savedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
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

    const results = await Promise.allSettled([
      pickupService.updatePayoutStatus(before.id, { status: "paid" }),
      pickupService.updatePayoutStatus(second.id, { status: "paid" }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const savedFirst = await prisma.pickup.findUniqueOrThrow({
      where: { id: before.id },
      include: { items: true },
    });
    const savedSecond = await prisma.pickup.findUniqueOrThrow({
      where: { id: second.id },
      include: { items: true },
    });
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
    const savedWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    expect(savedWallet.balance.toFixed(2)).toBe("159.52");
    const transactions = await prisma.walletTransaction.findMany({ orderBy: { pickup_id: "asc" } });
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    await expect(payment).rejects.toMatchObject({ code: "P2002" });
    expect(
      await prisma.pickup.findUniqueOrThrow({
        where: { id: before.id },
        include: { items: true },
      }),
    ).toEqual(before);
    expect(
      await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
    ).toEqual(wallet);
    expect(await prisma.walletTransaction.findMany()).toEqual([existingTransaction]);
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Pickup payout amount must be greater than zero.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Pickup payout amount must be greater than zero.");
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

    const payment = pickupService.updatePayoutStatus(before.id, { status: "paid" });
    await expect(payment).rejects.toBeInstanceOf(ConflictError);
    await expect(payment).rejects.toThrow("Pickup payout amount must be greater than zero.");
    const cancellation = pickupService.updatePayoutStatus(before.id, { status: "cancelled" });
    await expect(cancellation).rejects.toBeInstanceOf(ConflictError);
    await expect(cancellation).rejects.toThrow("Pickup payout amount must be greater than zero.");
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

