import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayService } from "../services/gateway.js";
import type { ModelRegistry } from "../services/model-registry.js";
import type { ChatRequest, Message } from "../core/types.js";
import { GatewayError, normalizeUnknownError } from "../core/errors.js";

function normalizeMessage(message: any): Message {
  if (!Array.isArray(message.content)) return message as Message;
  return {
    ...message,
    content: message.content.map((block: any) => {
      if (block.type === "text" || block.type === "input_text") return { type: "text", text: String(block.text ?? "") };
      if (block.type === "image") return block;
      if (block.type === "image_url") {
        const url = typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
        return { type: "image", url, mimeType: block.image_url?.mime_type };
      }
      if (block.type === "input_image") return { type: "image", url: block.image_url, base64: block.image_base64, mimeType: block.mime_type };
      throw new GatewayError({ code: "unsupported_content_block", message: `Unsupported message content block: ${String(block.type)}`, type: "client", retryable: false, status: 400 });
    }),
  };
}

function normalized(body: any, routingModeHeader?: unknown): ChatRequest {
  const routingMode = routingModeHeader ?? body.routing_mode ?? body.gateway?.routing_mode;
  if (routingMode !== undefined && !["NORMAL", "FREE_ONLY", "LOCAL_ONLY", "CHEAPEST"].includes(String(routingMode))) {
    throw new GatewayError({ code: "invalid_routing_mode", message: "routing mode must be NORMAL, FREE_ONLY, LOCAL_ONLY, or CHEAPEST", type: "client", retryable: false, status: 400 });
  }
  return {
    provider: body.provider,
    model: body.model,
    messages: (body.messages ?? []).map(normalizeMessage),
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
    routingMode: routingMode as ChatRequest["routingMode"],
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
            cost_classification: model.costClassification ?? "unknown",
            verification_status: model.verificationStatus ?? "unverified",
          },
        })),
    }),
  );

  app.post(
    "/v1/chat/completions",
    { preHandler: (app as any).requireApiKey },
    async (request: any, reply) => {
      const body = normalized(request.body, request.headers["x-gateway-routing-mode"]);
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
              if (event.type === "tool_call_delta") {
                reply.raw.write(
                  `data: ${JSON.stringify({ id: item.requestId, object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: event.index ?? 0, ...(event.id ? { id: event.id } : {}), type: "function", function: { ...(event.name ? { name: event.name } : {}), ...(event.arguments !== undefined ? { arguments: event.arguments } : {}) } }] }, finish_reason: null }] })}\n\n`,
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
          } catch (error) {
            const normalized = normalizeUnknownError(
              cancellation.controller.signal.aborted
                ? cancellation.controller.signal.reason
                : error,
            );
            if (!reply.raw.writableEnded) {
              reply.raw.write(
                `data: ${JSON.stringify({ error: { message: normalized.shape.message, type: normalized.shape.type, code: normalized.shape.code } })}\n\n`,
              );
              reply.raw.end("data: [DONE]\n\n");
            }
            return reply;
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
          { provider: body.provider, model: body.model, input: body.input, routingMode: request.headers["x-gateway-routing-mode"] ?? body.routing_mode ?? body.gateway?.routing_mode },
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
