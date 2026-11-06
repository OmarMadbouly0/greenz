import { execFile, fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";
import { hashPassword } from "@/modules/identity/application/password";
import type { PickupHttpEnvironment } from "@/app/api/pickups/__tests__/pickup-http.fixture";

const execFileAsync = promisify(execFile);
const prismaCliPath = createRequire(import.meta.url).resolve("prisma/build/index.js");

export default async function setupPickupHttpEnvironment(project: TestProject) {
  let container: StartedPostgreSqlContainer | undefined;
  let server: ChildProcess | undefined;
  let logs = "";

  async function cleanup() {
    try {
      if (server && server.exitCode === null && server.signalCode === null) {
        const child = server;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child.kill(), 10_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          if (child.connected) child.send("stop");
          else child.kill();
        });
      }
    } finally {
      await container?.stop();
    }
  }

  try {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    const databaseUrl = container.getConnectionUri();
    const secret = "pickup-permissions-disposable-test-secret";
    const password = "test-password";
    const passwordHash = await hashPassword(password);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: databaseUrl,
      JWT_SECRET: secret,
      NODE_ENV: "test",
      NEXT_TELEMETRY_DISABLED: "1",
      GREENZ_TEST_SERVER: "1",
    };
    await execFileAsync(
      process.execPath,
      [prismaCliPath, "migrate", "deploy", "--config", "prisma7.config.ts"],
      { env },
    );
    server = fork("tests/next-test-server.mjs", [], {
      env,
      silent: true,
      execArgv: [],
    });
    const captureLog = (chunk: Buffer) => {
      logs = (logs + chunk.toString()).slice(-12000);
    };
    server.stdout?.on("data", captureLog);
    server.stderr?.on("data", captureLog);
    const child = server;
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Test server startup timed out: ${logs}`)),
        120_000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Test server exited (${code}): ${logs}`));
      });
      child.once("message", (message: unknown) => {
        clearTimeout(timer);
        if (
          typeof message === "object" && message !== null &&
          "port" in message && typeof message.port === "number"
        ) {
          resolve(`http://127.0.0.1:${message.port}`);
        } else {
          reject(new Error("Invalid server ready message"));
        }
      });
    });
    const environment: PickupHttpEnvironment = {
      databaseUrl, baseUrl, secret, password, passwordHash,
    };
    project.provide("pickupHttp", environment);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
