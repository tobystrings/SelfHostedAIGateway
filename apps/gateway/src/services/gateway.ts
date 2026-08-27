import crypto from 'node:crypto';
import AjvModule from 'ajv';
import { estimateCost } from '../core/cost.js';
import { GatewayError, normalizeUnknownError } from '../core/errors.js';
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  StreamEvent,
  Usage,
} from '../core/types.js';
import { retryDelayMs } from '../core/retry.js';
import type { ProviderRegistry } from './provider-registry.js';
import type { ModelRegistry } from './model-registry.js';
import type { RoutingEngine, RouteDecision } from './router.js';
import type { BudgetService } from './budget.js';
import type { UsageService } from './usage.js';
import type { ScopedRateLimitService } from './rate-limit.js';

export interface InvokeIdentity {
  userId?: string;
  apiKeyId?: string;
  allowedProviders?: string[];
  allowedModels?: string[];
}

interface AjvValidator {
  (data: unknown): boolean;
  errors?: unknown;
}

interface AjvInstance {
  compile(schema: Record<string, unknown>): AjvValidator;
  errorsText(errors?: unknown): string;
}

type AjvConstructor = new (options?: {
  strict?: boolean;
  allErrors?: boolean;
}) => AjvInstance;

const Ajv = (
  (AjvModule as unknown as { default?: AjvConstructor }).default ??
  (AjvModule as unknown as AjvConstructor)
);
const ajv = new Ajv({ strict: false, allErrors: true });

function tokenEstimate(req: ChatRequest) {
  const chars =
    JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length;
  const input = Math.max(1, Math.ceil(chars / 4));
  const output = req.maxOutputTokens ?? 1024;
  return { input, output, total: input + output };
}

function embeddingTokenEstimate(req: EmbeddingRequest) {
  const text = Array.isArray(req.input) ? req.input.join('\n') : req.input;
  return Math.max(1, Math.ceil(text.length / 4));
}

function validate(req: ChatRequest, res: ChatResponse) {
  if (!req.structuredOutput) return;

  const raw = typeof res.message.content === 'string' ? res.message.content : '';
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new GatewayError({
      code: 'structured_output_invalid_json',
      message: 'Provider returned invalid JSON',
      type: 'provider',
      retryable: false,
      status: 502,
      provider: res.provider,
    });
  }

  const validator = ajv.compile(req.structuredOutput.schema);
  if (!validator(data)) {
    throw new GatewayError({
      code: 'structured_output_schema_mismatch',
      message: ajv.errorsText(validator.errors),
      type: 'provider',
      retryable: false,
      status: 502,
      provider: res.provider,
    });
  }
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });

export class GatewayService {
  constructor(
    private providers: ProviderRegistry,
    private models: ModelRegistry,
    private router: RoutingEngine,
    private budgets?: BudgetService,
    private usage?: UsageService,
    private limits?: ScopedRateLimitService,
  ) {}

  route(req: ChatRequest, id: InvokeIdentity = {}): RouteDecision {
    return this.router.route(req, id.allowedProviders, id.allowedModels);
  }

  async chat(
    req: ChatRequest,
    id: InvokeIdentity = {},
    signal = new AbortController().signal,
  ) {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const decision = this.route(req, id);
    const est = tokenEstimate(req);
    const first = decision.candidates[0]!;

    await this.limits?.consume({
      ...id,
      provider: first.provider,
      model: first.id,
      estimatedTokens: est.total,
    });

    const reservation = await this.budgets?.reserve({
      ...id,
      estimatedTokens: est.total,
      estimatedCostUsd: estimateCost(
        {
          inputTokens: est.input,
          outputTokens: est.output,
          totalTokens: est.total,
        },
        first.pricing,
      ),
    });

    await this.usage?.startRequest({
      requestId,
      ...id,
      requestedProvider: req.provider,
      requestedModel: req.model,
      selectedProvider: first.provider,
      selectedModel: first.id,
      routingReason: decision.reason,
      streamed: false,
    });

    let attemptNumber = 0;
    try {
      for (let i = 0; i < decision.candidates.length; i += 1) {
        const model = decision.candidates[i]!;
        const adapter = this.providers.get(model.provider);
        const tries = req.tools?.length ? 1 : 3;

        for (let retry = 1; retry <= tries; retry += 1) {
          attemptNumber += 1;
          const attemptStarted = performance.now();

          try {
            const response = await adapter.chat(
              { ...req, provider: model.provider, model: model.id, stream: false },
              { signal, requestId },
            );

            validate(req, response);
            response.usage.estimatedCostUsd = estimateCost(
              response.usage,
              model.pricing,
            );
            this.router.breaker(model.provider).recordSuccess();

            await this.usage?.attempt({
              requestId,
              attemptNumber,
              provider: model.provider,
              model: model.id,
              outcome: 'success',
              latencyMs: performance.now() - attemptStarted,
            });
            await this.usage?.record({
              requestId,
              ...id,
              provider: model.provider,
              model: model.id,
              usage: response.usage,
              latencyMs: performance.now() - started,
            });
            await this.budgets?.settle(reservation);

            return {
              response,
              decision: {
                ...decision,
                provider: model.provider,
                model: model.id,
                reason: {
                  ...decision.reason,
                  fallbackIndex: i,
                  retry: retry - 1,
                },
              },
              requestId,
            };
          } catch (error) {
            const gatewayError = normalizeUnknownError(error, model.provider);
            this.router
              .breaker(model.provider)
              .recordFailure(gatewayError.shape.retryable);

            const retrying =
              retry < tries && gatewayError.shape.retryable && !signal.aborted;
            const fallback =
              !retrying &&
              i < decision.candidates.length - 1 &&
              gatewayError.shape.retryable &&
              !req.tools?.length &&
              !signal.aborted;

            await this.usage?.attempt({
              requestId,
              attemptNumber,
              provider: model.provider,
              model: model.id,
              outcome: 'failure',
              failureCode: gatewayError.shape.code,
              retryDecision: retrying ? 'retry' : 'stop',
              fallbackDecision: fallback ? 'next_candidate' : 'none',
              latencyMs: performance.now() - attemptStarted,
            });

            if (retrying) {
              await pause(retryDelayMs(retry), signal);
              continue;
            }
            if (fallback) break;
            throw gatewayError;
          }
        }
      }

      throw new GatewayError({
        code: 'all_routes_failed',
        message: 'All routes failed',
        type: 'unavailable',
        retryable: true,
        status: 503,
      });
    } catch (error) {
      const gatewayError = normalizeUnknownError(error);
      await this.usage?.fail(
        requestId,
        gatewayError.shape.code,
        performance.now() - started,
      );
      await this.budgets?.release(reservation);
      throw gatewayError;
    }
  }

  async *stream(
    req: ChatRequest,
    id: InvokeIdentity = {},
    signal = new AbortController().signal,
  ): AsyncIterable<{
    event: StreamEvent;
    decision: RouteDecision;
    requestId: string;
  }> {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const decision = this.route({ ...req, stream: true }, id);
    const model = decision.candidates[0]!;
    const est = tokenEstimate(req);

    await this.limits?.consume({
      ...id,
      provider: model.provider,
      model: model.id,
      estimatedTokens: est.total,
    });

    const reservation = await this.budgets?.reserve({
      ...id,
      estimatedTokens: est.total,
      estimatedCostUsd: estimateCost(
        {
          inputTokens: est.input,
          outputTokens: est.output,
          totalTokens: est.total,
        },
        model.pricing,
      ),
    });

    await this.usage?.startRequest({
      requestId,
      ...id,
      requestedProvider: req.provider,
      requestedModel: req.model,
      selectedProvider: model.provider,
      selectedModel: model.id,
      routingReason: decision.reason,
      streamed: true,
    });

    let finalUsage: Usage | undefined;
    try {
      for await (const event of this.providers
        .get(model.provider)
        .streamChat(
          { ...req, provider: model.provider, model: model.id, stream: true },
          { signal, requestId },
        )) {
        if (event.type === 'usage') {
          event.usage.estimatedCostUsd = estimateCost(event.usage, model.pricing);
          finalUsage = event.usage;
        }
        yield { event, decision, requestId };
      }

      if (finalUsage) {
        await this.usage?.record({
          requestId,
          ...id,
          provider: model.provider,
          model: model.id,
          usage: finalUsage,
          latencyMs: performance.now() - started,
        });
      }
      await this.budgets?.settle(reservation);
    } catch (error) {
      const gatewayError = normalizeUnknownError(error, model.provider);
      await this.usage?.fail(
        requestId,
        gatewayError.shape.code,
        performance.now() - started,
      );
      await this.budgets?.release(reservation);
      throw gatewayError;
    }
  }

  async embeddings(
    req: EmbeddingRequest,
    id: InvokeIdentity = {},
    signal = new AbortController().signal,
  ): Promise<{ response: EmbeddingResponse; requestId: string }> {
    const requestId = crypto.randomUUID();
    const started = performance.now();

    const mode = req.routingMode ?? this.router.getDefaultMode();
    if (!["NORMAL", "FREE_ONLY", "LOCAL_ONLY", "CHEAPEST"].includes(mode)) {
      throw new GatewayError({ code: "invalid_routing_mode", message: "Invalid routing mode", type: "client", retryable: false, status: 400 });
    }
    const candidates = this.models.list().filter((candidate) => {
      if (!candidate.enabled || !candidate.capabilities.embeddings) return false;
      if (candidate.callable === false) return false;
      if (mode === "FREE_ONLY" && candidate.costClassification !== "free" && candidate.costClassification !== "local") return false;
      if (mode === "LOCAL_ONLY" && candidate.costClassification !== "local") return false;
      if (req.provider && candidate.provider !== req.provider) return false;
      if (
        req.model &&
        candidate.id !== req.model &&
        `${candidate.provider}/${candidate.id}` !== req.model &&
        candidate.metadata?.alias !== req.model
      ) {
        return false;
      }
      if (
        id.allowedProviders?.length &&
        !id.allowedProviders.includes(candidate.provider)
      ) {
        return false;
      }
      if (
        id.allowedModels?.length &&
        !id.allowedModels.includes(candidate.id) &&
        !id.allowedModels.includes(`${candidate.provider}/${candidate.id}`)
      ) {
        return false;
      }
      return true;
    });
    candidates.sort((left, right) => {
      if (mode === "CHEAPEST") {
        const price = (candidate: typeof left) => candidate.costClassification === "free" || candidate.costClassification === "local" ? 0 : candidate.pricing?.inputPerMillionUsd ?? Number.POSITIVE_INFINITY;
        const difference = price(left) - price(right);
        if (difference) return difference;
      }
      return Number(left.metadata?.routingPriority ?? 100) - Number(right.metadata?.routingPriority ?? 100);
    });
    const model = candidates[0];

    if (!model) {
      throw new GatewayError({
        code: 'embedding_route_not_found',
        message: mode === "FREE_ONLY" ? 'No free or local embedding model found; FREE_ONLY prevented paid or unknown fallback' : 'No embedding model found',
        type: 'client',
        retryable: false,
        status: 404,
      });
    }

    const estimatedTokens = embeddingTokenEstimate(req);
    await this.limits?.consume({
      ...id,
      provider: model.provider,
      model: model.id,
      estimatedTokens,
    });

    const reservation = await this.budgets?.reserve({
      ...id,
      estimatedTokens,
      estimatedCostUsd: estimateCost(
        {
          inputTokens: estimatedTokens,
          outputTokens: 0,
          totalTokens: estimatedTokens,
        },
        model.pricing,
      ),
    });

    await this.usage?.startRequest({
      requestId,
      ...id,
      requestedProvider: req.provider,
      requestedModel: req.model,
      selectedProvider: model.provider,
      selectedModel: model.id,
      routingReason: { mode, selection: req.provider || req.model ? 'explicit' : 'automatic' },
      streamed: false,
    });

    try {
      const response = await this.providers
        .get(model.provider)
        .embeddings(
          { ...req, provider: model.provider, model: model.id },
          { signal, requestId },
        );
      response.usage.estimatedCostUsd = estimateCost(response.usage, model.pricing);

      await this.usage?.attempt({
        requestId,
        attemptNumber: 1,
        provider: model.provider,
        model: model.id,
        outcome: 'success',
        latencyMs: performance.now() - started,
      });
      await this.usage?.record({
        requestId,
        ...id,
        provider: model.provider,
        model: model.id,
        usage: response.usage,
        latencyMs: performance.now() - started,
      });
      await this.budgets?.settle(reservation);
      return { response, requestId };
    } catch (error) {
      const gatewayError = normalizeUnknownError(error, model.provider);
      await this.usage?.attempt({
        requestId,
        attemptNumber: 1,
        provider: model.provider,
        model: model.id,
        outcome: 'failure',
        failureCode: gatewayError.shape.code,
        retryDecision: 'stop',
        fallbackDecision: 'none',
        latencyMs: performance.now() - started,
      });
      await this.usage?.fail(
        requestId,
        gatewayError.shape.code,
        performance.now() - started,
      );
      await this.budgets?.release(reservation);
      throw gatewayError;
    }
  }
}
