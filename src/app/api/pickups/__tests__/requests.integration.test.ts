import { describe, expect, it } from "vitest";
import { setupPickupHttpFixture } from "./pickup-http.fixture";

describe("Pickup creation, reads, and lifecycle", () => {
  const fixture = setupPickupHttpFixture();

  it("rejects malformed JSON and invalid bodies on pickup creation", async () => {
    const { baseUrl, cookies, materialId, request, snapshot } = fixture;

    const endpoint = {
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
      const response = await request(
        endpoint.method,
        endpoint.path,
        cookies[endpoint.actor],
        body,
      );
      expect(response.status, `${endpoint.method} ${endpoint.path}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    for (const body of ["{", ""]) {
      const before = await snapshot();
      const response = await fetch(`${baseUrl}${endpoint.path}`, {
        method: endpoint.method,
        headers: {
          cookie: cookies[endpoint.actor],
          "content-type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(60_000),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Request body must be valid JSON.",
      });
      expect(await snapshot()).toEqual(before);
    }
  }, 30_000);

  it("returns creation conflicts without partial pickups or items", async () => {
    const { prisma, cookies, materialId, request, snapshot } = fixture;

    const body = { items: [{ materialId, quantity: 2 }] };
    {
      const before = await snapshot();
      const response = await request(
        "POST",
        "/api/pickups",
        cookies.otherCustomer,
        body,
      );
      expect(response.status, `POST ${"/api/pickups"}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request("POST", "/api/pickups", cookies.customer, {
        items: [
          { materialId, quantity: 2 },
          { materialId: 2147483647, quantity: 1 },
        ],
      });
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
      const response = await request(
        "POST",
        "/api/pickups",
        cookies.customer,
        body,
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
      const response = await request("POST", "/api/pickups", cookies.customer, {
        items: [{ materialId, quantity: 0.25 }],
      });
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
      const response = await request("POST", "/api/pickups", cookies.customer, {
        items: [{ materialId, quantity: 100000 }],
      });
      expect(response.status, `POST ${"/api/pickups"}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("persists boundary quantities and normalized notes using server prices", async () => {
    const { prisma, cookies, users, materialId, request, snapshot } = fixture;

    const finances = await snapshot();
    for (const quantity of [0.25, 100000]) {
      const response = await request("POST", "/api/pickups", cookies.customer, {
        note: `  ${"x".repeat(500)}  `,
        items: [{ materialId, quantity, note: "  packed paper  " }],
      });
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
    const { cookies, pickupId, request } = fixture;

    for (const actor of ["customer", "collector", "admin"] as const) {
      const response = await request(
        "GET",
        `/api/pickups/${pickupId}`,
        cookies[actor],
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: pickupId,
        status: "assigned",
        payout: "20",
      });
    }
    for (const actor of ["customer", "collector"] as const) {
      const response = await request("GET", "/api/pickups", cookies[actor]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ items: [{ id: pickupId }] });
    }
    const response = await request("GET", "/api/admin/pickups", cookies.admin);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      items: [{ id: pickupId }],
    });
  });

  it("validates admin pagination and status filters without writes", async () => {
    const { cookies, request, snapshot } = fixture;

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
      const response = await request(
        "GET",
        `/api/admin/pickups?${query}`,
        cookies.admin,
      );
      expect(response.status, `GET ${`/api/admin/pickups?${query}`}`).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("returns stable filtered pages, empty results, and serialized timestamps", async () => {
    const { prisma, cookies, users, pickupId, request, snapshot } = fixture;

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
    const response = await request(
      "GET",
      "/api/admin/pickups?page=1&pageSize=1",
      cookies.admin,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 2,
      totalPages: 2,
      items: [{ id: newer.id, created_at: createdAt.toISOString() }],
    });
    const second = await request(
      "GET",
      "/api/admin/pickups?page=2&pageSize=1",
      cookies.admin,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      page: 2,
      items: [{ id: pickupId }],
    });
    const filtered = await request(
      "GET",
      "/api/admin/pickups?status=assigned&pageSize=100",
      cookies.admin,
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      total: 1,
      items: [{ id: pickupId }],
    });
    for (const query of ["status=completed", "page=3&pageSize=1"]) {
      const empty = await request(
        "GET",
        `/api/admin/pickups?${query}`,
        cookies.admin,
      );
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ items: [] });
    }
    for (const actor of ["customer", "collector"] as const) {
      const scoped = await request("GET", "/api/pickups", cookies[actor]);
      expect(scoped.status).toBe(200);
      expect(await scoped.json()).toMatchObject({ items: [{ id: pickupId }] });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("allows authorized creation, cancellation, assignment, unassignment, progress, and payout", async () => {
    const { prisma, cookies, users, pickupId, materialId, request, snapshot } = fixture;

    const created = await request("POST", "/api/pickups", cookies.customer, {
      items: [{ materialId, quantity: 2 }],
    });
    expect(created.status).toBe(201);
    const createdBody: { id: number } = await created.json();
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: createdBody.id } }),
    ).toMatchObject({ customer_id: users.customer, status: "pending" });
    expect(
      (
        await request(
          "DELETE",
          `/api/pickups/${createdBody.id}`,
          cookies.customer,
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: createdBody.id } }),
    ).toMatchObject({ status: "cancelled", payout_status: "cancelled" });

    expect(
      (
        await request(
          "PATCH",
          `/api/admin/pickups/${pickupId}/unassign`,
          cookies.admin,
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
    ).toMatchObject({ status: "pending", collector_id: null });
    expect(
      (
        await request(
          "PATCH",
          `/api/admin/pickups/${pickupId}/assign`,
          cookies.admin,
          { collectorId: users.collector },
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
    ).toMatchObject({ status: "assigned", collector_id: users.collector });
    for (const status of ["on_the_way", "arrived", "completed"]) {
      expect(
        (
          await request(
            "PATCH",
            `/api/pickups/${pickupId}`,
            cookies.collector,
            { status },
          )
        ).status,
      ).toBe(200);
      expect(
        await prisma.pickup.findUniqueOrThrow({ where: { id: pickupId } }),
      ).toMatchObject({ status });
    }
    expect(
      (
        await request(
          "PATCH",
          `/api/admin/pickups/${pickupId}/payout`,
          cookies.admin,
          { status: "paid" },
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
    const response = await request(
      "PATCH",
      `/api/admin/pickups/${pickupId}/payout`,
      cookies.admin,
      { status: "paid" },
    );
    expect(
      response.status,
      `PATCH ${`/api/admin/pickups/${pickupId}/payout`}`,
    ).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });
});
