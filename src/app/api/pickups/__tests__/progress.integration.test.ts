import { describe, expect, it } from "vitest";
import { setupPickupHttpFixture } from "./pickup-http.fixture";

describe("Pickup progress and cancellation", () => {
  const fixture = setupPickupHttpFixture();

  it("rejects malformed JSON and invalid bodies on collector progress", async () => {
    const { baseUrl, cookies, pickupId, request, snapshot } = fixture;

    const endpoint = {
      method: "PATCH",
      path: `/api/pickups/${pickupId}`,
      actor: "collector",
      invalid: [
        {},
        ...["pending", "assigned", "cancelled", "invalid", 1, null].map(
          (status) => ({ status }),
        ),
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

  it("rejects every collector progress target for a pending pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    {
      // pending to on_the_way
      await seedState("pending");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "on_the_way",
      });
      expect(response.status, `PATCH ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // pending to arrived
      await seedState("pending");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "arrived",
      });
      expect(response.status, `PATCH ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // pending to completed
      await seedState("pending");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "completed",
      });
      expect(response.status, `PATCH ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("only allows assigned pickups to advance to on_the_way", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    {
      // assigned to on_the_way
      await seedState("assigned");
      const path = `/api/pickups/${pickupId}`;
      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "on_the_way",
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      const after = await snapshot();
      expect(after).toEqual({
        ...before,
        pickups: [
          {
            ...before.pickups[0],
            status: "on_the_way",
            updated_at: expect.any(Date),
            completed_at: null,
          },
        ],
      });
      expect(body).toMatchObject({
        id: pickupId,
        status: "on_the_way",
        completed_at: after.pickups[0].completed_at?.toISOString() ?? null,
      });
      {
        const before = await snapshot();
        const response = await request("PATCH", path, cookies.collector, {
          status: "on_the_way",
        });
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
    }

    {
      // assigned to arrived
      await seedState("assigned");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "arrived",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // assigned to completed
      await seedState("assigned");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "completed",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("only allows on_the_way pickups to advance to arrived", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    {
      // on_the_way to on_the_way
      await seedState("on_the_way");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "on_the_way",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // on_the_way to arrived
      await seedState("on_the_way");
      const path = `/api/pickups/${pickupId}`;
      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "arrived",
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      const after = await snapshot();
      expect(after).toEqual({
        ...before,
        pickups: [
          {
            ...before.pickups[0],
            status: "arrived",
            updated_at: expect.any(Date),
            completed_at: null,
          },
        ],
      });
      expect(body).toMatchObject({
        id: pickupId,
        status: "arrived",
        completed_at: after.pickups[0].completed_at?.toISOString() ?? null,
      });
      {
        const before = await snapshot();
        const response = await request("PATCH", path, cookies.collector, {
          status: "arrived",
        });
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
    }

    {
      // on_the_way to completed
      await seedState("on_the_way");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "completed",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("only allows arrived pickups to advance to completed", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    {
      // arrived to on_the_way
      await seedState("arrived");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "on_the_way",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // arrived to arrived
      await seedState("arrived");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "arrived",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // arrived to completed
      await seedState("arrived");
      const path = `/api/pickups/${pickupId}`;
      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "completed",
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      const after = await snapshot();
      expect(after).toEqual({
        ...before,
        pickups: [
          {
            ...before.pickups[0],
            status: "completed",
            updated_at: expect.any(Date),
            completed_at: expect.any(Date),
          },
        ],
      });
      expect(body).toMatchObject({
        id: pickupId,
        status: "completed",
        completed_at: after.pickups[0].completed_at?.toISOString() ?? null,
      });
      {
        const before = await snapshot();
        const response = await request("PATCH", path, cookies.collector, {
          status: "completed",
        });
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
    }
  });

  it("rejects every collector progress target for a completed pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    {
      // completed to on_the_way
      await seedState("completed");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "on_the_way",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // completed to arrived
      await seedState("completed");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "arrived",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // completed to completed
      await seedState("completed");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "completed",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects every collector progress target for a cancelled pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    {
      // cancelled to on_the_way
      await seedState("cancelled");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "on_the_way",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // cancelled to arrived
      await seedState("cancelled");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "arrived",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }

    {
      // cancelled to completed
      await seedState("cancelled");
      const path = `/api/pickups/${pickupId}`;

      const before = await snapshot();
      const response = await request("PATCH", path, cookies.collector, {
        status: "completed",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("allows cancellation of a pending pickup and rejects a repeat", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("pending");
    const path = `/api/pickups/${pickupId}`;
    const before = await snapshot();
    const response = await request("DELETE", path, cookies.customer);
    expect(response.status).toBe(200);
    const body = await response.json();
    const after = await snapshot();
    const saved = after.pickups[0];
    expect(saved).toEqual({
      ...before.pickups[0],
      status: "cancelled",
      payout_status: "cancelled",
      cancelled_at: expect.any(Date),
      updated_at: expect.any(Date),
    });
    expect(body).toMatchObject({
      id: pickupId,
      status: "cancelled",
      cancelled_at: saved.cancelled_at?.toISOString(),
    });
    expect(after.items).toEqual(before.items);
    expect(after.wallets).toEqual(before.wallets);
    expect(after.transactions).toEqual(before.transactions);
    {
      const before = await snapshot();
      const response = await request("DELETE", path, cookies.customer);
      expect(response.status, `DELETE ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("allows cancellation of an assigned pickup and rejects a repeat", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("assigned");
    const path = `/api/pickups/${pickupId}`;
    const before = await snapshot();
    const response = await request("DELETE", path, cookies.customer);
    expect(response.status).toBe(200);
    const body = await response.json();
    const after = await snapshot();
    const saved = after.pickups[0];
    expect(saved).toEqual({
      ...before.pickups[0],
      status: "cancelled",
      payout_status: "cancelled",
      cancelled_at: expect.any(Date),
      updated_at: expect.any(Date),
    });
    expect(body).toMatchObject({
      id: pickupId,
      status: "cancelled",
      cancelled_at: saved.cancelled_at?.toISOString(),
    });
    expect(after.items).toEqual(before.items);
    expect(after.wallets).toEqual(before.wallets);
    expect(after.transactions).toEqual(before.transactions);
    {
      const before = await snapshot();
      const response = await request("DELETE", path, cookies.customer);
      expect(response.status, `DELETE ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects cancellation of an on_the_way pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("on_the_way");
    const path = `/api/pickups/${pickupId}`;

    const before = await snapshot();
    const response = await request("DELETE", path, cookies.customer, undefined);
    expect(response.status, `DELETE ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects cancellation of an arrived pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("arrived");
    const path = `/api/pickups/${pickupId}`;

    const before = await snapshot();
    const response = await request("DELETE", path, cookies.customer, undefined);
    expect(response.status, `DELETE ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects cancellation of a completed pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("completed");
    const path = `/api/pickups/${pickupId}`;

    const before = await snapshot();
    const response = await request("DELETE", path, cookies.customer, undefined);
    expect(response.status, `DELETE ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects cancellation of a cancelled pickup", async () => {
    const { cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("cancelled");
    const path = `/api/pickups/${pickupId}`;

    const before = await snapshot();
    const response = await request("DELETE", path, cookies.customer, undefined);
    expect(response.status, `DELETE ${path}`).toBe(409);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(await snapshot()).toEqual(before);
  });
});
