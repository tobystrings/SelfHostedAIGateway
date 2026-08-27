import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { normalizeUnknownError } from "../core/errors.js";
import { ModelRegistry } from "../services/model-registry.js";
import type { GatewayService } from "../services/gateway.js";
import { registerOpenAiRoutes } from "./openai.js";

describe("OpenAI-compatible request cancellation", () => {
  it("aborts a stalled upstream request at the configured deadline", async () => {
    const app = Fastify({ logger: false });
    app.decorate("requireApiKey", async (request: any) => {
      request.apiIdentity = {};
    });
    const gateway = {
      async chat(_request: unknown, _identity: unknown, signal: AbortSignal) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    } as unknown as GatewayService;
    app.setErrorHandler((error, _request, reply) => {
      const normalized = normalizeUnknownError(error);
      reply.code(normalized.shape.status).send({ error: normalized.shape });
    });
    await registerOpenAiRoutes(app, {
      gateway,
      models: new ModelRegistry(),
      requestTimeoutMs: 10,
      streamIdleTimeoutMs: 10,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test" },
      payload: {
        model: "stalled",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe("request_timeout");
    await app.close();
  });

  it("emits a compatible SSE error and closes an idle stream", async () => {
    const app = Fastify({ logger: false });
    app.decorate("requireApiKey", async (request: any) => {
      request.apiIdentity = {};
    });
    const gateway = {
      // eslint-disable-next-line require-yield
      async *stream(
        _request: unknown,
        _identity: unknown,
        signal: AbortSignal,
      ) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    } as unknown as GatewayService;
    await registerOpenAiRoutes(app, {
      gateway,
      models: new ModelRegistry(),
      requestTimeoutMs: 500,
      streamIdleTimeoutMs: 10,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test" },
      payload: {
        model: "stalled",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"code":"stream_idle_timeout"');
    expect(response.body).toContain("data: [DONE]");
    await app.close();
  });
});

describe("OpenAI-compatible model authorization", () => {
  it("only lists models allowed by the authenticated API key", async () => {
    const app = Fastify({ logger: false });
    app.decorate("requireApiKey", async (request: any) => {
      request.apiIdentity = {
        allowedProviders: ["allowed-provider"],
        allowedModels: ["allowed-model"],
      };
    });
    const models = new ModelRegistry();
    models.setMany([
      {
        provider: "allowed-provider",
        id: "allowed-model",
        enabled: true,
        capabilities: {},
      },
      {
        provider: "allowed-provider",
        id: "blocked-model",
        enabled: true,
        capabilities: {},
      },
      {
        provider: "blocked-provider",
        id: "allowed-model",
        enabled: true,
        capabilities: {},
      },
    ]);
    await registerOpenAiRoutes(app, {
      gateway: {} as GatewayService,
      models,
      requestTimeoutMs: 100,
      streamIdleTimeoutMs: 100,
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer test" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().data[0].id).toBe("allowed-provider/allowed-model");
    await app.close();
  });
});

describe("OpenAI-compatible streamed tool calls", () => {
  it("emits indexed fragmented and multiple tool calls with finish and usage", async () => {
    const app = Fastify({ logger: false });
    app.decorate("requireApiKey", async (request: any) => { request.apiIdentity = {}; });
    const gateway = {
      async *stream() {
        yield { requestId: "req-tools", event: { type: "tool_call_delta", id: "call-1", index: 0, name: "weather", arguments: "{\"city\":" } };
        yield { requestId: "req-tools", event: { type: "tool_call_delta", id: "call-1", index: 0, arguments: "\"Paris\"}" } };
        yield { requestId: "req-tools", event: { type: "tool_call_delta", id: "call-2", index: 1, name: "time", arguments: "{}" } };
        yield { requestId: "req-tools", event: { type: "finish", finishReason: "tool_calls" } };
        yield { requestId: "req-tools", event: { type: "usage", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } };
      },
    } as unknown as GatewayService;
    await registerOpenAiRoutes(app, { gateway, models: new ModelRegistry(), requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer test" }, payload: { stream: true, messages: [{ role: "user", content: "hi" }] } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"index":0');
    expect(response.body).toContain('"index":1');
    expect(response.body).toContain('"name":"weather"');
    expect(response.body).toContain('\\"Paris\\"}');
    expect(response.body).toContain('"finish_reason":"tool_calls"');
    expect(response.body).toContain('"total_tokens":7');
    expect(response.body).toContain("data: [DONE]");
    await app.close();
  });

  it("keeps ordinary text streaming unchanged", async () => {
    const app = Fastify({ logger: false });
    app.decorate("requireApiKey", async (request: any) => { request.apiIdentity = {}; });
    const gateway = { async *stream() { yield { requestId: "req-text", event: { type: "text_delta", text: "hello" } }; yield { requestId: "req-text", event: { type: "finish", finishReason: "stop" } }; } } as unknown as GatewayService;
    await registerOpenAiRoutes(app, { gateway, models: new ModelRegistry(), requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer test" }, payload: { stream: true, messages: [] } });
    expect(response.body).toContain('"content":"hello"');
    expect(response.body).toContain('"finish_reason":"stop"');
    await app.close();
  });
});

describe("OpenAI multimodal normalization", () => {
  it("converts image_url blocks before invoking the gateway", async () => {
    const app = Fastify({ logger: false });
    app.decorate("requireApiKey", async (request: any) => { request.apiIdentity = {}; });
    let received: any;
    const gateway = { async chat(request: any) { received = request; return { requestId: "req", response: { provider: "p", model: "m", message: { role: "assistant", content: "ok" }, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } }; } } as unknown as GatewayService;
    await registerOpenAiRoutes(app, { gateway, models: new ModelRegistry(), requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer test", "x-gateway-routing-mode": "FREE_ONLY" }, payload: { messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } }] }] } });
    expect(response.statusCode).toBe(200);
    expect(received.routingMode).toBe("FREE_ONLY");
    expect(received.messages[0].content[1]).toEqual({ type: "image", url: "data:image/png;base64,YQ==" });
    await app.close();
  });
});
