import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const pickupHttpTests = "src/app/api/pickups/__tests__/*.integration.test.ts";

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
          exclude: [...configDefaults.exclude, pickupHttpTests],
        },
      },
      {
        extends: true,
        test: {
          name: "pickup-http",
          include: [pickupHttpTests],
          // These files share one server and reset the same disposable database.
          fileParallelism: false,
          maxWorkers: 1,
          testTimeout: 30_000,
          globalSetup: ["tests/pickup-http.global-setup.ts"],
        },
      },
    ],
  },
});
