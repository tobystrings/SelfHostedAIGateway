import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "../core/errors.js";
import type { ProviderAdapter } from "../core/provider.js";
import type { ChatResponse } from "../core/types.js";
import { ModelRegistry } from "./model-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
import { RoutingEngine } from "./router.js";
import { GatewayService } from "./gateway.js";

function response(provider: string): ChatResponse {
  return {
    id: "response",
    provider,
    model: "model",
    message: { role: "assistant", content: "ok" },
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  };
}

function adapter(id: string, chat: ProviderAdapter["chat"]): ProviderAdapter {
  return {
    id,
    kind: "test",
    chat,
    async discoverModels() {
      return [];
    },
    async *streamChat() {},
    async embeddings() {
      throw new Error("unused");
    },
    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}

describe("gateway retry and fallback", () => {
  it("retries retryable failures before falling back to the next candidate", async () => {
    const firstChat = vi.fn(async () => {
      throw new GatewayError({
        code: "upstream_unavailable",
        message: "unavailable",
        type: "provider",
        retryable: true,
        status: 502,
      });
    });
    const secondChat = vi.fn(async () => response("second"));
    const providers = new ProviderRegistry([
      adapter("first", firstChat),
      adapter("second", secondChat),
    ]);
    const models = new ModelRegistry();
    models.setMany([
      {
        provider: "first",
        id: "model",
        enabled: true,
        capabilities: {},
        metadata: { routingPriority: 1 },
      },
      {
        provider: "second",
        id: "model",
        enabled: true,
        capabilities: {},
        metadata: { routingPriority: 2 },
      },
    ]);
    const gateway = new GatewayService(
      providers,
      models,
      new RoutingEngine(models, providers),
    );

    const result = await gateway.chat({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(firstChat).toHaveBeenCalledTimes(3);
    expect(secondChat).toHaveBeenCalledTimes(1);
    expect(result.decision).toMatchObject({
      provider: "second",
      reason: { fallbackIndex: 1, retry: 0 },
    });
  });

  it("does not retry or fall back for non-retryable failures", async () => {
    const firstChat = vi.fn(async () => {
      throw new GatewayError({
        code: "bad_request",
        message: "bad request",
        type: "client",
        retryable: false,
        status: 400,
      });
    });
    const secondChat = vi.fn(async () => response("second"));
    const providers = new ProviderRegistry([
      adapter("first", firstChat),
      adapter("second", secondChat),
    ]);
    const models = new ModelRegistry();
    models.setMany([
      {
        provider: "first",
        id: "model",
        enabled: true,
        capabilities: {},
        metadata: { routingPriority: 1 },
      },
      {
        provider: "second",
        id: "model",
        enabled: true,
        capabilities: {},
        metadata: { routingPriority: 2 },
      },
    ]);
    const gateway = new GatewayService(
      providers,
      models,
      new RoutingEngine(models, providers),
    );

    await expect(gateway.chat({ messages: [] })).rejects.toMatchObject({
      shape: { code: "bad_request" },
    });
    expect(firstChat).toHaveBeenCalledTimes(1);
    expect(secondChat).not.toHaveBeenCalled();
  });
});

describe("embedding routing modes", () => {
  it("enforces FREE_ONLY without paid fallback", async () => {
    const providers = new ProviderRegistry([adapter("paid", async () => response("paid"))]);
    const models = new ModelRegistry();
    models.setMany([{ provider: "paid", id: "embed", enabled: true, capabilities: { embeddings: true }, costClassification: "paid" }]);
    const gateway = new GatewayService(providers, models, new RoutingEngine(models, providers));
    await expect(gateway.embeddings({ input: "x", routingMode: "FREE_ONLY" })).rejects.toMatchObject({ shape: { code: "embedding_route_not_found" } });
  });

  it("chooses the cheapest compatible embedding model", async () => {
    const called: string[] = [];
    const embeddingAdapter = (id: string): ProviderAdapter => ({
      ...adapter(id, async () => response(id)),
      async embeddings(req) { called.push(id); return { provider: id, model: req.model ?? "", data: [{ index: 0, embedding: [1] }], usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } }; },
    });
    const providers = new ProviderRegistry([embeddingAdapter("expensive"), embeddingAdapter("cheap")]);
    const models = new ModelRegistry();
    models.setMany([
      { provider: "expensive", id: "embed", enabled: true, capabilities: { embeddings: true }, costClassification: "paid", pricing: { inputPerMillionUsd: 5, outputPerMillionUsd: 0 }, metadata: { routingPriority: 1 } },
      { provider: "cheap", id: "embed", enabled: true, capabilities: { embeddings: true }, costClassification: "paid", pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 0 }, metadata: { routingPriority: 100 } },
    ]);
    const gateway = new GatewayService(providers, models, new RoutingEngine(models, providers));
    await gateway.embeddings({ input: "x", routingMode: "CHEAPEST" });
    expect(called).toEqual(["cheap"]);
  });
});
