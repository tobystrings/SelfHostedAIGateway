import crypto from "node:crypto";
import type { ProviderAdapter } from "../core/provider.js";
import type { GatewayModel, VerificationStatus } from "../core/types.js";
import { normalizeUnknownError } from "../core/errors.js";

export interface ModelVerificationResult {
  status: VerificationStatus;
  errorCategory: string | null;
  callable: boolean | null | undefined;
}

export async function verifyModelInvocation(
  adapter: ProviderAdapter,
  model: GatewayModel,
  signal: AbortSignal,
): Promise<ModelVerificationResult> {
  try {
    const context = { signal, requestId: crypto.randomUUID() };
    if (model.capabilities.embeddings && model.capabilities.textOutput !== true) {
      await adapter.embeddings({ provider: model.provider, model: model.id, input: "verification" }, context);
    } else if (model.capabilities.textInput !== false && model.capabilities.textOutput === true) {
      await adapter.chat({ provider: model.provider, model: model.id, messages: [{ role: "user", content: "Reply OK" }], maxOutputTokens: 1 }, context);
    } else {
      return { status: "unsupported_verification", errorCategory: "unsupported_capability", callable: model.callable };
    }
    return { status: "verified", errorCategory: null, callable: true };
  } catch (error) {
    const normalized = normalizeUnknownError(error, model.provider);
    if (normalized.shape.status === 401 || normalized.shape.status === 403) return { status: "unauthorized", errorCategory: normalized.shape.code, callable: false };
    if (normalized.shape.status === 429) return { status: "rate_limited", errorCategory: normalized.shape.code, callable: model.callable };
    if (normalized.shape.status === 404) return { status: "unavailable", errorCategory: normalized.shape.code, callable: false };
    if (normalized.shape.type === "client") return { status: "unsupported_verification", errorCategory: normalized.shape.code, callable: model.callable };
    return { status: "unavailable", errorCategory: normalized.shape.code, callable: model.callable };
  }
}
