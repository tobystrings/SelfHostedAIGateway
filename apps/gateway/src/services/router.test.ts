import { describe, it, expect } from "vitest";
import { RoutingEngine } from "./router.js";
import { ModelRegistry } from "./model-registry.js";
import { ProviderRegistry } from "./provider-registry.js";
describe("router", () => {
  it("filters tools capability", () => {
    const m = new ModelRegistry();
    m.setMany([
      {
        provider: "p",
        id: "plain",
        enabled: true,
        capabilities: { textInput: true },
      },
      {
        provider: "p",
        id: "tools",
        enabled: true,
        capabilities: { toolCalling: true },
      },
    ]);
    const r = new RoutingEngine(m, new ProviderRegistry());
    expect(
      r.route({ messages: [], tools: [{ name: "x", parameters: {} }] }).model,
    ).toBe("tools");
  });

  it("does not route embedding-only models into chat", () => {
    const models = new ModelRegistry();
    models.setMany([
      {
        provider: "gemini",
        id: "gemini-embedding-001",
        enabled: true,
        capabilities: {
          textInput: true,
          textOutput: false,
          embeddings: true,
        },
        metadata: { routingPriority: 1 },
      },
      {
        provider: "gemini",
        id: "gemini-3.7-flash",
        enabled: true,
        capabilities: {
          textInput: true,
          textOutput: true,
          embeddings: false,
        },
        metadata: { routingPriority: 100 },
      },
    ]);

    const router = new RoutingEngine(models, new ProviderRegistry());
    expect(router.route({ messages: [] }).model).toBe("gemini-3.7-flash");
    expect(() =>
      router.route({ messages: [], model: "gemini-embedding-001" }),
    ).toThrow(/No compatible model/);
  });
});

describe("routing policies", () => {
  it("only applies actions when the policy match is satisfied", () => {
    const models = new ModelRegistry();
    models.setMany([
      {
        provider: "primary",
        id: "standard",
        enabled: true,
        capabilities: { toolCalling: true },
        metadata: { routingPriority: 1 },
      },
      {
        provider: "special",
        id: "vision",
        enabled: true,
        capabilities: { toolCalling: true },
        metadata: { routingPriority: 50 },
      },
    ]);
    const router = new RoutingEngine(models, new ProviderRegistry());
    router.setPolicies([
      {
        name: "special-model",
        match: { model: "vision" },
        action: { provider: "special" },
      },
    ]);

    expect(router.route({ messages: [] }).provider).toBe("primary");
    expect(router.route({ messages: [], model: "vision" }).provider).toBe(
      "special",
    );
  });

  it("keeps a matched model preference ahead of ordinary routing priority", () => {
    const models = new ModelRegistry();
    models.setMany([
      {
        provider: "p",
        id: "cheap",
        enabled: true,
        capabilities: { toolCalling: true },
        metadata: { routingPriority: 1 },
      },
      {
        provider: "p",
        id: "preferred",
        enabled: true,
        capabilities: { toolCalling: true },
        metadata: { routingPriority: 100 },
      },
    ]);
    const router = new RoutingEngine(models, new ProviderRegistry());
    router.setPolicies([
      {
        name: "prefer-tools",
        match: { hasTools: true },
        action: { model: "preferred" },
      },
    ]);

    expect(
      router.route({ messages: [], tools: [{ name: "x", parameters: {} }] })
        .model,
    ).toBe("preferred");
  });
});

describe("control-plane routing modes", () => {
  const model = (id: string, costClassification: "free"|"paid"|"local"|"unknown", priority: number, extra: any = {}) => ({
    provider: costClassification === "local" ? "ollama" : "cloud",
    id, enabled: true, capabilities: { textInput: true, textOutput: true, ...extra.capabilities },
    costClassification, callable: extra.callable, pricing: extra.pricing,
    metadata: { routingPriority: priority },
  });

  it("never permits paid or unknown fallback in FREE_ONLY", () => {
    const models = new ModelRegistry();
    models.setMany([model("paid", "paid", 1), model("mystery", "unknown", 2)]);
    const router = new RoutingEngine(models, new ProviderRegistry());
    expect(() => router.route({ messages: [], routingMode: "FREE_ONLY" })).toThrow(/prevented paid or unknown fallback/);
  });

  it("supports free, local-only, and cheapest compatible selection", () => {
    const models = new ModelRegistry();
    models.setMany([
      model("paid", "paid", 1, { pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 3 } }),
      model("free", "free", 50),
      model("local", "local", 100),
    ]);
    const router = new RoutingEngine(models, new ProviderRegistry());
    expect(router.route({ messages: [], routingMode: "FREE_ONLY" }).model).toBe("free");
    expect(router.route({ messages: [], routingMode: "LOCAL_ONLY" }).model).toBe("local");
    expect(router.route({ messages: [], routingMode: "CHEAPEST" }).model).toBe("free");
  });

  it("keeps CHEAPEST authoritative over a model preference", () => {
    const models = new ModelRegistry();
    models.setMany([
      model("expensive", "paid", 1, { pricing: { inputPerMillionUsd: 10, outputPerMillionUsd: 10 } }),
      model("cheap", "paid", 100, { pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 1 } }),
    ]);
    const router = new RoutingEngine(models, new ProviderRegistry());
    router.setPolicies([{ name: "legacy-preference", match: {}, action: { model: "expensive" } }]);
    expect(router.route({ messages: [], routingMode: "CHEAPEST" }).model).toBe("cheap");
  });

  it("requires image capability and excludes known unavailable models", () => {
    const models = new ModelRegistry();
    models.setMany([
      model("cheap-text", "free", 1),
      model("dead-vision", "free", 2, { callable: false, capabilities: { imageInput: true } }),
      model("vision", "paid", 50, { capabilities: { imageInput: true } }),
    ]);
    const router = new RoutingEngine(models, new ProviderRegistry());
    const request = { messages: [{ role: "user" as const, content: [{ type: "image" as const, base64: "AA==", mimeType: "image/png" }] }] };
    expect(router.route(request).model).toBe("vision");
    expect(() => router.route({ ...request, model: "dead-vision" })).toThrow(/known to be unavailable/);
  });
});
