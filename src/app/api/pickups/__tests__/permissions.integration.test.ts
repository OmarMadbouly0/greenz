import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { setupPickupHttpFixture } from "./pickup-http.fixture";

describe("Pickup permissions and IDs", () => {
  const fixture = setupPickupHttpFixture();

  it("rejects missing authentication on every pickup endpoint without writes", async () => {
    const { request, snapshot, endpoints } = fixture;

    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        undefined,
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects malformed authentication on every pickup endpoint without writes", async () => {
    const { request, snapshot, endpoints } = fixture;

    const token = "invalid-token";
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        `token=${token}`,
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects expired authentication on every pickup endpoint without writes", async () => {
    const { users, secret, request, snapshot, endpoints } = fixture;

    const token = jwt.sign({ userId: users.admin }, secret, { expiresIn: -60 });
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        `token=${token}`,
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects tokens signed with the wrong secret on every pickup endpoint without writes", async () => {
    const { users, request, snapshot, endpoints } = fixture;

    const token = jwt.sign({ userId: users.admin }, "wrong-secret", {
      expiresIn: 3600,
    });
    for (const endpoint of endpoints()) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        `token=${token}`,
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects deleted-user authentication on every pickup endpoint without writes", async () => {
    const { prisma, passwordHash, secret, request, snapshot, endpoints } = fixture;

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
      const response = await request(
        endpoint.method,
        endpoint.path,
        `token=${token}`,
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(401);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  }, 90_000);

  it("rejects forbidden customer operations", async () => {
    const { cookies, request, snapshot, endpoints } = fixture;

    for (const endpoint of endpoints().filter(
      (entry) => !entry.allowed.includes("customer"),
    )) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies["customer"],
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects forbidden collector operations", async () => {
    const { cookies, request, snapshot, endpoints } = fixture;

    for (const endpoint of endpoints().filter(
      (entry) => !entry.allowed.includes("collector"),
    )) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies["collector"],
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects forbidden admin operations", async () => {
    const { cookies, request, snapshot, endpoints } = fixture;

    for (const endpoint of endpoints().filter(
      (entry) => !entry.allowed.includes("admin"),
    )) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies["admin"],
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("prevents another customer or collector from reading or changing the pickup", async () => {
    const { cookies, pickupId, request, snapshot } = fixture;

    for (const actor of ["otherCustomer", "otherCollector"] as const) {
      const before = await snapshot();
      const response = await request(
        "GET",
        `/api/pickups/${pickupId}`,
        cookies[actor],
      );
      expect(response.status, `GET ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request(
        "DELETE",
        `/api/pickups/${pickupId}`,
        cookies.otherCustomer,
      );
      expect(response.status, `DELETE ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request(
        "PATCH",
        `/api/pickups/${pickupId}`,
        cookies.otherCollector,
        { status: "on_the_way" },
      );
      expect(response.status, `PATCH ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    for (const actor of ["otherCustomer", "otherCollector"] as const) {
      const response = await request("GET", "/api/pickups", cookies[actor]);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    }
  });

  it("uses the current database role even when an old admin cookie remains valid", async () => {
    const { prisma, cookies, users, request, snapshot, endpoints } = fixture;

    await prisma.user.update({
      where: { id: users.admin },
      data: { role: "customer" },
    });
    for (const endpoint of endpoints().filter((entry) =>
      entry.path.startsWith("/api/admin/"),
    )) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies.admin,
        endpoint.body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(403);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects zero path IDs on every ID route without writes", async () => {
    const { cookies, request, snapshot, idEndpoints } = fixture;

    for (const endpoint of idEndpoints("0")) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies[endpoint.actor],
        "body" in endpoint ? endpoint.body : undefined,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects negative path IDs on every ID route without writes", async () => {
    const { cookies, request, snapshot, idEndpoints } = fixture;

    for (const endpoint of idEndpoints("-1")) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies[endpoint.actor],
        "body" in endpoint ? endpoint.body : undefined,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects fractional path IDs on every ID route without writes", async () => {
    const { cookies, request, snapshot, idEndpoints } = fixture;

    for (const endpoint of idEndpoints("1.5")) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies[endpoint.actor],
        "body" in endpoint ? endpoint.body : undefined,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects nonnumeric path IDs on every ID route without writes", async () => {
    const { cookies, request, snapshot, idEndpoints } = fixture;

    for (const endpoint of idEndpoints("abc")) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies[endpoint.actor],
        "body" in endpoint ? endpoint.body : undefined,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects oversized path IDs on every ID route without writes", async () => {
    const { cookies, request, snapshot, idEndpoints } = fixture;

    for (const endpoint of idEndpoints("2147483648")) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies[endpoint.actor],
        "body" in endpoint ? endpoint.body : undefined,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("returns 404 for a deleted pickup on every ID route without writes", async () => {
    const { prisma, cookies, pickupId, request, snapshot, idEndpoints } = fixture;

    await prisma.pickup.delete({ where: { id: pickupId } });
    for (const endpoint of idEndpoints(pickupId)) {
      const before = await snapshot();
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies[endpoint.actor],
        "body" in endpoint ? endpoint.body : undefined,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects material and collector IDs above the database maximum without writes", async () => {
    const { cookies, pickupId, materialId, request, snapshot, seedState } = fixture;

    await seedState("pending");
    {
      const before = await snapshot();
      const response = await request("POST", "/api/pickups", cookies.customer, {
        items: [
          { materialId, quantity: 1 },
          { materialId: 2147483648, quantity: 1 },
        ],
      });
      expect(response.status, `POST ${"/api/pickups"}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request(
        "PATCH",
        `/api/admin/pickups/${pickupId}/assign`,
        cookies.admin,
        { collectorId: 2147483648 },
      );
      expect(
        response.status,
        `PATCH ${`/api/admin/pickups/${pickupId}/assign`}`,
      ).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects material and collector IDs at the JavaScript safe integer maximum without writes", async () => {
    const { cookies, pickupId, materialId, request, snapshot, seedState } = fixture;

    await seedState("pending");
    {
      const before = await snapshot();
      const response = await request("POST", "/api/pickups", cookies.customer, {
        items: [
          { materialId, quantity: 1 },
          { materialId: Number.MAX_SAFE_INTEGER, quantity: 1 },
        ],
      });
      expect(response.status, `POST ${"/api/pickups"}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request(
        "PATCH",
        `/api/admin/pickups/${pickupId}/assign`,
        cookies.admin,
        { collectorId: Number.MAX_SAFE_INTEGER },
      );
      expect(
        response.status,
        `PATCH ${`/api/admin/pickups/${pickupId}/assign`}`,
      ).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects material and collector IDs beyond the JavaScript safe integer range without writes", async () => {
    const { cookies, pickupId, materialId, request, snapshot, seedState } = fixture;

    await seedState("pending");
    {
      const before = await snapshot();
      const response = await request("POST", "/api/pickups", cookies.customer, {
        items: [
          { materialId, quantity: 1 },
          { materialId: Number.MAX_SAFE_INTEGER + 1, quantity: 1 },
        ],
      });
      expect(response.status, `POST ${"/api/pickups"}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request(
        "PATCH",
        `/api/admin/pickups/${pickupId}/assign`,
        cookies.admin,
        { collectorId: Number.MAX_SAFE_INTEGER + 1 },
      );
      expect(
        response.status,
        `PATCH ${`/api/admin/pickups/${pickupId}/assign`}`,
      ).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("accepts the maximum database ID for real materials and collectors", async () => {
    const { prisma, passwordHash, cookies, pickupId, request, snapshot, seedState } = fixture;

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
    const response = await request("POST", "/api/pickups", cookies.customer, {
      items: [{ materialId: maxId, quantity: 1 }],
    });
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
    const assigned = await request(
      "PATCH",
      `/api/admin/pickups/${pickupId}/assign`,
      cookies.admin,
      { collectorId: maxId },
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
