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
      MASTER_ENCRYPTION_KEY: "a-master-key-with-at-least-thirty-two-characters",
    };

    expect(loadConfig().NODE_ENV).toBe("production");
  });

  it("keeps development defaults available for local development", () => {
    process.env = { NODE_ENV: "development" };
    expect(loadConfig().BOOTSTRAP_ADMIN_PASSWORD).toBe(
      "change-this-immediately",
    );
  });
});
