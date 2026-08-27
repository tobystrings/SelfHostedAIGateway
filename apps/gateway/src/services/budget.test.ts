import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/index.js";
import { BudgetService } from "./budget.js";

function databaseWithBudget(budget: Record<string, unknown>) {
  const query = vi.fn(async (sql: string) => {
    if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT")
      return { rows: [] };
    if (sql.includes("FROM budgets"))
      return { rows: [{ id: "budget-1", subject_type: "global", ...budget }] };
    if (sql.includes("FROM usage_records"))
      return { rows: [{ tokens: "0", cost: "0" }] };
    if (sql.includes("FROM budget_reservations"))
      return { rows: [{ tokens: "0", cost: "0" }] };
    if (sql.includes("INSERT INTO budget_reservations"))
      return { rows: [{ id: "reservation-1" }] };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return {
    database: {
      pool: { connect: vi.fn(async () => client) },
    } as unknown as Database,
    query,
  };
}

describe("budget enforcement", () => {
  it("enforces daily token limits", async () => {
    const { database } = databaseWithBudget({ daily_token_limit: "5" });
    await expect(
      new BudgetService(database).reserve({
        estimatedTokens: 6,
        estimatedCostUsd: 0,
      }),
    ).rejects.toMatchObject({
      shape: { code: "budget_daily_tokens_exceeded" },
    });
  });

  it("treats a configured zero limit as a real limit", async () => {
    const { database } = databaseWithBudget({ monthly_spend_limit_usd: "0" });
    await expect(
      new BudgetService(database).reserve({
        estimatedTokens: 0,
        estimatedCostUsd: 0.01,
      }),
    ).rejects.toMatchObject({ shape: { code: "budget_spend_exceeded" } });
  });
});
