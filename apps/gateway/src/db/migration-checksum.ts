import crypto from "node:crypto";

export function migrationChecksum(sql: string) {
  return crypto
    .createHash("sha256")
    .update(sql.replace(/\r\n/g, "\n"))
    .digest("hex");
}
