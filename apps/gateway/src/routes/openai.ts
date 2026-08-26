import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayService } from "../services/gateway.js";
import type { ModelRegistry } from "../services/model-registry.js";
import type { ChatRequest, Message } from "../core/types.js";
import { GatewayError } from "../core/errors.js";

function normalized(body: any): ChatRequest {
  return {
    provider: body.provider,
    model: body.model,
    messages: (body.messages ?? []) as Message[],
    stream: !!body.stream,
    temperature: body.temperature,
    maxOutputTokens: body.max_tokens ?? body.max_completion_tokens,
    tools: body.tools?.map((tool: any) => ({
      name: tool.function?.name,
      description: tool.function?.description,
      parameters: tool.function?.parameters ?? {},
    })),
    toolChoice: body.tool_choice,
    structuredOutput:
      body.response_format?.type === "json_schema"
        ? {
            name: body.response_format.json_schema?.name,
            schema: body.response_format.json_schema?.schema ?? {},
            strict: body.response_format.json_schema?.strict,
          }
        : undefined,
  };
}

function requestCancellation(
  request: FastifyRequest,
  reply: FastifyReply,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new GatewayError({
          code: "request_timeout",
          message: "Gateway request timed out",
          type: "timeout",
          retryable: true,
          status: 504,
        }),
      ),
    timeoutMs,
  );
  timeout.unref();
  const disconnect = () => {
    if (!reply.raw.writableEnded) {
      controller.abort(new DOMException("Client disconnected", "AbortError"));
    }
  };
  request.raw.once("aborted", disconnect);
  reply.raw.once("close", disconnect);
  return {
    controller,
    cleanup() {
      clearTimeout(timeout);
      request.raw.off("aborted", disconnect);
      reply.raw.off("close", disconnect);
    },
  };
}

export async function registerOpenAiRoutes(
  app: FastifyInstance,
  deps: {
    gateway: GatewayService;
    models: ModelRegistry;
    requestTimeoutMs: number;
    streamIdleTimeoutMs: number;
  },
) {
  app.get(
    "/v1/models",
    { preHandler: (app as any).requireApiKey },
    async (request: any) => ({
      object: "list",
      data: deps.models
        .list()
        .filter(
          (model) =>
            model.enabled &&
            (!request.apiIdentity.allowedProviders?.length ||
              request.apiIdentity.allowedProviders.includes(model.provider)) &&
            (!request.apiIdentity.allowedModels?.length ||
              request.apiIdentity.allowedModels.includes(model.id) ||
              request.apiIdentity.allowedModels.includes(
                `${model.provider}/${model.id}`,
              )),
        )
        .map((model) => ({
          id: model.metadata?.alias ?? `${model.provider}/${model.id}`,
          object: "model",
          owned_by: model.provider,
          gateway: {
            provider: model.provider,
            capabilities: model.capabilities,
          },
        })),
    }),
  );

  app.post(
    "/v1/chat/completions",
    { preHandler: (app as any).requireApiKey },
    async (request: any, reply) => {
      const body = normalized(request.body);
      const cancellation = requestCancellation(
        request,
        reply,
        deps.requestTimeoutMs,
      );
      try {
        if (body.stream) {
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          let idleTimer: NodeJS.Timeout | undefined;
          const resetIdleTimer = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () =>
                cancellation.controller.abort(
                  new GatewayError({
                    code: "stream_idle_timeout",
                    message: "Upstream stream was idle for too long",
                    type: "timeout",
                    retryable: true,
                    status: 504,
                  }),
                ),
              deps.streamIdleTimeoutMs,
            );
            idleTimer.unref();
          };
          resetIdleTimer();
          try {
            for await (const item of deps.gateway.stream(
              body,
              request.apiIdentity,
              cancellation.controller.signal,
            )) {
              resetIdleTimer();
              const event = item.event;
              if (event.type === "text_delta") {
                reply.raw.write(
                  `data: ${JSON.stringify({ id: item.requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }] })}\n\n`,
                );
              }
              if (event.type === "finish") {
                reply.raw.write(
                  `data: ${JSON.stringify({ id: item.requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }] })}\n\n`,
                );
              }
              if (event.type === "usage") {
                reply.raw.write(
                  `data: ${JSON.stringify({ id: item.requestId, object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: event.usage.inputTokens, completion_tokens: event.usage.outputTokens, total_tokens: event.usage.totalTokens } })}\n\n`,
                );
              }
            }
          } finally {
            clearTimeout(idleTimer);
          }
          reply.raw.end("data: [DONE]\n\n");
          return reply;
        }

        const { response, requestId } = await deps.gateway.chat(
          body,
          request.apiIdentity,
          cancellation.controller.signal,
        );
        return {
          id: requestId,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: `${response.provider}/${response.model}`,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: response.message.content,
                tool_calls: response.message.toolCalls?.map((tool) => ({
                  id: tool.id,
                  type: "function",
                  function: { name: tool.name, arguments: tool.arguments },
                })),
              },
              finish_reason: response.finishReason,
            },
          ],
          usage: {
            prompt_tokens: response.usage.inputTokens,
            completion_tokens: response.usage.outputTokens,
            total_tokens: response.usage.totalTokens,
          },
          gateway: {
            provider: response.provider,
            estimated_cost_usd: response.usage.estimatedCostUsd,
          },
        };
      } finally {
        cancellation.cleanup();
      }
    },
  );

  app.post(
    "/v1/embeddings",
    { preHandler: (app as any).requireApiKey },
    async (request: any, reply) => {
      const body = request.body as any;
      const cancellation = requestCancellation(
        request,
        reply,
        deps.requestTimeoutMs,
      );
      try {
        const { response } = await deps.gateway.embeddings(
          { provider: body.provider, model: body.model, input: body.input },
          request.apiIdentity,
          cancellation.controller.signal,
        );
        return {
          object: "list",
          model: `${response.provider}/${response.model}`,
          data: response.data.map((item) => ({
            object: "embedding",
            index: item.index,
            embedding: item.embedding,
          })),
          usage: {
            prompt_tokens: response.usage.inputTokens,
            total_tokens: response.usage.totalTokens,
          },
        };
      } finally {
        cancellation.cleanup();
      }
    },
  );
}
