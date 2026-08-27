import pg, { type QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";

type DatabaseConfig = Pick<
  AppConfig,
  | "DATABASE_URL"
  | "DATABASE_POOL_MAX"
  | "DATABASE_CONNECTION_TIMEOUT_MS"
  | "DATABASE_STATEMENT_TIMEOUT_MS"
>;

export class Database {
  readonly pool: pg.Pool;

  constructor(config: DatabaseConfig) {
    this.pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: config.DATABASE_POOL_MAX,
      connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
      statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
      application_name: "self-hosted-ai-gateway",
    });
  }

  query<T extends QueryResultRow = any>(text: string, params?: any[]) {
    return this.pool.query<T>(text, params);
  }

  async health() {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    await this.pool.end();
  }
}
