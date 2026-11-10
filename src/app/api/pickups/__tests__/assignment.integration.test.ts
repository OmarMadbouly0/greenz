import { describe, expect, it } from "vitest";
import { setupPickupHttpFixture } from "./pickup-http.fixture";

describe("Pickup assignment and unassignment", () => {
  const fixture = setupPickupHttpFixture();

  it("rejects malformed JSON and invalid bodies on collector assignment", async () => {
    const { baseUrl, cookies, pickupId, request, snapshot } = fixture;

    const endpoint = {
      method: "PATCH",
      path: `/api/admin/pickups/${pickupId}/assign`,
      actor: "admin",
      invalid: [
        {},
        ...[0, -1, 1.5, "1", null].map((collectorId) => ({ collectorId })),
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
      const field = body === null || Array.isArray(body) ? "input" : "collectorId";
      expect(await response.json()).toEqual({
        error: "Invalid input",
        errors: { [field]: expect.any(String) },
      });
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

  it("allows assignment of a pending pickup and rejects repeats or replacement", async () => {
    const { cookies, users, pickupId, request, snapshot, seedState } = fixture;

    await seedState("pending");
    const path = `/api/admin/pickups/${pickupId}/assign`;
    const body = { collectorId: users.collector };
    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: pickupId,
      status: "assigned",
      collector_id: users.collector,
    });
    const after = await snapshot();
    expect(after).toEqual({
      ...before,
      pickups: [
        {
          ...before.pickups[0],
          status: "assigned",
          collector_id: users.collector,
          updated_at: expect.any(Date),
        },
      ],
    });
    {
      const before = await snapshot();
      const response = await request("PATCH", path, cookies.admin, body);
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request("PATCH", path, cookies.admin, {
        collectorId: users.otherCollector,
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects assignment of an already assigned pickup", async () => {
    const { cookies, users, pickupId, request, snapshot, seedState } = fixture;

    await seedState("assigned");
    const path = `/api/admin/pickups/${pickupId}/assign`;
    const body = { collectorId: users.collector };

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, body);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects assignment of an on_the_way pickup", async () => {
    const { cookies, users, pickupId, request, snapshot, seedState } = fixture;

    await seedState("on_the_way");
    const path = `/api/admin/pickups/${pickupId}/assign`;
    const body = { collectorId: users.collector };

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, body);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects assignment of an arrived pickup", async () => {
    const { cookies, users, pickupId, request, snapshot, seedState } = fixture;

    await seedState("arrived");
    const path = `/api/admin/pickups/${pickupId}/assign`;
    const body = { collectorId: users.collector };

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, body);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects assignment of a completed pickup", async () => {
    const { cookies, users, pickupId, request, snapshot, seedState } = fixture;

    await seedState("completed");
    const path = `/api/admin/pickups/${pickupId}/assign`;
    const body = { collectorId: users.collector };

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, body);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects assignment of a cancelled pickup", async () => {
    const { cookies, users, pickupId, request, snapshot, seedState } = fixture;

    await seedState("cancelled");
    const path = `/api/admin/pickups/${pickupId}/assign`;
    const body = { collectorId: users.collector };

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, body);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("returns 404 when assigning to a missing user or a non-collector", async () => {
    const { cookies, users, pickupId, request, snapshot, seedState } = fixture;

    await seedState("pending");
    for (const collectorId of [2147483647, users.customer, users.admin]) {
      const before = await snapshot();
      const response = await request(
        "PATCH",
        `/api/admin/pickups/${pickupId}/assign`,
        cookies.admin,
        { collectorId },
      );
      expect(
        response.status,
        `PATCH ${`/api/admin/pickups/${pickupId}/assign`}`,
      ).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects unassignment of a pending pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("pending");
    const path = `/api/admin/pickups/${pickupId}/unassign`;

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, undefined);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("allows unassignment of an assigned pickup and revokes collector access", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("assigned");
    const path = `/api/admin/pickups/${pickupId}/unassign`;
    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: pickupId,
      status: "pending",
      collector_id: null,
    });
    expect(await snapshot()).toEqual({
      ...before,
      pickups: [
        {
          ...before.pickups[0],
          status: "pending",
          collector_id: null,
          updated_at: expect.any(Date),
        },
      ],
    });
    {
      const before = await snapshot();
      const response = await request("PATCH", path, cookies.admin);
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request(
        "GET",
        `/api/pickups/${pickupId}`,
        cookies.collector,
      );
      expect(response.status, `GET ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    {
      const before = await snapshot();
      const response = await request(
        "PATCH",
        `/api/pickups/${pickupId}`,
        cookies.collector,
        { status: "on_the_way" },
      );
      expect(response.status, `PATCH ${`/api/pickups/${pickupId}`}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects unassignment of an on_the_way pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("on_the_way");
    const path = `/api/admin/pickups/${pickupId}/unassign`;

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, undefined);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects unassignment of an arrived pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("arrived");
    const path = `/api/admin/pickups/${pickupId}/unassign`;

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, undefined);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects unassignment of a completed pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("completed");
    const path = `/api/admin/pickups/${pickupId}/unassign`;

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, undefined);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects unassignment of a cancelled pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("cancelled");
    const path = `/api/admin/pickups/${pickupId}/unassign`;

    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, undefined);
    expect(response.status, `PATCH ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });
});
