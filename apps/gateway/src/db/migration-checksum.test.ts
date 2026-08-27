import { describe, expect, it } from "vitest";
import { migrationChecksum } from "./migration-checksum.js";

describe("migration checksums", () => {
  it("are stable across Unix and Windows line endings", () => {
    expect(migrationChecksum("SELECT 1;\nSELECT 2;\n")).toBe(
      migrationChecksum("SELECT 1;\r\nSELECT 2;\r\n"),
    );
  });
});
