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
import { PATCH as payoutRoute } from "@/app/api/admin/pickups/[pickupId]/payout/route";

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

type Actor =
  "customer" | "otherCustomer" | "collector" | "otherCollector" | "admin";

type PickupState =
  "pending" | "assigned" | "on_the_way" | "arrived" | "completed" | "cancelled";

const baseUrl = "http://localhost";

const passwordHash = "unused-for-real-jwt-cookie-authentication";

let cookies: Record<Actor, string>;

let users: Record<Actor, number>;

let pickupId: number;

let materialId: number;

function makeRequest(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function contextForPath(path: string) {
  const segments = new URL(path, "http://localhost").pathname.split("/");
  return {
    params: Promise.resolve({
      pickupId: segments[segments.indexOf("pickups") + 1],
    }),
  };
}

async function snapshot() {
  return {
    pickups: await prisma.pickup.findMany({ orderBy: { id: "asc" } }),
    items: await prisma.pickupItem.findMany({ orderBy: { id: "asc" } }),
    wallets: await prisma.wallet.findMany({ orderBy: { id: "asc" } }),
    transactions: await prisma.walletTransaction.findMany({
      orderBy: { id: "asc" },
    }),
  };
}

async function seedState(status: PickupState) {
  return prisma.pickup.update({
    where: { id: pickupId },
    data: {
      status,
      collector_id: status === "pending" ? null : users.collector,
      payout_status: status === "cancelled" ? "cancelled" : "pending",
      completed_at:
        status === "completed" ? new Date("2026-01-01T10:00:00Z") : null,
      cancelled_at:
        status === "cancelled" ? new Date("2026-01-01T10:00:00Z") : null,
    },
  });
}

beforeEach(async () => {
  await prisma.walletTransaction.deleteMany();
  await prisma.withdrawalRequest.deleteMany();
  await prisma.pickupItem.deleteMany();
  await prisma.pickup.deleteMany();
  await prisma.wallet.deleteMany();
  await prisma.user.deleteMany();
  await prisma.material.deleteMany();
  users = {
    customer: 0,
    otherCustomer: 0,
    collector: 0,
    otherCollector: 0,
    admin: 0,
  };
  cookies = {
    customer: "",
    otherCustomer: "",
    collector: "",
    otherCollector: "",
    admin: "",
  };
  for (const actor of Object.keys(users) as Actor[]) {
    const role =
      actor === "otherCustomer"
        ? "customer"
        : actor === "otherCollector"
          ? "collector"
          : actor;
    const user = await prisma.user.create({
      data: {
        full_name: actor,
        email: `${actor.toLowerCase()}@example.com`,
        role,
        password_hash: passwordHash,
      },
    });
    users[actor] = user.id;
    cookies[actor] = `token=${generateToken(user.id)}`;
  }
  await prisma.wallet.create({
    data: { user_id: users.customer, phone: "01000000000", balance: 100 },
  });
  const material = await prisma.material.create({
    data: { name: "Paper", unit: "kg", current_price: 10 },
  });
  materialId = material.id;
  const pickup = await prisma.pickup.create({
    data: {
      customer_id: users.customer,
      collector_id: users.collector,
      status: "assigned",
      payout: 20,
      items: {
        create: { material_id: materialId, quantity: 2, price_per_unit: 10 },
      },
    },
  });
  pickupId = pickup.id;
}, 90_000);

describe("Pickup payouts", () => {
  it("rejects malformed JSON and invalid bodies on payout updates", async () => {
    const endpoint = {
      handler: payoutRoute,
      method: "PATCH",
      path: `/api/admin/pickups/${pickupId}/payout`,
      actor: "admin",
      invalid: [
        {},
        ...["pending", "completed", "invalid", 1, null].map((status) => ({
          status,
        })),
      ],
    } as const;
    for (const body of [null, [], ...endpoint.invalid]) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies[endpoint.actor],
          body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      const field = body === null || Array.isArray(body) ? "input" : "status";
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: { [field]: expect.any(String) },
      });
      expect(await snapshot()).toEqual(before);
    }
    for (const body of ["{", ""]) {
      const before = await snapshot();
      const response = await payoutRoute(
        new Request(`${baseUrl}${endpoint.path}`, {
          method: endpoint.method,
          headers: {
            cookie: cookies[endpoint.actor],
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(60_000),
        }),
        contextForPath(endpoint.path),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Request body must be valid JSON.",
      });
      expect(await snapshot()).toEqual(before);
    }
  }, 30_000);

  it("rejects payment and payout cancellation for a pending pickup", async () => {
    {
      // Payment
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("pending");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "paid",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // Payout cancellation
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("pending");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "cancelled",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects payment and payout cancellation for an assigned pickup", async () => {
    {
      // Payment
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("assigned");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "paid",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // Payout cancellation
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("assigned");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "cancelled",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects payment and payout cancellation for an on_the_way pickup", async () => {
    {
      // Payment
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("on_the_way");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "paid",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // Payout cancellation
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("on_the_way");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "cancelled",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects payment and payout cancellation for an arrived pickup", async () => {
    {
      // Payment
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("arrived");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "paid",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // Payout cancellation
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("arrived");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "cancelled",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("allows payment or cancellation for a completed pickup and rejects repeat payout actions", async () => {
    {
      // Payment
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("completed");
      const path = `/api/admin/pickups/${pickupId}/payout`;
      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "paid",
        }),
        contextForPath(path),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: pickupId,
        status: "completed",
        payout_status: "paid",
      });
      const after = await snapshot();
      expect(after.pickups).toEqual([
        {
          ...before.pickups[0],
          payout_status: "paid",
          updated_at: expect.any(Date),
        },
      ]);
      expect(after.items).toEqual(before.items);
      expect(after.wallets[0].balance.toString()).toBe("120");
      expect(after.transactions).toHaveLength(1);
      expect(after.transactions[0]).toMatchObject({
        wallet_id: before.wallets[0].id,
        pickup_id: pickupId,
        type: "payout",
      });
      expect(after.transactions[0].amount.toString()).toBe("20");
      {
        const before = await snapshot();
        const response = await payoutRoute(
          makeRequest("PATCH", path, cookies.admin, {
            status: "paid",
          }),
          contextForPath(path),
        );
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
      {
        const before = await snapshot();
        const response = await payoutRoute(
          makeRequest("PATCH", path, cookies.admin, {
            status: "cancelled",
          }),
          contextForPath(path),
        );
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
    }

    {
      // Payout cancellation
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("completed");
      const path = `/api/admin/pickups/${pickupId}/payout`;
      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "cancelled",
        }),
        contextForPath(path),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: pickupId,
        status: "completed",
        payout_status: "cancelled",
      });
      const after = await snapshot();
      expect(after.pickups).toEqual([
        {
          ...before.pickups[0],
          payout_status: "cancelled",
          updated_at: expect.any(Date),
        },
      ]);
      expect(after.items).toEqual(before.items);
      expect(after.wallets).toEqual(before.wallets);
      expect(after.transactions).toEqual(before.transactions);
      {
        const before = await snapshot();
        const response = await payoutRoute(
          makeRequest("PATCH", path, cookies.admin, {
            status: "paid",
          }),
          contextForPath(path),
        );
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
      {
        const before = await snapshot();
        const response = await payoutRoute(
          makeRequest("PATCH", path, cookies.admin, {
            status: "cancelled",
          }),
          contextForPath(path),
        );
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
    }
  });

  it("rejects payment and payout cancellation for a cancelled pickup", async () => {
    {
      // Payment
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("cancelled");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "paid",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // Payout cancellation
      await prisma.walletTransaction.deleteMany();
      await prisma.wallet.update({
        where: { user_id: users.customer },
        data: { balance: 100 },
      });
      await seedState("cancelled");
      const path = `/api/admin/pickups/${pickupId}/payout`;

      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "cancelled",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects missing-wallet payment but allows payout cancellation without a wallet", async () => {
    await seedState("completed");
    await prisma.wallet.deleteMany();
    const path = `/api/admin/pickups/${pickupId}/payout`;
    {
      const before = await snapshot();
      const response = await payoutRoute(
        makeRequest("PATCH", path, cookies.admin, {
          status: "paid",
        }),
        contextForPath(path),
      );
      expect(response.status, `PATCH ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    const before = await snapshot();
    const response = await payoutRoute(
      makeRequest("PATCH", path, cookies.admin, {
        status: "cancelled",
      }),
      contextForPath(path),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payout_status: "cancelled" });
    expect(await snapshot()).toEqual({
      ...before,
      pickups: [
        {
          ...before.pickups[0],
          payout_status: "cancelled",
          updated_at: expect.any(Date),
        },
      ],
    });
  });

  it("rejects invalid saved payout amounts without partial financial writes", async () => {
    await seedState("completed");
    for (const payout of [null, "0", "-1", "0.99", "100000000.01"]) {
      await prisma.pickup.update({ where: { id: pickupId }, data: { payout } });
      for (const status of ["paid", "cancelled"]) {
        const before = await snapshot();
        const response = await payoutRoute(
          makeRequest(
            "PATCH",
            `/api/admin/pickups/${pickupId}/payout`,
            cookies.admin,
            { status },
          ),
          contextForPath(`/api/admin/pickups/${pickupId}/payout`),
        );
        expect(
          response.status,
          `PATCH ${`/api/admin/pickups/${pickupId}/payout`}`,
        ).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
    }
  });
});
