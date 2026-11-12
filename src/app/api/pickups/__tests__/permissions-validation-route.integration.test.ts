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
import * as pickups from "@/app/api/pickups/route";
import * as pickup from "@/app/api/pickups/[pickupId]/route";
import { GET as listAdminPickups } from "@/app/api/admin/pickups/route";
import { PATCH as assign } from "@/app/api/admin/pickups/[pickupId]/assign/route";
import { PATCH as unassign } from "@/app/api/admin/pickups/[pickupId]/unassign/route";
import { PATCH as payoutRoute } from "@/app/api/admin/pickups/[pickupId]/payout/route";
import jwt from "jsonwebtoken";

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

const secret = "pickup-route-disposable-test-secret";

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

function idEndpoints(id: string | number) {
  return [
    {
      handler: pickup.GET,
      method: "GET",
      path: `/api/pickups/${id}`,
      actor: "customer",
    },
    {
      handler: pickup.GET,
      method: "GET",
      path: `/api/pickups/${id}`,
      actor: "collector",
    },
    {
      handler: pickup.GET,
      method: "GET",
      path: `/api/pickups/${id}`,
      actor: "admin",
    },
    {
      handler: pickup.DELETE,
      method: "DELETE",
      path: `/api/pickups/${id}`,
      actor: "customer",
    },
    {
      handler: pickup.PATCH,
      method: "PATCH",
      path: `/api/pickups/${id}`,
      actor: "collector",
      body: { status: "on_the_way" },
    },
    {
      handler: assign,
      method: "PATCH",
      path: `/api/admin/pickups/${id}/assign`,
      actor: "admin",
      body: { collectorId: users.collector },
    },
    {
      handler: unassign,
      method: "PATCH",
      path: `/api/admin/pickups/${id}/unassign`,
      actor: "admin",
    },
    {
      handler: payoutRoute,
      method: "PATCH",
      path: `/api/admin/pickups/${id}/payout`,
      actor: "admin",
      body: { status: "paid" },
    },
  ] as const;
}

function endpoints() {
  return [
    {
      handler: pickups.GET,
      method: "GET",
      path: "/api/pickups",
      allowed: ["customer", "collector"],
    },
    {
      handler: pickups.POST,
      method: "POST",
      path: "/api/pickups",
      allowed: ["customer"],
      body: { items: [{ materialId, quantity: 2 }] },
    },
    {
      handler: pickup.GET,
      method: "GET",
      path: `/api/pickups/${pickupId}`,
      allowed: ["customer", "collector", "admin"],
    },
    {
      handler: pickup.DELETE,
      method: "DELETE",
      path: `/api/pickups/${pickupId}`,
      allowed: ["customer"],
    },
    {
      handler: pickup.PATCH,
      method: "PATCH",
      path: `/api/pickups/${pickupId}`,
      allowed: ["collector"],
      body: { status: "on_the_way" },
    },
    {
      handler: listAdminPickups,
      method: "GET",
      path: "/api/admin/pickups",
      allowed: ["admin"],
    },
    {
      handler: assign,
      method: "PATCH",
      path: `/api/admin/pickups/${pickupId}/assign`,
      allowed: ["admin"],
      body: { collectorId: users.collector },
    },
    {
      handler: unassign,
      method: "PATCH",
      path: `/api/admin/pickups/${pickupId}/unassign`,
      allowed: ["admin"],
    },
    {
      handler: payoutRoute,
      method: "PATCH",
      path: `/api/admin/pickups/${pickupId}/payout`,
      allowed: ["admin"],
      body: { status: "paid" },
    },
  ];
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

describe("Pickup permissions and IDs", () => {
  it("rejects missing authentication on every pickup endpoint without writes", async () => {
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(endpoint.method, endpoint.path, undefined, endpoint.body),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects malformed authentication on every pickup endpoint without writes", async () => {
    const token = "invalid-token";
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          `token=${token}`,
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects expired authentication on every pickup endpoint without writes", async () => {
    const token = jwt.sign({ userId: users.admin }, secret, { expiresIn: -60 });
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          `token=${token}`,
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects tokens signed with the wrong secret on every pickup endpoint without writes", async () => {
    const token = jwt.sign({ userId: users.admin }, "wrong-secret", {
      expiresIn: 3600,
    });
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          `token=${token}`,
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects deleted-user authentication on every pickup endpoint without writes", async () => {
    const deleted = await prisma.user.create({
      data: {
        full_name: "Deleted",
        email: "deleted@example.com",
        password_hash: passwordHash,
      },
    });
    await prisma.user.delete({ where: { id: deleted.id } });
    const token = jwt.sign({ userId: deleted.id }, secret, { expiresIn: 3600 });
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          `token=${token}`,
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects forbidden customer operations", async () => {
    for (const endpoint of endpoints().filter(
      (entry) => !entry.allowed.includes("customer"),
    )) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies["customer"],
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects forbidden collector operations", async () => {
    for (const endpoint of endpoints().filter(
      (entry) => !entry.allowed.includes("collector"),
    )) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies["collector"],
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects forbidden admin operations", async () => {
    for (const endpoint of endpoints().filter(
      (entry) => !entry.allowed.includes("admin"),
    )) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies["admin"],
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("prevents another customer or collector from reading or changing the pickup", async () => {
    for (const actor of ["otherCustomer", "otherCollector"] as const) {
      const before = await snapshot();
      const response = await pickup.GET(
        makeRequest("GET", `/api/pickups/${pickupId}`, cookies[actor]),
        contextForPath(`/api/pickups/${pickupId}`),
      );
      expect(response.status, `GET ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await pickup.DELETE(
        makeRequest(
          "DELETE",
          `/api/pickups/${pickupId}`,
          cookies.otherCustomer,
        ),
        contextForPath(`/api/pickups/${pickupId}`),
      );
      expect(response.status, `DELETE ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await pickup.PATCH(
        makeRequest(
          "PATCH",
          `/api/pickups/${pickupId}`,
          cookies.otherCollector,
          { status: "on_the_way" },
        ),
        contextForPath(`/api/pickups/${pickupId}`),
      );
      expect(response.status, `PATCH ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    for (const actor of ["otherCustomer", "otherCollector"] as const) {
      const response = await pickups.GET(
        makeRequest("GET", "/api/pickups", cookies[actor]),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
        totalPages: 0,
      });
    }
  });

  it("uses the current database role even when an old admin cookie remains valid", async () => {
    await prisma.user.update({
      where: { id: users.admin },
      data: { role: "customer" },
    });
    for (const endpoint of endpoints().filter((entry) =>
      entry.path.startsWith("/api/admin/"),
    )) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies.admin,
          endpoint.body,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects zero path IDs on every ID route without writes", async () => {
    for (const endpoint of idEndpoints("0")) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies[endpoint.actor],
          "body" in endpoint ? endpoint.body : undefined,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects negative path IDs on every ID route without writes", async () => {
    for (const endpoint of idEndpoints("-1")) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies[endpoint.actor],
          "body" in endpoint ? endpoint.body : undefined,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects fractional path IDs on every ID route without writes", async () => {
    for (const endpoint of idEndpoints("1.5")) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies[endpoint.actor],
          "body" in endpoint ? endpoint.body : undefined,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects nonnumeric path IDs on every ID route without writes", async () => {
    for (const endpoint of idEndpoints("abc")) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies[endpoint.actor],
          "body" in endpoint ? endpoint.body : undefined,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects oversized path IDs on every ID route without writes", async () => {
    for (const endpoint of idEndpoints("2147483648")) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies[endpoint.actor],
          "body" in endpoint ? endpoint.body : undefined,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("returns 404 for a deleted pickup on every ID route without writes", async () => {
    await prisma.pickup.delete({ where: { id: pickupId } });
    for (const endpoint of idEndpoints(pickupId)) {
      const before = await snapshot();
      const response = await endpoint.handler(
        makeRequest(
          endpoint.method,
          endpoint.path,
          cookies[endpoint.actor],
          "body" in endpoint ? endpoint.body : undefined,
        ),
        contextForPath(endpoint.path),
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects material and collector IDs above the database maximum without writes", async () => {
    await seedState("pending");
    {
      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, {
          items: [
            { materialId, quantity: 1 },
            { materialId: 2147483648, quantity: 1 },
          ],
        }),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: {
          "items.1.materialId": "Material must not exceed 2147483647.",
        },
      });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await assign(
        makeRequest(
          "PATCH",
          `/api/admin/pickups/${pickupId}/assign`,
          cookies.admin,
          { collectorId: 2147483648 },
        ),
        contextForPath(`/api/admin/pickups/${pickupId}/assign`),
      );
      expect(
        response.status,
        `PATCH ${`/api/admin/pickups/${pickupId}/assign`}`,
      ).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: { collectorId: "Collector must not exceed 2147483647." },
      });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects material and collector IDs at the JavaScript safe integer maximum without writes", async () => {
    await seedState("pending");
    {
      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, {
          items: [
            { materialId, quantity: 1 },
            { materialId: Number.MAX_SAFE_INTEGER, quantity: 1 },
          ],
        }),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: {
          "items.1.materialId": "Material must not exceed 2147483647.",
        },
      });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await assign(
        makeRequest(
          "PATCH",
          `/api/admin/pickups/${pickupId}/assign`,
          cookies.admin,
          { collectorId: Number.MAX_SAFE_INTEGER },
        ),
        contextForPath(`/api/admin/pickups/${pickupId}/assign`),
      );
      expect(
        response.status,
        `PATCH ${`/api/admin/pickups/${pickupId}/assign`}`,
      ).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: { collectorId: "Collector must not exceed 2147483647." },
      });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects material and collector IDs beyond the JavaScript safe integer range without writes", async () => {
    await seedState("pending");
    {
      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, {
          items: [
            { materialId, quantity: 1 },
            { materialId: Number.MAX_SAFE_INTEGER + 1, quantity: 1 },
          ],
        }),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: { "items.1.materialId": "Material must be an integer." },
      });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await assign(
        makeRequest(
          "PATCH",
          `/api/admin/pickups/${pickupId}/assign`,
          cookies.admin,
          { collectorId: Number.MAX_SAFE_INTEGER + 1 },
        ),
        contextForPath(`/api/admin/pickups/${pickupId}/assign`),
      );
      expect(
        response.status,
        `PATCH ${`/api/admin/pickups/${pickupId}/assign`}`,
      ).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: { collectorId: "Collector must be an integer." },
      });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("accepts the maximum database ID for real materials and collectors", async () => {
    const maxId = 2147483647;
    await prisma.material.create({
      data: {
        id: maxId,
        name: "Maximum ID material",
        unit: "kg",
        current_price: 10,
      },
    });
    await prisma.user.create({
      data: {
        id: maxId,
        full_name: "Maximum ID collector",
        role: "collector",
        email: "maximum-id-collector@example.com",
        password_hash: passwordHash,
      },
    });
    const before = await snapshot();
    const response = await pickups.POST(
      makeRequest("POST", "/api/pickups", cookies.customer, {
        items: [{ materialId: maxId, quantity: 1 }],
      }),
    );
    expect(response.status).toBe(201);
    const body: { id: number } = await response.json();
    const saved = await prisma.pickup.findUniqueOrThrow({
      where: { id: body.id },
      include: { items: true },
    });
    expect(saved.items).toHaveLength(1);
    expect(saved.items[0].material_id).toBe(maxId);
    expect(saved.payout?.toString()).toBe("10");

    await seedState("pending");
    const assigned = await assign(
      makeRequest(
        "PATCH",
        `/api/admin/pickups/${pickupId}/assign`,
        cookies.admin,
        { collectorId: maxId },
      ),
      contextForPath(`/api/admin/pickups/${pickupId}/assign`),
    );
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({
      id: pickupId,
      collector_id: maxId,
      status: "assigned",
    });
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
    ).toMatchObject({ collector_id: maxId, status: "assigned" });
    const after = await snapshot();
    expect(after.wallets).toEqual(before.wallets);
    expect(after.transactions).toEqual(before.transactions);
  });
});
