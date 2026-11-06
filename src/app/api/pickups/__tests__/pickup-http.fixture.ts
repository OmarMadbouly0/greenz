import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { afterAll, beforeAll, beforeEach, expect, inject } from "vitest";

export interface PickupHttpEnvironment {
  databaseUrl: string;
  baseUrl: string;
  secret: string;
  password: string;
  passwordHash: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    pickupHttp: PickupHttpEnvironment;
  }
}

type Actor = "customer" | "otherCustomer" | "collector" | "otherCollector" | "admin";
type PickupState = "pending" | "assigned" | "on_the_way" | "arrived" | "completed" | "cancelled";

export function setupPickupHttpFixture() {
  const { databaseUrl, baseUrl, secret, password, passwordHash } = inject("pickupHttp");
  let prisma: PrismaClient;
  let cookies: Record<Actor, string>;
  let users: Record<Actor, number>;
  let pickupId: number;
  let materialId: number;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function request(
    method: string,
    path: string,
    cookie?: string,
    body?: unknown,
  ) {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
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
      { method: "GET", path: `/api/pickups/${id}`, actor: "customer" },
      { method: "GET", path: `/api/pickups/${id}`, actor: "collector" },
      { method: "GET", path: `/api/pickups/${id}`, actor: "admin" },
      { method: "DELETE", path: `/api/pickups/${id}`, actor: "customer" },
      {
        method: "PATCH",
        path: `/api/pickups/${id}`,
        actor: "collector",
        body: { status: "on_the_way" },
      },
      {
        method: "PATCH",
        path: `/api/admin/pickups/${id}/assign`,
        actor: "admin",
        body: { collectorId: users.collector },
      },
      {
        method: "PATCH",
        path: `/api/admin/pickups/${id}/unassign`,
        actor: "admin",
      },
      {
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
        method: "GET",
        path: "/api/pickups",
        allowed: ["customer", "collector"],
      },
      {
        method: "POST",
        path: "/api/pickups",
        allowed: ["customer"],
        body: { items: [{ materialId, quantity: 2 }] },
      },
      {
        method: "GET",
        path: `/api/pickups/${pickupId}`,
        allowed: ["customer", "collector", "admin"],
      },
      {
        method: "DELETE",
        path: `/api/pickups/${pickupId}`,
        allowed: ["customer"],
      },
      {
        method: "PATCH",
        path: `/api/pickups/${pickupId}`,
        allowed: ["collector"],
        body: { status: "on_the_way" },
      },
      { method: "GET", path: "/api/admin/pickups", allowed: ["admin"] },
      {
        method: "PATCH",
        path: `/api/admin/pickups/${pickupId}/assign`,
        allowed: ["admin"],
        body: { collectorId: users.collector },
      },
      {
        method: "PATCH",
        path: `/api/admin/pickups/${pickupId}/unassign`,
        allowed: ["admin"],
      },
      {
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
      const response = await request("POST", "/api/auth/login", undefined, {
        email: user.email,
        password,
      });
      expect(
        response.status,
        `Login failed for ${actor}`,
      ).toBe(200);
      const cookie = response.headers.get("set-cookie");
      expect(cookie).toContain("token=");
      if (!cookie) throw new Error("Login did not return a cookie");
      cookies[actor] = cookie.split(";")[0];
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

  return {
    get prisma() { return prisma; },
    get cookies() { return cookies; },
    get users() { return users; },
    get pickupId() { return pickupId; },
    get materialId() { return materialId; },
    baseUrl, secret, passwordHash,
    request, snapshot, seedState, idEndpoints, endpoints,
  };
}
