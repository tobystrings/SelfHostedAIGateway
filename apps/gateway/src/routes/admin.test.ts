import { describe, expect, it } from "vitest";
import { publicProviderConfig } from "./admin.js";

describe("provider configuration disclosure", () => {
  it("removes headers and redacts nested credential-like fields", () => {
    expect(
      publicProviderConfig({
        region: "local",
        headers: { Authorization: "Bearer secret" },
        nested: { accessToken: "secret", harmless: true },
      }),
    ).toEqual({
      region: "local",
      nested: { accessToken: "[REDACTED]", harmless: true },
    });
  });
});
