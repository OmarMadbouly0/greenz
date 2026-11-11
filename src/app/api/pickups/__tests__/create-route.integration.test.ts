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
import { POST as createPickupRoute } from "@/app/api/pickups/route";
import { getPrisma } from "@/infrastructure/database/prisma";
import { generateToken } from "@/modules/identity/application/jwt";

const execFileAsync = promisify(execFile);
const prismaCliPath = createRequire(import.meta.url).resolve(
  "prisma/build/index.js",
);

let container: StartedPostgreSqlContainer | undefined;
let prisma: PrismaClient;
let serviceClient: PrismaClient | undefined;
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
}, 180_000);

afterAll(async () => {
  try {
    await Promise.all([prisma?.$disconnect(), serviceClient?.$disconnect()]);
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

function postPickup(userId: number, body: unknown) {
  return createPickupRoute(
    new Request("http://localhost/api/pickups", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `token=${generateToken(userId)}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe("POST /api/pickups", () => {
  it("creates a pickup successfully for the authenticated customer", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Pickup customer",
        email: "customer@example.com",
        password_hash: "unused-for-cookie-authentication",
        role: "customer",
      },
    });
    const wallet = await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000000" },
    });
    const material = await prisma.material.create({
      data: { name: "Test Plastic", unit: "kg", current_price: 10 },
    });
    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 4 }],
    });

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data).toMatchObject({
      id: expect.any(Number),
      customer_id: customer.id,
      collector_id: null,
      status: "pending",
      payout_status: "pending",
      payout: "40",
    });

    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: data.id },
      include: { items: true },
    });
    expect(saved.customer_id).toBe(customer.id);
    expect(saved.status).toBe("pending");
    expect(saved.payout_status).toBe("pending");
    expect(saved.collector_id).toBeNull();
    expect(saved.completed_at).toBeNull();
    expect(saved.cancelled_at).toBeNull();
    expect(saved.payout?.toString()).toBe("40");
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0]).toMatchObject({
      pickup_id: saved.id,
      material_id: material.id,
    });
    expect(saved.items[0].quantity.toString()).toBe("4");
    expect(saved.items[0].price_per_unit.toString()).toBe("10");
    const savedWallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    expect(savedWallet.balance.toString()).toBe(wallet.balance.toString());
    expect(
      await prisma.walletTransaction.count({ where: { wallet_id: wallet.id } }),
    ).toBe(0);
  });

  it("rejects pickup creation when the customer has no wallet", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer without wallet",
        email: "customer-without-wallet@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    const material = await prisma.material.create({
      data: { name: "Wallet rejection plastic", unit: "kg", current_price: 10 },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 4 }],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "You must register a wallet before making a pickup.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
  });

  it("rejects pickup creation when a requested material does not exist", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer requesting missing material",
        email: "missing-material-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000002" },
    });

    const missingMaterialId = 999;
    expect(
      await prisma.material.findUnique({ where: { id: missingMaterialId } }),
    ).toBeNull();

    const response = await postPickup(customer.id, {
      items: [{ materialId: missingMaterialId, quantity: 4 }],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Some materials are not available.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
  });

  it("calculates the combined payout for multiple materials", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer requesting multiple materials",
        email: "multiple-materials-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000003" },
    });

    const plastic = await prisma.material.create({
      data: {
        name: "Multiple materials plastic",
        unit: "kg",
        current_price: 10,
      },
    });
    const paper = await prisma.material.create({
      data: { name: "Multiple materials paper", unit: "kg", current_price: 5 },
    });

    const response = await postPickup(customer.id, {
      items: [
        { materialId: plastic.id, quantity: 4 },
        { materialId: paper.id, quantity: 2 },
      ],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("50");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.payout?.toString()).toBe("50");
    expect(savedPickup.items).toHaveLength(2);

    const plasticItem = savedPickup.items.find(
      (item) => item.material_id === plastic.id,
    );
    const paperItem = savedPickup.items.find(
      (item) => item.material_id === paper.id,
    );

    expect(plasticItem?.quantity.toString()).toBe("4");
    expect(plasticItem?.price_per_unit.toString()).toBe("10");
    expect(paperItem?.quantity.toString()).toBe("2");
    expect(paperItem?.price_per_unit.toString()).toBe("5");
  });

  it("keeps the saved pickup price unchanged when the material price changes", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing saved prices",
        email: "saved-price-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000004" },
    });

    const material = await prisma.material.create({
      data: { name: "Saved price plastic", unit: "kg", current_price: 10 },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 4 }],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    await prisma.material.update({
      where: { id: material.id },
      data: { current_price: 20 },
    });

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.items).toHaveLength(1);
    expect(savedPickup.items[0].price_per_unit.toString()).toBe("10");
    expect(savedPickup.payout?.toString()).toBe("40");

    const newResponse = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 4 }],
    });

    expect(newResponse.status).toBe(201);
    const newPickup = await newResponse.json();

    expect(newPickup.payout?.toString()).toBe("80");

    const savedNewPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: newPickup.id },
      include: { items: true },
    });

    expect(savedNewPickup.items).toHaveLength(1);
    expect(savedNewPickup.items[0].price_per_unit.toString()).toBe("20");
    expect(savedNewPickup.payout?.toString()).toBe("80");
  });

  it("calculates the payout accurately with fractional quantities and decimal prices", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing decimal payouts",
        email: "decimal-payout-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000005" },
    });

    const material = await prisma.material.create({
      data: { name: "Decimal price paper", unit: "kg", current_price: "1.20" },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 1.5 }],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("1.8");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.items).toHaveLength(1);
    expect(savedPickup.items[0].quantity.toString()).toBe("1.5");
    expect(savedPickup.items[0].price_per_unit.toString()).toBe("1.2");
    expect(savedPickup.payout?.toString()).toBe("1.8");
  });

  it("rejects the entire pickup when one requested material is missing", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer requesting mixed materials",
        email: "mixed-materials-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000006" },
    });

    const material = await prisma.material.create({
      data: { name: "Mixed request plastic", unit: "kg", current_price: 10 },
    });

    const missingMaterialId = 999;
    expect(
      await prisma.material.findUnique({ where: { id: missingMaterialId } }),
    ).toBeNull();

    const response = await postPickup(customer.id, {
      items: [
        { materialId: material.id, quantity: 4 },
        { materialId: missingMaterialId, quantity: 1 },
      ],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Some materials are not available.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
    expect(
      await prisma.pickupItem.count({
        where: { pickup: { customer_id: customer.id } },
      }),
    ).toBe(0);
  });

  it("saves pickup-level and item-level notes", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing pickup notes",
        email: "pickup-notes-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000007" },
    });

    const material = await prisma.material.create({
      data: { name: "Notes test plastic", unit: "kg", current_price: 10 },
    });

    const response = await postPickup(customer.id, {
      note: "Call when you arrive.",
      items: [
        {
          materialId: material.id,
          quantity: 4,
          note: "Plastic is in the blue bags.",
        },
      ],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.note).toBe("Call when you arrive.");
    expect(savedPickup.items).toHaveLength(1);
    expect(savedPickup.items[0].note).toBe("Plastic is in the blue bags.");
  });

  it("rejects a material with a zero price", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing zero price",
        email: "zero-price-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: {
        user_id: customer.id,
        phone: "01000000008",
      },
    });

    const material = await prisma.material.create({
      data: { name: "Zero price plastic", unit: "kg", current_price: 0 },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 4 }],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Material prices must be at least 1.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
    expect(
      await prisma.pickupItem.count({
        where: { pickup: { customer_id: customer.id } },
      }),
    ).toBe(0);
  });

  it("rejects a material with a negative price", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing negative price",
        email: "negative-price-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000009" },
    });

    const material = await prisma.material.create({
      data: { name: "Negative price plastic", unit: "kg", current_price: -1 },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 4 }],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Material prices must be at least 1.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
    expect(
      await prisma.pickupItem.count({
        where: { pickup: { customer_id: customer.id } },
      }),
    ).toBe(0);
  });

  it("rejects the entire pickup when one requested material has a zero price", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing mixed prices",
        email: "mixed-prices-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000011" },
    });

    const plastic = await prisma.material.create({
      data: { name: "Mixed prices plastic", unit: "kg", current_price: 10 },
    });
    const paper = await prisma.material.create({
      data: { name: "Mixed prices paper", unit: "kg", current_price: 0 },
    });

    const response = await postPickup(customer.id, {
      items: [
        { materialId: plastic.id, quantity: 4 },
        { materialId: paper.id, quantity: 2 },
      ],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Material prices must be at least 1.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
    expect(
      await prisma.pickupItem.count({
        where: { pickup: { customer_id: customer.id } },
      }),
    ).toBe(0);
  });

  it("calculates the combined payout accurately for multiple decimal-priced materials", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing combined decimal payouts",
        email: "combined-decimal-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000010" },
    });

    const plastic = await prisma.material.create({
      data: {
        name: "Combined decimal plastic",
        unit: "kg",
        current_price: "1.10",
      },
    });
    const paper = await prisma.material.create({
      data: {
        name: "Combined decimal paper",
        unit: "kg",
        current_price: "1.20",
      },
    });

    const response = await postPickup(customer.id, {
      items: [
        { materialId: plastic.id, quantity: 3 },
        { materialId: paper.id, quantity: 1.5 },
      ],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("5.1");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.payout?.toString()).toBe("5.1");
    expect(savedPickup.items).toHaveLength(2);

    const plasticItem = savedPickup.items.find(
      (item) => item.material_id === plastic.id,
    );
    const paperItem = savedPickup.items.find(
      (item) => item.material_id === paper.id,
    );

    expect(plasticItem?.quantity.toString()).toBe("3");
    expect(plasticItem?.price_per_unit.toString()).toBe("1.1");
    expect(paperItem?.quantity.toString()).toBe("1.5");
    expect(paperItem?.price_per_unit.toString()).toBe("1.2");
  });

  it("allows the same material in separate items and includes both in the payout", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing duplicate materials",
        email: "duplicate-materials-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000012" },
    });

    const material = await prisma.material.create({
      data: {
        name: "Duplicate material plastic",
        unit: "kg",
        current_price: 10,
      },
    });

    const response = await postPickup(customer.id, {
      items: [
        { materialId: material.id, quantity: 2 },
        { materialId: material.id, quantity: 3 },
      ],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("50");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: { orderBy: { quantity: "asc" } } },
    });

    expect(savedPickup.payout?.toString()).toBe("50");
    expect(savedPickup.items).toHaveLength(2);
    expect(savedPickup.items[0].material_id).toBe(material.id);
    expect(savedPickup.items[0].quantity.toString()).toBe("2");
    expect(savedPickup.items[0].price_per_unit.toString()).toBe("10");
    expect(savedPickup.items[1].material_id).toBe(material.id);
    expect(savedPickup.items[1].quantity.toString()).toBe("3");
    expect(savedPickup.items[1].price_per_unit.toString()).toBe("10");
  });

  it("rounds a halfway payout up to two decimal places", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing payout rounding",
        email: "payout-rounding-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000013" },
    });

    const material = await prisma.material.create({
      data: {
        name: "Payout rounding plastic",
        unit: "kg",
        current_price: "10.50",
      },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 0.25 }],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("2.63");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.payout?.toString()).toBe("2.63");
    expect(savedPickup.items).toHaveLength(1);
    expect(savedPickup.items[0].material_id).toBe(material.id);
    expect(savedPickup.items[0].quantity.toString()).toBe("0.25");
    expect(savedPickup.items[0].price_per_unit.toString()).toBe("10.5");
  });

  it("rounds the payout down when the third decimal digit is below five", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing payout rounding down",
        email: "payout-rounding-down-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000014" },
    });

    const material = await prisma.material.create({
      data: {
        name: "Payout rounding down plastic",
        unit: "kg",
        current_price: "10.49",
      },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 0.25 }],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("2.62");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.payout?.toString()).toBe("2.62");
    expect(savedPickup.items).toHaveLength(1);
    expect(savedPickup.items[0].material_id).toBe(material.id);
    expect(savedPickup.items[0].quantity.toString()).toBe("0.25");
    expect(savedPickup.items[0].price_per_unit.toString()).toBe("10.49");
  });

  it("rounds the payout only after adding all item totals", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing combined payout rounding",
        email: "combined-rounding-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000015" },
    });

    const plastic = await prisma.material.create({
      data: {
        name: "Combined rounding plastic",
        unit: "kg",
        current_price: "10.50",
      },
    });
    const paper = await prisma.material.create({
      data: {
        name: "Combined rounding paper",
        unit: "kg",
        current_price: "10.50",
      },
    });

    const response = await postPickup(customer.id, {
      items: [
        { materialId: plastic.id, quantity: 0.25 },
        { materialId: paper.id, quantity: 0.25 },
      ],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("5.25");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.payout?.toString()).toBe("5.25");
    expect(savedPickup.items).toHaveLength(2);

    const plasticItem = savedPickup.items.find(
      (item) => item.material_id === plastic.id,
    );
    const paperItem = savedPickup.items.find(
      (item) => item.material_id === paper.id,
    );

    expect(plasticItem?.quantity.toString()).toBe("0.25");
    expect(plasticItem?.price_per_unit.toString()).toBe("10.5");
    expect(paperItem?.quantity.toString()).toBe("0.25");
    expect(paperItem?.price_per_unit.toString()).toBe("10.5");
  });

  it("rejects a material with a price below 1", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing price below minimum",
        email: "below-minimum-price-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000016" },
    });

    const material = await prisma.material.create({
      data: {
        name: "Below minimum price plastic",
        unit: "kg",
        current_price: "0.99",
      },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 4 }],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Material prices must be at least 1.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
    expect(
      await prisma.pickupItem.count({
        where: { pickup: { customer_id: customer.id } },
      }),
    ).toBe(0);
  });

  it("accepts the minimum material price and payout of 1", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing minimum price",
        email: "minimum-price-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000017" },
    });

    const material = await prisma.material.create({
      data: { name: "Minimum price plastic", unit: "kg", current_price: 1 },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 1 }],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("1");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.payout?.toString()).toBe("1");
    expect(savedPickup.items).toHaveLength(1);
    expect(savedPickup.items[0].material_id).toBe(material.id);
    expect(savedPickup.items[0].quantity.toString()).toBe("1");
    expect(savedPickup.items[0].price_per_unit.toString()).toBe("1");
  });

  it("rejects a pickup when the payout exceeds the maximum allowed amount", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing payout overflow",
        email: "payout-overflow-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000018" },
    });

    const material = await prisma.material.create({
      data: {
        name: "Payout overflow plastic",
        unit: "kg",
        current_price: 1000000,
      },
    });

    const response = await postPickup(customer.id, {
      items: [{ materialId: material.id, quantity: 100.01 }],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Pickup payout exceeds the maximum allowed amount.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
    expect(
      await prisma.pickupItem.count({
        where: { pickup: { customer_id: customer.id } },
      }),
    ).toBe(0);
  });

  it("accepts a pickup with the maximum allowed payout", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing maximum payout",
        email: "maximum-payout-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000019" },
    });

    const plastic = await prisma.material.create({
      data: {
        name: "Maximum payout plastic",
        unit: "kg",
        current_price: "999999.99",
      },
    });
    const paper = await prisma.material.create({
      data: { name: "Maximum payout paper", unit: "kg", current_price: 1 },
    });

    const response = await postPickup(customer.id, {
      items: [
        { materialId: plastic.id, quantity: 100 },
        { materialId: paper.id, quantity: 1 },
      ],
    });

    expect(response.status).toBe(201);
    const pickup = await response.json();

    expect(pickup.payout?.toString()).toBe("100000000");

    const savedPickup = await prisma.pickup.findUniqueOrThrow({
      where: { id: pickup.id },
      include: { items: true },
    });

    expect(savedPickup.payout?.toString()).toBe("100000000");
    expect(savedPickup.items).toHaveLength(2);

    const plasticItem = savedPickup.items.find(
      (item) => item.material_id === plastic.id,
    );
    const paperItem = savedPickup.items.find(
      (item) => item.material_id === paper.id,
    );

    expect(plasticItem?.quantity.toString()).toBe("100");
    expect(plasticItem?.price_per_unit.toString()).toBe("999999.99");
    expect(paperItem?.quantity.toString()).toBe("1");
    expect(paperItem?.price_per_unit.toString()).toBe("1");
  });

  it("rejects a pickup when combined item totals exceed the maximum payout", async () => {
    const customer = await prisma.user.create({
      data: {
        full_name: "Customer testing combined payout overflow",
        email: "combined-overflow-customer@example.com",
        password_hash: "unused-in-this-test",
        role: "customer",
      },
    });

    await prisma.wallet.create({
      data: { user_id: customer.id, phone: "01000000020" },
    });

    const plastic = await prisma.material.create({
      data: {
        name: "Combined overflow plastic",
        unit: "kg",
        current_price: "999999.99",
      },
    });
    const paper = await prisma.material.create({
      data: {
        name: "Combined overflow paper",
        unit: "kg",
        current_price: 1,
      },
    });

    const response = await postPickup(customer.id, {
      items: [
        { materialId: plastic.id, quantity: 100 },
        { materialId: paper.id, quantity: 1.01 },
      ],
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Pickup payout exceeds the maximum allowed amount.",
    });

    expect(
      await prisma.pickup.count({ where: { customer_id: customer.id } }),
    ).toBe(0);
    expect(
      await prisma.pickupItem.count({
        where: { pickup: { customer_id: customer.id } },
      }),
    ).toBe(0);
  });
});
