import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.js";
import { Database } from "./index.js";
import { migrationChecksum } from "./migration-checksum.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(here, "../../../../migrations");
const database = new Database(loadConfig());
const client = await database.pool.connect();

try {
  await client.query(
    "SELECT pg_advisory_lock(hashtext('self-hosted-ai-gateway:migrations'))",
  );
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations(
      name text PRIMARY KEY,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  await client.query(
    "ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text",
  );

  const names = fs
    .readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    const sql = fs.readFileSync(path.join(migrationsDirectory, name), "utf8");
    const checksum = migrationChecksum(sql);
    const seen = await client.query<{ checksum: string | null }>(
      "SELECT checksum FROM schema_migrations WHERE name=$1",
      [name],
    );
    if (seen.rowCount) {
      const recorded = seen.rows[0]?.checksum;
      if (recorded && recorded !== checksum) {
        throw new Error(
          `Applied migration ${name} has changed (expected ${recorded}, found ${checksum})`,
        );
      }
      if (!recorded) {
        await client.query(
          "UPDATE schema_migrations SET checksum=$2 WHERE name=$1",
          [name, checksum],
        );
      }
      continue;
    }

    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)",
        [name, checksum],
      );
      await client.query("COMMIT");
      console.log("applied", name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  try {
    await client.query(
      "SELECT pg_advisory_unlock(hashtext('self-hosted-ai-gateway:migrations'))",
    );
  } finally {
    client.release();
    await database.close();
  }
}
