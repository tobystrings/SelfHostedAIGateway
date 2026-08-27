import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/index.js";
import { buildApp } from "./app.js";

describe("production state restoration", () => {
  it("fails startup when persisted provider credentials cannot be decrypted", async () => {
    const config = {
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: 8080,
      DATABASE_URL: "postgres://unused",
      DATABASE_POOL_MAX: 1,
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      BOOTSTRAP_ADMIN_EMAIL: "admin@example.local",
      BOOTSTRAP_ADMIN_PASSWORD: "unused-strong-password",
      SESSION_SECRET: "unused-session-secret-with-thirty-two-characters",
      CORS_ORIGINS: "http://127.0.0.1:8080",
      SESSION_COOKIE_SECURE: false,
      TRUST_PROXY: false,
      MAX_BODY_BYTES: 1024,
      REQUEST_TIMEOUT_MS: 1000,
      STREAM_IDLE_TIMEOUT_MS: 1000,
      DEFAULT_RATE_LIMIT_RPM: 100,
      DEFAULT_MONTHLY_SPEND_USD: 100,
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      corsOrigins: ["http://127.0.0.1:8080"],
    } as AppConfig;
    const database = {
      query: async (sql: string) => {
        if (sql.includes("SELECT * FROM providers")) {
          return {
            rows: [
              {
                slug: "persisted",
                kind: "openai-compatible",
                base_url: "https://example.invalid/v1",
                encrypted_credentials: "not.valid.ciphertext",
                config: {},
              },
            ],
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Database;

    await expect(
      buildApp({ config, db: database, skipBootstrap: true }),
    ).rejects.toThrow();
  });

  it("restores enabled custom providers that do not require credentials", async () => {
    const config = {
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: 8080,
      DATABASE_URL: "postgres://unused",
      DATABASE_POOL_MAX: 1,
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      BOOTSTRAP_ADMIN_EMAIL: "admin@example.local",
      BOOTSTRAP_ADMIN_PASSWORD: "unused-strong-password",
      SESSION_SECRET: "unused-session-secret-with-thirty-two-characters",
      CORS_ORIGINS: "http://127.0.0.1:8080",
      SESSION_COOKIE_SECURE: false,
      TRUST_PROXY: false,
      MAX_BODY_BYTES: 1024,
      REQUEST_TIMEOUT_MS: 1000,
      STREAM_IDLE_TIMEOUT_MS: 1000,
      DEFAULT_RATE_LIMIT_RPM: 100,
      DEFAULT_MONTHLY_SPEND_USD: 100,
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      corsOrigins: ["http://127.0.0.1:8080"],
    } as AppConfig;
    const database = {
      query: async (sql: string) => {
        if (sql.includes("SELECT * FROM providers")) {
          return {
            rows: [
              {
                id: "provider-id",
                slug: "custom-local",
                kind: "openai-compatible",
                base_url: "http://custom.invalid/v1",
                config: {},
              },
            ],
          };
        }
        if (sql.includes("SELECT m.*")) return { rows: [] };
        if (sql.includes("SELECT * FROM routing_policies")) return { rows: [] };
        if (sql.includes("SELECT default_routing_mode")) return { rows: [] };
        throw new Error(`Unexpected query: ${sql}`);
      },
    } as unknown as Database;

    const built = await buildApp({ config, db: database, skipBootstrap: true });
    expect(built.services.providers.get("custom-local").id).toBe(
      "custom-local",
    );
    await built.app.close();
  });
});
