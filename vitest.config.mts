import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pickupRouteTests = [
  "src/app/api/pickups/__tests__/*-route.integration.test.ts",
  "src/app/api/admin/pickups/__tests__/*-route.integration.test.ts",
  "src/app/api/wallet/withdrawals/__tests__/*-route.integration.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    teardownTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: "application",
          exclude: [...configDefaults.exclude, ...pickupRouteTests],
        },
      },
      {
        extends: true,
        test: {
          name: "pickup-route",
          include: pickupRouteTests,
          // Projects with different worker limits need separate execution groups.
          sequence: { groupOrder: 1 },
          // Each suite owns a PostgreSQL container; bound local Docker load.
          maxWorkers: 3,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
