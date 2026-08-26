import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import { ScopedRateLimitService } from "./rate-limit.js";

describe("scoped rate limits", () => {
  it("enforces a configured zero request limit", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          { id: "policy", subject_type: "global", requests_per_minute: 0 },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ request_count: 1, token_count: 0 }] });
    const database = { query } as unknown as Database;

    await expect(
      new ScopedRateLimitService(database).consume({}),
    ).rejects.toMatchObject({
      shape: { code: "gateway_rate_limit" },
    });
  });
});
