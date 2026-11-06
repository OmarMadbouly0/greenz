import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/../generated/prisma/client";
import { getPrisma, withTransaction } from "../prisma";

const execFileAsync = promisify(execFile);
const prismaCliPath = createRequire(import.meta.url).resolve(
  "prisma/build/index.js",
);

describe("Prisma client lifecycle", () => {
  let container: StartedPostgreSqlContainer | undefined;
  const clients = new Set<PrismaClient>();
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
  };
  const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };
  const originalClient = globalForPrisma.prisma;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env.DATABASE_URL = container.getConnectionUri();
    delete globalForPrisma.prisma;
    await execFileAsync(process.execPath, [
      prismaCliPath,
      "migrate",
      "deploy",
      "--config",
      "prisma7.config.ts",
    ]);
  }, 180_000);

  afterEach(async () => {
    try {
      const client = clients.values().next().value;
      if (client) await client.user.deleteMany();
    } finally {
      await Promise.all([...clients].map((client) => client.$disconnect()));
      clients.clear();
      delete globalForPrisma.prisma;
    }
  });

  afterAll(async () => {
    try {
      await container?.stop();
    } finally {
      globalForPrisma.prisma = originalClient;
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("reuses a real client across calls and transactions in production", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const first = getPrisma();
    clients.add(first);
    const second = getPrisma();
    clients.add(second);

    expect(second).toBe(first);
    expect(getPrisma()).toBe(first);

    const user = await first.user.create({
      data: {
        full_name: "Before transaction",
        email: "client-lifecycle@example.com",
        password_hash: "unused-in-this-test",
      },
    });
    await withTransaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { full_name: "After transaction" },
      });
    });

    expect(getPrisma()).toBe(first);
    expect(
      await second.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ full_name: "After transaction" });
  });

  it("reuses a real client across calls and transactions in development", async () => {
    Object.assign(process.env, { NODE_ENV: "development" });
    const first = getPrisma();
    clients.add(first);
    const second = getPrisma();
    clients.add(second);

    expect(second).toBe(first);
    expect(getPrisma()).toBe(first);

    const user = await first.user.create({
      data: {
        full_name: "Before transaction",
        email: "client-lifecycle@example.com",
        password_hash: "unused-in-this-test",
      },
    });
    await withTransaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { full_name: "After transaction" },
      });
    });

    expect(getPrisma()).toBe(first);
    expect(
      await second.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ full_name: "After transaction" });
  });

  it("reuses a real client across calls and transactions in test", async () => {
    Object.assign(process.env, { NODE_ENV: "test" });
    const first = getPrisma();
    clients.add(first);
    const second = getPrisma();
    clients.add(second);

    expect(second).toBe(first);
    expect(getPrisma()).toBe(first);

    const user = await first.user.create({
      data: {
        full_name: "Before transaction",
        email: "client-lifecycle@example.com",
        password_hash: "unused-in-this-test",
      },
    });
    await withTransaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { full_name: "After transaction" },
      });
    });

    expect(getPrisma()).toBe(first);
    expect(
      await second.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ full_name: "After transaction" });
  });
});
