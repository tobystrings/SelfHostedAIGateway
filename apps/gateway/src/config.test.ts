import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe("production configuration", () => {
  it("rejects missing and known-default secrets", () => {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://gateway:change-me-now@postgres:5432/gateway",
      BOOTSTRAP_ADMIN_PASSWORD: "change-this-immediately",
      SESSION_SECRET: "development-only-session-secret-change-me",
      MASTER_ENCRYPTION_KEY: "",
    };

    expect(() => loadConfig()).toThrow(/strong, non-default|known default/);
  });

  it("accepts strong production secrets", () => {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: "production",
      DATABASE_URL:
        "postgres://gateway:a-long-random-database-password@postgres:5432/gateway",
      BOOTSTRAP_ADMIN_PASSWORD: "a-long-random-admin-password",
      SESSION_SECRET: "a-session-secret-with-at-least-thirty-two-characters",
      MASTER_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    };

    expect(loadConfig().NODE_ENV).toBe("production");
  });

  it("rejects a malformed encryption key even when it is long", () => {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: "production",
      DATABASE_URL:
        "postgres://gateway:a-long-random-database-password@postgres:5432/gateway",
      BOOTSTRAP_ADMIN_PASSWORD: "a-long-random-admin-password",
      SESSION_SECRET: "a-session-secret-with-at-least-thirty-two-characters",
      MASTER_ENCRYPTION_KEY:
        "this-is-long-enough-but-not-a-valid-32-byte-base64-key",
    };

    expect(() => loadConfig()).toThrow(/base64 encoding of exactly 32 bytes/);
  });

  it("keeps development defaults available for local development", () => {
    process.env = { NODE_ENV: "development" };
    expect(loadConfig().BOOTSTRAP_ADMIN_PASSWORD).toBe(
      "change-this-immediately",
    );
  });
});
