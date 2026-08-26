export type ErrorType =
  | "client"
  | "auth"
  | "rate_limit"
  | "budget"
  | "provider"
  | "timeout"
  | "unavailable"
  | "internal";
export interface GatewayErrorShape {
  code: string;
  message: string;
  type: ErrorType;
  retryable: boolean;
  status: number;
  provider?: string;
  metadata?: Record<string, unknown>;
}
export class GatewayError extends Error {
  constructor(public readonly shape: GatewayErrorShape) {
    super(shape.message);
    this.name = "GatewayError";
  }
}
export function normalizeUnknownError(
  e: unknown,
  provider?: string,
): GatewayError {
  if (e instanceof GatewayError) return e;
  if (e instanceof DOMException && e.name === "AbortError")
    return new GatewayError({
      code: "cancelled",
      message: "Request cancelled",
      type: "timeout",
      retryable: false,
      status: 499,
      provider,
    });
  const any = e as any;
  const status = Number(any?.status || any?.statusCode || 0);
  if (status === 429)
    return new GatewayError({
      code: "provider_rate_limited",
      message: "Upstream provider rate limited the request",
      type: "rate_limit",
      retryable: true,
      status: 429,
      provider,
      metadata: { retryAfterMs: any?.retryAfterMs },
    });
  if (status >= 400 && status < 500)
    return new GatewayError({
      code: any?.code || "invalid_request",
      message: any?.message || "Invalid request",
      type: "client",
      retryable: false,
      status,
      provider,
    });
  if (status >= 500)
    return new GatewayError({
      code: "provider_unavailable",
      message: "Upstream provider unavailable",
      type: "provider",
      retryable: true,
      status: 502,
      provider,
    });
  return new GatewayError({
    code: "internal_error",
    message: "Internal gateway error",
    type: "internal",
    retryable: false,
    status: 500,
    provider,
  });
}
