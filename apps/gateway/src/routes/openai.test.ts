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
