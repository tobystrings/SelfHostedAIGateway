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
