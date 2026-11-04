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
import { NotFoundError } from "@/shared/errors/application-error";

const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);
const prismaCliPath = requireFromTest.resolve("prisma/build/index.js");

describe("PickupService read methods", () => {
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

  it("returns not-found for a deleted pickup for customers, collectors, and admins", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer reading a deleted pickup",
        email: "deleted-pickup-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Collector reading a deleted pickup",
        email: "deleted-pickup-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const admin = await prisma.user.create({
      data: {
        full_name: "Admin reading a deleted pickup",
        email: "deleted-pickup-admin@example.com",
        password_hash: "unused",
        role: "admin",
      },
    });
    const pickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 20,
      },
    });
    await prisma.pickup.delete({ where: { id: pickup.id } });

    const customerRead = pickupService.getPickupById(
      customer.id,
      "customer",
      pickup.id,
    );
    await expect(customerRead).rejects.toBeInstanceOf(NotFoundError);
    await expect(customerRead).rejects.toThrow("Pickup not found.");

    const collectorRead = pickupService.getPickupById(
      collector.id,
      "collector",
      pickup.id,
    );
    await expect(collectorRead).rejects.toBeInstanceOf(NotFoundError);
    await expect(collectorRead).rejects.toThrow("Pickup not found.");

    const adminRead = pickupService.getPickupById(admin.id, "admin", pickup.id);
    await expect(adminRead).rejects.toBeInstanceOf(NotFoundError);
    await expect(adminRead).rejects.toThrow("Pickup not found.");
  });

  it("prevents a customer from reading another customer's pickup", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Pickup owner",
        email: "pickup-owner@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const otherCustomer = await prisma.user.create({
      data: {
        full_name: "Customer without access",
        email: "pickup-other-reader@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: 25 },
    });
    const pickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 23.75,
        note: "Owner's pickup details.",
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
    const result = await pickupService.getPickupById(
      customer.id,
      "customer",
      pickup.id,
    );

    expect(result).toEqual(pickup);
    const otherCustomerRead = pickupService.getPickupById(
      otherCustomer.id,
      "customer",
      pickup.id,
    );
    await expect(otherCustomerRead).rejects.toBeInstanceOf(NotFoundError);
    await expect(otherCustomerRead).rejects.toThrow("Pickup not found.");
  });

  it("returns the requested pickup when the customer owns multiple pickups", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer with multiple pickup details",
        email: "multiple-pickup-reader@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: 25 },
    });
    const firstPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 23.75,
        note: "Customer's first pickup details.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Paper from the first pickup.",
          },
        },
      },
      include: { items: true },
    });
    const secondPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 45,
        note: "Customer's second pickup details.",
        items: {
          create: {
            material_id: material.id,
            quantity: 3,
            price_per_unit: 15,
            note: "Paper from the second pickup.",
          },
        },
      },
      include: { items: true },
    });

    const firstResult = await pickupService.getPickupById(
      customer.id,
      "customer",
      firstPickup.id,
    );
    const secondResult = await pickupService.getPickupById(
      customer.id,
      "customer",
      secondPickup.id,
    );

    expect(firstResult).toEqual(firstPickup);
    expect(secondResult).toEqual(secondPickup);
  });

  it("prevents a collector from reading a pickup assigned to another collector", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer with a private assigned pickup",
        email: "assigned-pickup-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Assigned pickup collector",
        email: "assigned-pickup-reader@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Collector without access",
        email: "other-pickup-reader@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: 25 },
    });
    const pickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 23.75,
        note: "Assigned collector's pickup details.",
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

    const result = await pickupService.getPickupById(
      collector.id,
      "collector",
      pickup.id,
    );

    expect(result).toEqual(pickup);
    const otherCollectorRead = pickupService.getPickupById(
      otherCollector.id,
      "collector",
      pickup.id,
    );
    await expect(otherCollectorRead).rejects.toBeInstanceOf(NotFoundError);
    await expect(otherCollectorRead).rejects.toThrow("Pickup not found.");
  });

  it("returns the requested pickup when the collector has multiple assigned pickups", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer with multiple assigned pickups",
        email: "multiple-assigned-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Collector reading multiple pickup details",
        email: "multiple-assigned-reader@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const material = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: 25 },
    });
    const firstPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 23.75,
        note: "Collector's first pickup details.",
        items: {
          create: {
            material_id: material.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Paper from the first pickup.",
          },
        },
      },
      include: { items: true },
    });
    const secondPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 45,
        note: "Collector's second pickup details.",
        items: {
          create: {
            material_id: material.id,
            quantity: 3,
            price_per_unit: 15,
            note: "Paper from the second pickup.",
          },
        },
      },
      include: { items: true },
    });

    const firstResult = await pickupService.getPickupById(
      collector.id,
      "collector",
      firstPickup.id,
    );
    const secondResult = await pickupService.getPickupById(
      collector.id,
      "collector",
      secondPickup.id,
    );

    expect(firstResult).toEqual(firstPickup);
    expect(secondResult).toEqual(secondPickup);
  });

  it("returns the requested pickup with its customer, collector, and item details for an admin", async () => {
    const admin = await prisma.user.create({
      data: {
        full_name: "Admin reading pickup details",
        email: "pickup-detail-admin@example.com",
        password_hash: "unused",
        role: "admin",
      },
    });
    const customer = await prisma.user.create({
      data: {
        full_name: "Requested pickup customer",
        email: "requested-pickup-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const otherCustomer = await prisma.user.create({
      data: {
        full_name: "Other pickup customer",
        email: "other-admin-pickup-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Requested pickup collector",
        email: "requested-pickup-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Other pickup collector",
        email: "other-admin-pickup-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const paper = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: 25 },
    });
    const plastic = await prisma.material.create({
      data: { name: "Plastic bottles", unit: "piece", current_price: 8 },
    });
    const pickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 37.25,
        note: "Requested pickup details.",
        created_at: new Date("2026-01-01T10:00:00Z"),
        items: {
          create: {
            material_id: paper.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });
    const plasticItem = await prisma.pickupItem.create({
      data: {
        pickup_id: pickup.id,
        material_id: plastic.id,
        quantity: 3,
        price_per_unit: 4.5,
        note: "Bottles from the requested pickup.",
      },
    });
    await prisma.pickup.create({
      data: {
        customer_id: otherCustomer.id,
        collector_id: otherCollector.id,
        status: "assigned",
        payout: 13.5,
        note: "Other pickup details.",
        created_at: new Date("2026-01-02T10:00:00Z"),
        items: {
          create: {
            material_id: plastic.id,
            quantity: 3,
            price_per_unit: 4.5,
            note: "Empty bottles only.",
          },
        },
      },
    });

    const result = await pickupService.getPickupById(admin.id, "admin", pickup.id);

    expect(result).toEqual({
      id: pickup.id,
      customer_id: customer.id,
      collector_id: collector.id,
      status: pickup.status,
      note: pickup.note,
      payout: pickup.payout,
      payout_status: pickup.payout_status,
      requested_at: pickup.requested_at,
      completed_at: pickup.completed_at,
      cancelled_at: pickup.cancelled_at,
      created_at: pickup.created_at,
      updated_at: pickup.updated_at,
      customer: {
        id: customer.id,
        full_name: customer.full_name,
        email: customer.email,
      },
      collector: {
        id: collector.id,
        full_name: collector.full_name,
        email: collector.email,
      },
      items: expect.arrayContaining([
        {
          id: pickup.items[0].id,
          quantity: pickup.items[0].quantity,
          price_per_unit: pickup.items[0].price_per_unit,
          note: "Dry paper only.",
          material: { id: paper.id, name: "Paper", unit: "kg" },
        },
        {
          id: plasticItem.id,
          quantity: plasticItem.quantity,
          price_per_unit: plasticItem.price_per_unit,
          note: "Bottles from the requested pickup.",
          material: { id: plastic.id, name: "Plastic bottles", unit: "piece" },
        },
      ]),
    });
    expect(result.items).toHaveLength(2);
  });

  it("returns only the customer's own pickups", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer reading own pickups",
        email: "get-own-pickups@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const otherCustomer = await prisma.user.create({
      data: {
        full_name: "Other pickup customer",
        email: "get-other-pickups@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const olderPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 20,
        note: "Older own pickup.",
        created_at: new Date("2026-01-01T10:00:00Z"),
      },
    });
    const otherPickup = await prisma.pickup.create({
      data: {
        customer_id: otherCustomer.id,
        payout: 30,
        note: "Another customer's pickup.",
        created_at: new Date("2026-01-02T10:00:00Z"),
      },
    });
    const newerPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 40,
        note: "Newer own pickup.",
        created_at: new Date("2026-01-03T10:00:00Z"),
      },
    });

    const result = await pickupService.getPickups(customer.id, "customer");

    expect(result).toHaveLength(2);
    expect(result).toEqual([newerPickup, olderPickup]);
    expect(result.map((pickup) => pickup.id)).not.toContain(otherPickup.id);
  });

  it("returns only pickups assigned to the collector", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer with assigned pickups",
        email: "get-assigned-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Collector reading assigned pickups",
        email: "get-assigned-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Other pickup collector",
        email: "get-other-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const olderPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 20,
        created_at: new Date("2026-01-01T10:00:00Z"),
      },
    });
    const otherPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: otherCollector.id,
        status: "assigned",
        payout: 30,
        created_at: new Date("2026-01-02T10:00:00Z"),
      },
    });
    const newerPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        payout: 40,
        created_at: new Date("2026-01-03T10:00:00Z"),
      },
    });
    const unassignedPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 50,
        created_at: new Date("2026-01-04T10:00:00Z"),
      },
    });

    const result = await pickupService.getPickups(collector.id, "collector");

    expect(result).toHaveLength(2);
    expect(result).toEqual([newerPickup, olderPickup]);
    expect(result.map((pickup) => pickup.id)).not.toContain(otherPickup.id);
    expect(result.map((pickup) => pickup.id)).not.toContain(unassignedPickup.id);
  });

  it("returns the second page of all pickups with the total count and page count", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer with paginated pickups",
        email: "get-paginated-pickups@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const oldestPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 20,
        note: "Oldest pickup on the second page.",
        created_at: new Date("2026-01-01T10:00:00Z"),
      },
    });
    await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 30,
        created_at: new Date("2026-01-02T10:00:00Z"),
      },
    });
    await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 40,
        created_at: new Date("2026-01-03T10:00:00Z"),
      },
    });

    const result = await pickupService.getAllPickups({ page: 2, pageSize: 2 });

    expect(result).toEqual({
      items: [{
        id: oldestPickup.id,
        status: oldestPickup.status,
        note: oldestPickup.note,
        payout: oldestPickup.payout,
        payout_status: oldestPickup.payout_status,
        requested_at: oldestPickup.requested_at,
        completed_at: oldestPickup.completed_at,
        cancelled_at: oldestPickup.cancelled_at,
        created_at: oldestPickup.created_at,
        updated_at: oldestPickup.updated_at,
        customer: {
          id: customer.id,
          full_name: customer.full_name,
          email: customer.email,
        },
        collector: null,
        items: [],
      }],
      page: 2,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it("returns the correct customer, collector, and material details with saved item prices", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Paper pickup customer",
        email: "paper-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const otherCustomer = await prisma.user.create({
      data: {
        full_name: "Plastic pickup customer",
        email: "plastic-customer@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const collector = await prisma.user.create({
      data: {
        full_name: "Paper pickup collector",
        email: "paper-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const otherCollector = await prisma.user.create({
      data: {
        full_name: "Plastic pickup collector",
        email: "plastic-collector@example.com",
        password_hash: "unused",
        role: "collector",
      },
    });
    const paper = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: 25 },
    });
    const plastic = await prisma.material.create({
      data: { name: "Plastic bottles", unit: "piece", current_price: 8 },
    });
    const paperPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        collector_id: collector.id,
        status: "assigned",
        note: "Collect paper from reception.",
        payout: 23.75,
        created_at: new Date("2026-01-01T10:00:00Z"),
        items: {
          create: {
            material_id: paper.id,
            quantity: 2.5,
            price_per_unit: 9.5,
            note: "Dry paper only.",
          },
        },
      },
      include: { items: true },
    });
    const plasticPickup = await prisma.pickup.create({
      data: {
        customer_id: otherCustomer.id,
        collector_id: otherCollector.id,
        status: "assigned",
        note: "Collect bottles from the entrance.",
        payout: 13.5,
        created_at: new Date("2026-01-02T10:00:00Z"),
        items: {
          create: {
            material_id: plastic.id,
            quantity: 3,
            price_per_unit: 4.5,
            note: "Empty bottles only.",
          },
        },
      },
      include: { items: true },
    });

    const result = await pickupService.getAllPickups({ page: 1, pageSize: 20 });

    expect(result.items).toEqual([
      {
        id: plasticPickup.id,
        status: plasticPickup.status,
        note: plasticPickup.note,
        payout: plasticPickup.payout,
        payout_status: plasticPickup.payout_status,
        requested_at: plasticPickup.requested_at,
        completed_at: plasticPickup.completed_at,
        cancelled_at: plasticPickup.cancelled_at,
        created_at: plasticPickup.created_at,
        updated_at: plasticPickup.updated_at,
        customer: {
          id: otherCustomer.id,
          full_name: otherCustomer.full_name,
          email: otherCustomer.email,
        },
        collector: {
          id: otherCollector.id,
          full_name: otherCollector.full_name,
          email: otherCollector.email,
        },
        items: [
          {
            id: plasticPickup.items[0].id,
            quantity: plasticPickup.items[0].quantity,
            price_per_unit: plasticPickup.items[0].price_per_unit,
            note: "Empty bottles only.",
            material: { id: plastic.id, name: "Plastic bottles", unit: "piece" },
          },
        ],
      },
      {
        id: paperPickup.id,
        status: paperPickup.status,
        note: paperPickup.note,
        payout: paperPickup.payout,
        payout_status: paperPickup.payout_status,
        requested_at: paperPickup.requested_at,
        completed_at: paperPickup.completed_at,
        cancelled_at: paperPickup.cancelled_at,
        created_at: paperPickup.created_at,
        updated_at: paperPickup.updated_at,
        customer: {
          id: customer.id,
          full_name: customer.full_name,
          email: customer.email,
        },
        collector: {
          id: collector.id,
          full_name: collector.full_name,
          email: collector.email,
        },
        items: [
          {
            id: paperPickup.items[0].id,
            quantity: paperPickup.items[0].quantity,
            price_per_unit: paperPickup.items[0].price_per_unit,
            note: "Dry paper only.",
            material: { id: paper.id, name: "Paper", unit: "kg" },
          },
        ],
      },
    ]);
  });

  it("returns all items for a pickup with multiple materials", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer with multiple pickup materials",
        email: "multiple-materials-reader@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    const paper = await prisma.material.create({
      data: { name: "Paper", unit: "kg", current_price: 25 },
    });
    const plastic = await prisma.material.create({
      data: { name: "Plastic bottles", unit: "piece", current_price: 8 },
    });
    const pickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        payout: 37.25,
        note: "Paper and bottles for collection.",
      },
    });
    const paperItem = await prisma.pickupItem.create({
      data: {
        pickup_id: pickup.id,
        material_id: paper.id,
        quantity: 2.5,
        price_per_unit: 9.5,
        note: "Dry paper only.",
      },
    });
    const plasticItem = await prisma.pickupItem.create({
      data: {
        pickup_id: pickup.id,
        material_id: plastic.id,
        quantity: 3,
        price_per_unit: 4.5,
        note: "Empty bottles only.",
      },
    });

    const result = await pickupService.getAllPickups({ page: 1, pageSize: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(pickup.id);
    expect(result.items[0].items).toHaveLength(2);
    expect(result.items[0].items).toEqual(expect.arrayContaining([
      {
        id: paperItem.id,
        quantity: paperItem.quantity,
        price_per_unit: paperItem.price_per_unit,
        note: "Dry paper only.",
        material: { id: paper.id, name: "Paper", unit: "kg" },
      },
      {
        id: plasticItem.id,
        quantity: plasticItem.quantity,
        price_per_unit: plasticItem.price_per_unit,
        note: "Empty bottles only.",
        material: { id: plastic.id, name: "Plastic bottles", unit: "piece" },
      },
    ]));
  });

  it("returns only pickups matching the status and counts only matching pickups", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer with pickups in different statuses",
        email: "get-filtered-pickups@example.com",
        password_hash: "unused",
        role: "customer",
      },
    });
    await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "pending",
        payout: 20,
        created_at: new Date("2026-01-01T10:00:00Z"),
      },
    });
    const newerPendingPickup = await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "pending",
        payout: 30,
        note: "Newest pending pickup.",
        created_at: new Date("2026-01-02T10:00:00Z"),
      },
    });
    await prisma.pickup.create({
      data: {
        customer_id: customer.id,
        status: "completed",
        payout: 40,
        completed_at: new Date("2026-01-04T10:00:00Z"),
        created_at: new Date("2026-01-03T10:00:00Z"),
      },
    });

    const result = await pickupService.getAllPickups({
      page: 1,
      pageSize: 1,
      status: "pending",
    });

    expect(result).toEqual({
      items: [
        {
          id: newerPendingPickup.id,
          status: newerPendingPickup.status,
          note: newerPendingPickup.note,
          payout: newerPendingPickup.payout,
          payout_status: newerPendingPickup.payout_status,
          requested_at: newerPendingPickup.requested_at,
          completed_at: newerPendingPickup.completed_at,
          cancelled_at: newerPendingPickup.cancelled_at,
          created_at: newerPendingPickup.created_at,
          updated_at: newerPendingPickup.updated_at,
          customer: {
            id: customer.id,
            full_name: customer.full_name,
            email: customer.email,
          },
          collector: null,
          items: [],
        },
      ],
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
    });
  });
});
