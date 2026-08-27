import crypto from "node:crypto";
import type { Database } from "../db/index.js";
import { GatewayError } from "../core/errors.js";

export type Reservation = { id: string; budgetIds: string[] } | undefined;

export class BudgetService {
  constructor(private db: Database) {}

  async reserve(value: {
    userId?: string;
    apiKeyId?: string;
    estimatedTokens: number;
    estimatedCostUsd: number;
  }): Promise<Reservation> {
    const client = await this.db.pool.connect();
    try {
      await client.query("BEGIN");
      const budgets = await client.query<any>(
        `SELECT * FROM budgets WHERE enabled AND
        (subject_type='global' OR (subject_type='user' AND subject_id=$1) OR
        (subject_type='api_key' AND subject_id=$2)) FOR UPDATE`,
        [value.userId ?? null, value.apiKeyId ?? null],
      );
      const reservationIds: string[] = [];
      for (const budget of budgets.rows) {
        const daily = await this.usage(
          client,
          budget.subject_type,
          value,
          "date_trunc('day',now())",
        );
        const monthly = await this.usage(
          client,
          budget.subject_type,
          value,
          "date_trunc('month',now())",
        );
        const pending = await client.query<any>(
          `SELECT COALESCE(sum(estimated_tokens),0)::bigint tokens,
          COALESCE(sum(estimated_cost_usd),0)::numeric cost
          FROM budget_reservations WHERE budget_id=$1 AND state='reserved'`,
          [budget.id],
        );
        const pendingTokens = Number(pending.rows[0].tokens);
        const pendingCost = Number(pending.rows[0].cost);
        this.checkLimit(
          budget.daily_token_limit,
          Number(daily.rows[0].tokens) + pendingTokens + value.estimatedTokens,
          "budget_daily_tokens_exceeded",
          "Daily token budget exceeded",
        );
        this.checkLimit(
          budget.daily_spend_limit_usd,
          Number(daily.rows[0].cost) + pendingCost + value.estimatedCostUsd,
          "budget_daily_spend_exceeded",
          "Daily spend budget exceeded",
        );
        this.checkLimit(
          budget.monthly_token_limit,
          Number(monthly.rows[0].tokens) +
            pendingTokens +
            value.estimatedTokens,
          "budget_tokens_exceeded",
          "Monthly token budget exceeded",
        );
        this.checkLimit(
          budget.monthly_spend_limit_usd,
          Number(monthly.rows[0].cost) + pendingCost + value.estimatedCostUsd,
          "budget_spend_exceeded",
          "Monthly spend budget exceeded",
        );
        const reservation = await client.query<{ id: string }>(
          `INSERT INTO budget_reservations(
            budget_id,user_id,api_key_id,estimated_tokens,estimated_cost_usd
          ) VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [
            budget.id,
            value.userId ?? null,
            value.apiKeyId ?? null,
            value.estimatedTokens,
            value.estimatedCostUsd,
          ],
        );
        reservationIds.push(reservation.rows[0]!.id);
      }
      await client.query("COMMIT");
      return reservationIds.length
        ? { id: crypto.randomUUID(), budgetIds: reservationIds }
        : undefined;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private usage(client: any, subjectType: string, value: any, start: string) {
    return client.query(
      `SELECT COALESCE(sum(input_tokens+output_tokens),0)::bigint tokens,
      COALESCE(sum(estimated_cost_usd),0)::numeric cost FROM usage_records
      WHERE created_at>=${start} AND (($1='global') OR
      ($1='user' AND user_id=$2) OR ($1='api_key' AND api_key_id=$3))`,
      [subjectType, value.userId ?? null, value.apiKeyId ?? null],
    );
  }

  private checkLimit(
    configured: unknown,
    actual: number,
    code: string,
    message: string,
  ) {
    if (
      configured !== null &&
      configured !== undefined &&
      actual > Number(configured)
    ) {
      throw new GatewayError({
        code,
        message,
        type: "budget",
        retryable: false,
        status: 402,
      });
    }
  }

  async settle(reservation: Reservation) {
    if (!reservation) return;
    await this.db.query(
      "UPDATE budget_reservations SET state='settled',settled_at=now() WHERE id=ANY($1::uuid[])",
      [reservation.budgetIds],
    );
  }

  async release(reservation: Reservation) {
    if (!reservation) return;
    await this.db.query(
      "UPDATE budget_reservations SET state='released',settled_at=now() WHERE id=ANY($1::uuid[])",
      [reservation.budgetIds],
    );
  }
}
