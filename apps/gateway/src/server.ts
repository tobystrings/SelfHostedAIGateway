import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await buildApp({ config });
let stopping = false;

async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "graceful shutdown started");
  try {
    await app.close();
    app.log.info("graceful shutdown completed");
  } catch (error) {
    app.log.error({ err: error }, "graceful shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  await app.close();
  throw error;
}
