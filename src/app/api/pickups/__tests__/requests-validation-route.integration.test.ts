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

describe("Pickup creation, reads, and lifecycle", () => {
  it("rejects malformed JSON and invalid bodies on pickup creation", async () => {
    const endpoint = {
      handler: pickups.POST,
      method: "POST",
      path: "/api/pickups",
      actor: "customer",
      invalid: [
        {},
        { items: [] },
        { items: {} },
        { items: [null] },
        { items: [{ materialId }] },
        { items: [{ quantity: 1 }] },
        ...[0, -1, 0.24, 100000.01, 1.001, "1", null].map((quantity) => ({
          items: [{ materialId, quantity }],
        })),
        ...[0, -1, 1.5, "1", null].map((id) => ({
          items: [{ materialId: id, quantity: 1 }],
        })),
        { items: [{ materialId, quantity: 1 }], note: "x".repeat(501) },
        { items: [{ materialId, quantity: 1, note: "x".repeat(501) }] },
        { items: [{ materialId, quantity: 1 }], payout: 500 },
        { items: [{ materialId, quantity: 1, price_per_unit: 500 }] },
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
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      const payload = await response.json();
      expect(payload).toEqual({
        error: "Invalid input",
        errors: expect.any(Object),
      });
      expect(Array.isArray(payload.errors)).toBe(false);
      expect(Object.keys(payload.errors).length).toBeGreaterThan(0);
      for (const message of Object.values(payload.errors)) {
        expect(message).toEqual(expect.any(String));
      }
      expect(await snapshot()).toEqual(before);
    }
    for (const body of ["{", ""]) {
      const before = await snapshot();
      const response = await pickups.POST(
        new Request(`${baseUrl}${endpoint.path}`, {
          method: endpoint.method,
          headers: {
            cookie: cookies[endpoint.actor],
            "content-type": "application/json",
          },
          body,
          signal: AbortSignal.timeout(60_000),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Request body must be valid JSON.",
      });
      expect(await snapshot()).toEqual(before);
    }
  }, 30_000);

  it("returns creation conflicts without partial pickups or items", async () => {
    const body = { items: [{ materialId, quantity: 2 }] };
    {
      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.otherCustomer, body),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, {
          items: [
            { materialId, quantity: 2 },
            { materialId: 2147483647, quantity: 1 },
          ],
        }),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    for (const price of ["0", "0.99", "-1"]) {
      await prisma.material.update({
        where: { id: materialId },
        data: { current_price: price },
      });

      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, body),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    await prisma.material.update({
      where: { id: materialId },
      data: { current_price: 1 },
    });
    {
      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, {
          items: [{ materialId, quantity: 0.25 }],
        }),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    await prisma.material.update({
      where: { id: materialId },
      data: { current_price: 1001 },
    });
    {
      const before = await snapshot();
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, {
          items: [{ materialId, quantity: 100000 }],
        }),
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("persists boundary quantities and normalized notes using server prices", async () => {
    const finances = await snapshot();
    for (const quantity of [0.25, 100000]) {
      const response = await pickups.POST(
        makeRequest("POST", "/api/pickups", cookies.customer, {
          note: `  ${"x".repeat(500)}  `,
          items: [{ materialId, quantity, note: "  packed paper  " }],
        }),
      );
      expect(response.status).toBe(201);
      const body: { id: number; requested_at: string } = await response.json();
      const saved = await prisma.pickup.findUniqueOrThrow({
        where: { id: body.id },
        include: { items: true },
      });
      expect(saved).toMatchObject({
        customer_id: users.customer,
        status: "pending",
        payout_status: "pending",
        collector_id: null,
        note: "x".repeat(500),
      });
      expect(saved.items).toHaveLength(1);
      expect(saved.items[0].quantity.toString()).toBe(String(quantity));
      expect(saved.items[0].price_per_unit.toString()).toBe("10");
      expect(saved.items[0].note).toBe("packed paper");
      expect(saved.payout?.toString()).toBe(String(quantity * 10));
      expect(body.requested_at).toBe(saved.requested_at.toISOString());
    }
    const after = await snapshot();
    expect(after.wallets).toEqual(finances.wallets);
    expect(after.transactions).toEqual(finances.transactions);
  });

  it("allows owners, assigned collectors, and admins to read the appropriate data", async () => {
    for (const actor of ["customer", "collector", "admin"] as const) {
      const response = await pickup.GET(
        makeRequest("GET", `/api/pickups/${pickupId}`, cookies[actor]),
        contextForPath(`/api/pickups/${pickupId}`),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: pickupId,
        status: "assigned",
        payout: "20",
      });
    }
    for (const actor of ["customer", "collector"] as const) {
      const response = await pickups.GET(
        makeRequest("GET", "/api/pickups", cookies[actor]),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        items: [{ id: pickupId }],
      });
    }
    const response = await listAdminPickups(
      makeRequest("GET", "/api/admin/pickups", cookies.admin),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [{ id: pickupId }],
    });
  });

  it("validates admin pagination and status filters without writes", async () => {
    for (const query of [
      "page=0",
      "page=-1",
      "page=1.5",
      "page=text",
      "pageSize=0",
      "pageSize=101",
      "pageSize=1.5",
      "pageSize=text",
      "status=invalid",
      "status=",
    ]) {
      const before = await snapshot();
      const response = await listAdminPickups(
        makeRequest("GET", `/api/admin/pickups?${query}`, cookies.admin),
      );
      expect(response.status, `GET ${`/api/admin/pickups?${query}`}`).toBe(400);
      const field = query.split("=")[0];
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: { [field]: expect.any(String) },
      });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("returns stable filtered pages, empty results, and serialized timestamps", async () => {
    const createdAt = new Date("2026-01-01T10:00:00Z");
    await prisma.pickup.update({
      where: { id: pickupId },
      data: { created_at: createdAt },
    });
    const newer = await prisma.pickup.create({
      data: {
        customer_id: users.otherCustomer,
        status: "pending",
        payout: 10,
        created_at: createdAt,
      },
    });
    const before = await snapshot();
    const response = await listAdminPickups(
      makeRequest("GET", "/api/admin/pickups?page=1&pageSize=1", cookies.admin),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      items: [{ id: newer.id, created_at: createdAt.toISOString() }],
    });
    const second = await listAdminPickups(
      makeRequest("GET", "/api/admin/pickups?page=2&pageSize=1", cookies.admin),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      page: 2,
      items: [{ id: pickupId }],
    });
    const filtered = await listAdminPickups(
      makeRequest(
        "GET",
        "/api/admin/pickups?status=assigned&pageSize=100",
        cookies.admin,
      ),
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      total: 1,
      items: [{ id: pickupId }],
    });
    for (const query of ["status=completed", "page=3&pageSize=1"]) {
      const empty = await listAdminPickups(
        makeRequest("GET", `/api/admin/pickups?${query}`, cookies.admin),
      );
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ items: [] });
    }
    for (const actor of ["customer", "collector"] as const) {
      const scoped = await pickups.GET(
        makeRequest("GET", "/api/pickups", cookies[actor]),
      );
      expect(scoped.status).toBe(200);
      expect(await scoped.json()).toMatchObject({ items: [{ id: pickupId }] });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("allows authorized creation, cancellation, assignment, unassignment, progress, and payout", async () => {
    const created = await pickups.POST(
      makeRequest("POST", "/api/pickups", cookies.customer, {
        items: [{ materialId, quantity: 2 }],
      }),
    );
    expect(created.status).toBe(201);
    const createdBody: { id: number } = await created.json();
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: createdBody.id } }),
    ).toMatchObject({ customer_id: users.customer, status: "pending" });
    expect(
      (
        await pickup.DELETE(
          makeRequest(
            "DELETE",
            `/api/pickups/${createdBody.id}`,
            cookies.customer,
          ),
          contextForPath(`/api/pickups/${createdBody.id}`),
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: createdBody.id } }),
    ).toMatchObject({ status: "cancelled", payout_status: "cancelled" });

    expect(
      (
        await unassign(
          makeRequest(
            "PATCH",
            `/api/admin/pickups/${pickupId}/unassign`,
            cookies.admin,
          ),
          contextForPath(`/api/admin/pickups/${pickupId}/unassign`),
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
    ).toMatchObject({ status: "pending", collector_id: null });
    expect(
      (
        await assign(
          makeRequest(
            "PATCH",
            `/api/admin/pickups/${pickupId}/assign`,
            cookies.admin,
            { collectorId: users.collector },
          ),
          contextForPath(`/api/admin/pickups/${pickupId}/assign`),
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
    ).toMatchObject({ status: "assigned", collector_id: users.collector });
    for (const status of ["on_the_way", "arrived", "completed"]) {
      expect(
        (
          await pickup.PATCH(
            makeRequest(
              "PATCH",
              `/api/pickups/${pickupId}`,
              cookies.collector,
              { status },
            ),
            contextForPath(`/api/pickups/${pickupId}`),
          )
        ).status,
      ).toBe(200);
      expect(
        await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
      ).toMatchObject({ status });
    }
    expect(
      (
        await payoutRoute(
          makeRequest(
            "PATCH",
            `/api/admin/pickups/${pickupId}/payout`,
            cookies.admin,
            { status: "paid" },
          ),
          contextForPath(`/api/admin/pickups/${pickupId}/payout`),
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
    ).toMatchObject({ payout_status: "paid" });
    expect(
      (
        await prisma.wallet.findUniqueOrThrow({
          where: { user_id: users.customer },
        })
      ).balance.toString(),
    ).toBe("120");
    const transactions = await prisma.walletTransaction.findMany();
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      pickup_id: pickupId,
      type: "payout",
    });
    expect(transactions[0].amount.toString()).toBe("20");

    const before = await snapshot();
    const response = await payoutRoute(
      makeRequest(
        "PATCH",
        `/api/admin/pickups/${pickupId}/payout`,
        cookies.admin,
        { status: "paid" },
      ),
      contextForPath(`/api/admin/pickups/${pickupId}/payout`),
    );
    expect(
      response.status,
      `PATCH ${`/api/admin/pickups/${pickupId}/payout`}`,
    ).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });
});
