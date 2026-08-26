import { describe, expect, it } from "vitest";
import { normalizeUnknownError } from "./errors.js";

describe("error normalization", () => {
  it("preserves framework client status codes", () => {
    const error = normalizeUnknownError({
      statusCode: 415,
      code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      message: "Unsupported Media Type",
    });

    expect(error.shape).toMatchObject({
      status: 415,
      type: "client",
      retryable: false,
      code: "FST_ERR_CTP_INVALID_MEDIA_TYPE",
    });
  });

  it("does not leak unknown internal error messages", () => {
    const error = normalizeUnknownError(
      new Error("database password leaked here"),
    );
    expect(error.shape.message).toBe("Internal gateway error");
  });
});
