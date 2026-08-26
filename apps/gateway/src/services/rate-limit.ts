import type { Database } from "../db/index.js";
import { GatewayError } from "../core/errors.js";

export class ScopedRateLimitService {
  constructor(private db: Database) {}

  async consume(value: any) {
    const policies = await this.db.query<any>(
      "SELECT * FROM rate_limit_policies WHERE enabled",
    );
    for (const policy of policies.rows) {
      let subjectValue = "global";
      if (policy.subject_type === "api_key") {
        if (!value.apiKeyId) continue;
        subjectValue = value.apiKeyId;
      } else if (policy.subject_type === "user") {
        if (!value.userId) continue;
        subjectValue = value.userId;
      } else if (policy.subject_type === "provider") {
        if (!value.provider) continue;
        subjectValue = value.provider;
      } else if (policy.subject_type === "model") {
        if (!value.model) continue;
        subjectValue = value.model;
      }
      if (policy.subject_value && policy.subject_value !== subjectValue)
        continue;
      const bucket = new Date(Math.floor(Date.now() / 60_000) * 60_000);
      const counter = await this.db.query<any>(
        `INSERT INTO rate_limit_counters(
          bucket_start,policy_id,subject_value,request_count,token_count
        ) VALUES($1,$2,$3,1,$4)
        ON CONFLICT(bucket_start,policy_id,subject_value) DO UPDATE SET
          request_count=rate_limit_counters.request_count+1,
          token_count=rate_limit_counters.token_count+$4 RETURNING *`,
        [bucket, policy.id, subjectValue, value.estimatedTokens ?? 0],
      );
      if (
        policy.requests_per_minute !== null &&
        policy.requests_per_minute !== undefined &&
        counter.rows[0].request_count > Number(policy.requests_per_minute)
      ) {
        throw new GatewayError({
          code: "gateway_rate_limit",
          message: "Gateway request rate limit exceeded",
          type: "rate_limit",
          retryable: true,
          status: 429,
        });
      }
      if (
        policy.tokens_per_minute !== null &&
        policy.tokens_per_minute !== undefined &&
        Number(counter.rows[0].token_count) > Number(policy.tokens_per_minute)
      ) {
        throw new GatewayError({
          code: "gateway_token_rate_limit",
          message: "Gateway token rate limit exceeded",
          type: "rate_limit",
          retryable: true,
          status: 429,
        });
      }
    }
  }
}
