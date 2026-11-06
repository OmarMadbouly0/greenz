import { describe, expect, it } from "vitest";
import { setupPickupHttpFixture } from "./pickup-http.fixture";

describe("Pickup payouts", () => {
  const fixture = setupPickupHttpFixture();

  it("rejects malformed JSON and invalid bodies on payout updates", async () => {
    const { baseUrl, cookies, pickupId, request, snapshot } = fixture;

    const endpoint = {
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

  it("rejects payment and payout cancellation for a pending pickup", async () => {
    const { prisma, cookies, users, pickupId, request, snapshot, seedState } = fixture;

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
      const response = await request("PATCH", path, cookies.admin, {
        status: "paid",
      });
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
      const response = await request("PATCH", path, cookies.admin, {
        status: "cancelled",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects payment and payout cancellation for an assigned pickup", async () => {
    const { prisma, cookies, users, pickupId, request, snapshot, seedState } = fixture;

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
      const response = await request("PATCH", path, cookies.admin, {
        status: "paid",
      });
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
      const response = await request("PATCH", path, cookies.admin, {
        status: "cancelled",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects payment and payout cancellation for an on_the_way pickup", async () => {
    const { prisma, cookies, users, pickupId, request, snapshot, seedState } = fixture;

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
      const response = await request("PATCH", path, cookies.admin, {
        status: "paid",
      });
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
      const response = await request("PATCH", path, cookies.admin, {
        status: "cancelled",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects payment and payout cancellation for an arrived pickup", async () => {
    const { prisma, cookies, users, pickupId, request, snapshot, seedState } = fixture;

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
      const response = await request("PATCH", path, cookies.admin, {
        status: "paid",
      });
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
      const response = await request("PATCH", path, cookies.admin, {
        status: "cancelled",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("allows payment or cancellation for a completed pickup and rejects repeat payout actions", async () => {
    const { prisma, cookies, users, pickupId, request, snapshot, seedState } = fixture;

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
      const response = await request("PATCH", path, cookies.admin, {
        status: "paid",
      });
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
        const response = await request("PATCH", path, cookies.admin, {
          status: "paid",
        });
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
      {
        const before = await snapshot();
        const response = await request("PATCH", path, cookies.admin, {
          status: "cancelled",
        });
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
      const response = await request("PATCH", path, cookies.admin, {
        status: "cancelled",
      });
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
        const response = await request("PATCH", path, cookies.admin, {
          status: "paid",
        });
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
      {
        const before = await snapshot();
        const response = await request("PATCH", path, cookies.admin, {
          status: "cancelled",
        });
        expect(response.status, `PATCH ${path}`).toBe(409);
        expect(await response.json()).toEqual({ error: expect.any(String) });
        expect(await snapshot()).toEqual(before);
      }
    }
  });

  it("rejects payment and payout cancellation for a cancelled pickup", async () => {
    const { prisma, cookies, users, pickupId, request, snapshot, seedState } = fixture;

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
      const response = await request("PATCH", path, cookies.admin, {
        status: "paid",
      });
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
      const response = await request("PATCH", path, cookies.admin, {
        status: "cancelled",
      });
      expect(response.status, `PATCH ${path}`).toBe(409);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("rejects missing-wallet payment but allows payout cancellation without a wallet", async () => {
    const { prisma, cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("completed");
    await prisma.wallet.deleteMany();
    const path = `/api/admin/pickups/${pickupId}/payout`;
    {
      const before = await snapshot();
      const response = await request("PATCH", path, cookies.admin, {
        status: "paid",
      });
      expect(response.status, `PATCH ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(await snapshot()).toEqual(before);
    }
    const before = await snapshot();
    const response = await request("PATCH", path, cookies.admin, {
      status: "cancelled",
    });
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
    const { prisma, cookies, pickupId, request, snapshot, seedState } = fixture;

    await seedState("completed");
    for (const payout of [null, "0", "-1", "0.99", "100000000.01"]) {
      await prisma.pickup.update({ where: { id: pickupId }, data: { payout } });
      for (const status of ["paid", "cancelled"]) {
        const before = await snapshot();
        const response = await request(
          "PATCH",
          `/api/admin/pickups/${pickupId}/payout`,
          cookies.admin,
          { status },
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
