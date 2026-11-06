import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  ...(process.env.GREENZ_TEST_SERVER === "1"
    ? {
        distDir: ".next/pickup-permissions",
        typescript: { tsconfigPath: "tests/tsconfig.next.json" },
      }
    : {}),
};

export default nextConfig;
