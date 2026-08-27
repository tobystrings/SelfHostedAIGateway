import type { ChatRequest, GatewayModel } from "../core/types.js";
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

  constructor(
    private models: ModelRegistry,
    private providers: ProviderRegistry,
  ) {}

  setPolicies(policies: RoutingPolicy[]) {
    this.policies = policies;
  }

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
      throw new GatewayError({
        code: "no_route",
        message: "No compatible model is currently routable",
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
        mode: request.provider || request.model ? "explicit" : "automatic",
        policies: matchedPolicies.map((policy) => policy.name).filter(Boolean),
        candidates: candidates.map((model) => `${model.provider}/${model.id}`),
      },
    };
  }
}
