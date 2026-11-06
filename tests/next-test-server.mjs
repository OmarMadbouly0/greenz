import { createServer } from "node:http";
import next from "next";

// Only launched by integration tests with an explicit disposable database.
if (
  !process.send ||
  process.env.GREENZ_TEST_SERVER !== "1" ||
  !process.env.DATABASE_URL ||
  !process.env.JWT_SECRET
) {
  throw new Error("The test server requires IPC and explicit test credentials.");
}

const app = next({
  dev: true,
  webpack: true,
  hostname: "127.0.0.1",
});
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer((request, response) => handle(request, response));
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.send({ port: address.port });
});

process.on("message", async (message) => {
  if (message !== "stop") return;
  server.close();
  server.closeAllConnections();
  await globalThis.prisma?.$disconnect();
  await app.close();
  process.exit(0);
});
