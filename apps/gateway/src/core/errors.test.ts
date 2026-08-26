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

  it("maps platform timeout errors to a gateway timeout", () => {
    const error = normalizeUnknownError(
      new DOMException("timed out", "TimeoutError"),
    );
    expect(error.shape).toMatchObject({
      code: "request_timeout",
      type: "timeout",
      status: 504,
      retryable: true,
    });
  });
});
