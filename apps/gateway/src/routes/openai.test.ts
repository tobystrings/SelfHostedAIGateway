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
