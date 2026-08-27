import type { ChatRequest, GatewayModel, RoutingMode } from "../core/types.js";
import { GatewayError } from "../core/errors.js";
import { CircuitBreaker } from "../core/circuit.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ProviderRegistry } from "./provider-registry.js";

export interface RouteDecision {
  provider: string;
  model: string;
  candidates: GatewayModel[];
  reason: Record<string, unknown>;
}

type RoutingPolicy = {
  name?: string;
  match?: {
    provider?: string;
    model?: string;
    stream?: boolean;
    hasTools?: boolean;
    structuredOutput?: boolean;
  };
  action?: { provider?: string; model?: string };
};

function policyMatches(policy: RoutingPolicy, request: ChatRequest) {
  const match = policy.match ?? {};
  if (match.provider !== undefined && match.provider !== request.provider)
    return false;
  if (match.model !== undefined && match.model !== request.model) return false;
  if (match.stream !== undefined && match.stream !== Boolean(request.stream))
    return false;
  if (
    match.hasTools !== undefined &&
    match.hasTools !== Boolean(request.tools?.length)
  )
    return false;
  if (
    match.structuredOutput !== undefined &&
    match.structuredOutput !== Boolean(request.structuredOutput)
  )
    return false;
  return true;
}

export class RoutingEngine {
  private breakers = new Map<string, CircuitBreaker>();
  private policies: RoutingPolicy[] = [];
  private defaultMode: RoutingMode = "NORMAL";

  constructor(
    private models: ModelRegistry,
    private providers: ProviderRegistry,
  ) {}

  setPolicies(policies: RoutingPolicy[]) {
    this.policies = policies;
  }

  setDefaultMode(mode: RoutingMode) { this.defaultMode = mode; }
  getDefaultMode() { return this.defaultMode; }

  breaker(provider: string) {
    let breaker = this.breakers.get(provider);
    if (!breaker) {
      breaker = new CircuitBreaker();
      this.breakers.set(provider, breaker);
    }
    return breaker;
  }

  route(
    request: ChatRequest,
    allowedProviders?: string[],
    allowedModels?: string[],
  ): RouteDecision {
    const explicit = Boolean(request.provider || request.model);
    const explicitModel = Boolean(request.model);
    const mode = request.routingMode ?? this.defaultMode;
    if (!["NORMAL", "FREE_ONLY", "LOCAL_ONLY", "CHEAPEST"].includes(mode)) {
      throw new GatewayError({ code: "invalid_routing_mode", message: "Invalid routing mode", type: "client", retryable: false, status: 400 });
    }
    const hasImages = request.messages.some((message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === "image"),
    );
    let candidates = this.models
      .list()
      .filter(
        (model) =>
          model.enabled &&
          model.capabilities.textInput !== false &&
          model.capabilities.textOutput !== false &&
          !this.breaker(model.provider).isOpen(),
      );
    if (allowedProviders?.length) {
      candidates = candidates.filter((model) =>
        allowedProviders.includes(model.provider),
      );
    }
    if (allowedModels?.length) {
      candidates = candidates.filter(
        (model) =>
          allowedModels.includes(model.id) ||
          allowedModels.includes(`${model.provider}/${model.id}`),
      );
    }
    if (request.provider) {
      candidates = candidates.filter(
        (model) => model.provider === request.provider,
      );
    }
    if (request.model) {
      candidates = candidates.filter(
        (model) =>
          model.id === request.model ||
          model.metadata?.alias === request.model ||
          `${model.provider}/${model.id}` === request.model,
      );
    }
    if (request.tools?.length) {
      candidates = candidates.filter((model) => model.capabilities.toolCalling);
    }
    if (request.structuredOutput) {
      candidates = candidates.filter(
        (model) => model.capabilities.structuredOutput,
      );
    }
    if (request.stream) {
      candidates = candidates.filter(
        (model) => model.capabilities.streaming !== false,
      );
    }
    if (explicitModel && candidates.some((model) => model.callable === false)) {
      throw new GatewayError({
        code: "model_unavailable",
        message: "The explicitly requested model is known to be unavailable",
        type: "unavailable",
        retryable: false,
        status: 503,
      });
    }
    candidates = candidates.filter((model) => model.callable !== false);
    if (hasImages) {
      candidates = candidates.filter((model) => model.capabilities.imageInput === true);
    }
    if (mode === "FREE_ONLY") {
      candidates = candidates.filter((model) =>
        model.costClassification === "free" || model.costClassification === "local",
      );
    } else if (mode === "LOCAL_ONLY") {
      candidates = candidates.filter((model) => model.costClassification === "local");
    }

    const matchedPolicies = this.policies.filter((policy) =>
      policyMatches(policy, request),
    );
    const providerPolicy = matchedPolicies.find(
      (policy) => policy.action?.provider,
    );
    if (providerPolicy?.action?.provider) {
      candidates = candidates.filter(
        (model) => model.provider === providerPolicy.action!.provider,
      );
    }
    const preferredModel = matchedPolicies.find(
      (policy) => policy.action?.model,
    )?.action?.model;
    candidates.sort((left, right) => {
      if (mode === "CHEAPEST") {
        const price = (model: GatewayModel) => {
          if (model.costClassification === "free" || model.costClassification === "local") return 0;
          if (!model.pricing) return Number.POSITIVE_INFINITY;
          return model.pricing.inputPerMillionUsd + model.pricing.outputPerMillionUsd;
        };
        const priceDifference = price(left) - price(right);
        if (priceDifference) return priceDifference;
      }
      if (preferredModel) {
        const leftPreferred =
          left.id === preferredModel || left.metadata?.alias === preferredModel;
        const rightPreferred =
          right.id === preferredModel ||
          right.metadata?.alias === preferredModel;
        if (leftPreferred !== rightPreferred) return leftPreferred ? -1 : 1;
      }
      return (
        Number(left.metadata?.routingPriority ?? 100) -
        Number(right.metadata?.routingPriority ?? 100)
      );
    });

    if (!candidates.length) {
      const message = mode === "FREE_ONLY"
        ? "No free or local compatible model is routable; FREE_ONLY prevented paid or unknown fallback"
        : mode === "LOCAL_ONLY"
          ? "No compatible local model is routable"
          : hasImages
            ? "No image-capable model is currently routable"
            : "No compatible model is currently routable";
      throw new GatewayError({
        code: "no_route",
        message,
        type: "unavailable",
        retryable: true,
        status: 503,
      });
    }
    return {
      provider: candidates[0]!.provider,
      model: candidates[0]!.id,
      candidates,
      reason: {
        mode,
        selection: explicit ? "explicit" : "automatic",
        policies: matchedPolicies.map((policy) => policy.name).filter(Boolean),
        candidates: candidates.map((model) => `${model.provider}/${model.id}`),
      },
    };
  }
}
