import crypto from "node:crypto";
import type { AppConfig } from "../config.js";
import type { ProviderAdapter, ProviderContext } from "../core/provider.js";
import type {
  ChatRequest,
  ChatResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  GatewayModel,
  Message,
  StreamEvent,
  Usage,
} from "../core/types.js";
import { GatewayError } from "../core/errors.js";

type AdapterConfig = {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
};
const text = (m: Message) =>
  typeof m.content === "string"
    ? m.content
    : m.content
        .filter((x) => x.type === "text")
        .map((x) => (x as any).text)
        .join("\n");
function usage(input = 0, output = 0, cached = 0, reasoning = 0): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedInputTokens: cached,
    reasoningTokens: reasoning,
  };
}
async function checked(r: Response, provider: string) {
  if (r.ok) return r;
  await r.body?.cancel();
  throw new GatewayError({
    code: `${provider}_http_${r.status}`,
    message: `${provider} request failed (${r.status})`,
    type: r.status === 429 ? "rate_limit" : "provider",
    retryable: r.status === 429 || r.status >= 500,
    status: r.status === 429 ? 429 : 502,
    provider,
    metadata: { retryAfter: r.headers.get("retry-after") },
  });
}

class OpenAICompatibleAdapter implements ProviderAdapter {
  kind: string;
  constructor(
    public id: string,
    kind: string,
    private baseUrl: string,
    private apiKey?: string,
    private extra: Record<string, string> = {},
  ) {
    this.kind = kind;
  }
  private headers() {
    return {
      "content-type": "application/json",
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.extra,
    };
  }
  async discoverModels(ctx: ProviderContext): Promise<GatewayModel[]> {
    const r = await checked(
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
        headers: this.headers(),
        signal: ctx.signal,
      }),
      this.id,
    );
    const j: any = await r.json();
    return (j.data ?? j.models ?? []).map((m: any) => ({
      provider: this.id,
      id: m.id ?? m.name,
      displayName: m.id ?? m.name,
      enabled: true,
      capabilities: {
        textInput: true,
        textOutput: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: true,
        embeddings: true,
      },
    }));
  }
  private body(req: ChatRequest, stream = false) {
    const messages = req.messages.map((m) => ({
      role: m.role === "developer" ? "system" : m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.map((b) =>
              b.type === "text"
                ? { type: "text", text: (b as any).text }
                : {
                    type: "image_url",
                    image_url: {
                      url:
                        (b as any).url ??
                        `data:${(b as any).mimeType};base64,${(b as any).base64}`,
                    },
                  },
            ),
      ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
      ...(m.toolCalls
        ? {
            tool_calls: m.toolCalls.map((t) => ({
              id: t.id,
              type: "function",
              function: { name: t.name, arguments: t.arguments },
            })),
          }
        : {}),
    }));
    return {
      model: req.model,
      messages,
      stream,
      temperature: req.temperature,
      max_tokens: req.maxOutputTokens,
      tools: req.tools?.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      })),
      tool_choice: req.toolChoice,
      response_format: req.structuredOutput
        ? {
            type: "json_schema",
            json_schema: {
              name: req.structuredOutput.name ?? "response",
              strict: req.structuredOutput.strict ?? true,
              schema: req.structuredOutput.schema,
            },
          }
        : undefined,
      stream_options: stream ? { include_usage: true } : undefined,
    };
  }
  async chat(req: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const r = await checked(
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.body(req, false)),
        signal: ctx.signal,
      }),
      this.id,
    );
    const j: any = await r.json();
    const c = j.choices?.[0] ?? {};
    return {
      id: j.id ?? crypto.randomUUID(),
      provider: this.id,
      model: j.model ?? req.model ?? "",
      message: {
        role: "assistant",
        content: c.message?.content ?? "",
        toolCalls: c.message?.tool_calls?.map((t: any) => ({
          id: t.id,
          name: t.function?.name,
          arguments: t.function?.arguments ?? "",
        })),
      },
      finishReason: c.finish_reason ?? "stop",
      usage: usage(
        j.usage?.prompt_tokens ?? 0,
        j.usage?.completion_tokens ?? 0,
        j.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        j.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      ),
      metadata: { providerResponseId: j.id },
    };
  }
  async *streamChat(
    req: ChatRequest,
    ctx: ProviderContext,
  ): AsyncIterable<StreamEvent> {
    const r = await checked(
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.body(req, true)),
        signal: ctx.signal,
      }),
      this.id,
    );
    if (!r.body) throw new Error("stream body missing");
    const reader = r.body.getReader(),
      dec = new TextDecoder();
    let buf = "";
    yield { type: "start", id: crypto.randomUUID(), model: req.model ?? "" };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let j: any;
        try {
          j = JSON.parse(payload);
        } catch {
          continue;
        }
        const c = j.choices?.[0];
        if (c?.delta?.content)
          yield { type: "text_delta", text: c.delta.content };
        for (const t of c?.delta?.tool_calls ?? [])
          yield {
            type: "tool_call_delta",
            id: t.id ?? String(t.index),
            name: t.function?.name,
            arguments: t.function?.arguments,
          };
        if (c?.finish_reason)
          yield { type: "finish", finishReason: c.finish_reason };
        if (j.usage)
          yield {
            type: "usage",
            usage: usage(
              j.usage.prompt_tokens ?? 0,
              j.usage.completion_tokens ?? 0,
              j.usage.prompt_tokens_details?.cached_tokens ?? 0,
              j.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            ),
          };
      }
    }
  }
  async embeddings(
    req: EmbeddingRequest,
    ctx: ProviderContext,
  ): Promise<EmbeddingResponse> {
    const r = await checked(
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/embeddings`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model: req.model, input: req.input }),
        signal: ctx.signal,
      }),
      this.id,
    );
    const j: any = await r.json();
    return {
      provider: this.id,
      model: j.model ?? req.model ?? "",
      data: (j.data ?? []).map((x: any, i: number) => ({
        index: x.index ?? i,
        embedding: x.embedding,
      })),
      usage: usage(j.usage?.prompt_tokens ?? 0, 0),
    };
  }
  async health(ctx: ProviderContext) {
    const t = performance.now();
    try {
      await this.discoverModels(ctx);
      return { ok: true, latencyMs: performance.now() - t };
    } catch (e) {
      return {
        ok: false,
        latencyMs: performance.now() - t,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }
}

class AnthropicAdapter implements ProviderAdapter {
  kind = "anthropic";
  constructor(
    public id: string,
    private baseUrl: string,
    private apiKey?: string,
  ) {}
  private h() {
    return {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
    };
  }
  async discoverModels(ctx: ProviderContext) {
    const r = await checked(
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/models`, {
        headers: this.h(),
        signal: ctx.signal,
      }),
      this.id,
    );
    const j: any = await r.json();
    return (j.data ?? []).map((m: any) => ({
      provider: this.id,
      id: m.id,
      displayName: m.display_name ?? m.id,
      enabled: true,
      capabilities: {
        textInput: true,
        textOutput: true,
        imageInput: true,
        streaming: true,
        toolCalling: true,
        structuredOutput: false,
      },
    }));
  }
  private b(req: ChatRequest, stream = false) {
    const system = req.messages
      .filter((m) => m.role === "system" || m.role === "developer")
      .map(text)
      .join("\n");
    return {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? 4096,
      temperature: req.temperature,
      stream,
      system: system || undefined,
      messages: req.messages
        .filter((m) => !["system", "developer"].includes(m.role))
        .map((m) => ({
          role: m.role === "tool" ? "user" : m.role,
          content: text(m),
        })),
      tools: req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };
  }
  async chat(req: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const r = await checked(
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/messages`, {
        method: "POST",
        headers: this.h(),
        body: JSON.stringify(this.b(req)),
        signal: ctx.signal,
      }),
      this.id,
    );
    const j: any = await r.json();
    const blocks = j.content ?? [];
    return {
      id: j.id ?? crypto.randomUUID(),
      provider: this.id,
      model: j.model ?? req.model ?? "",
      message: {
        role: "assistant" as const,
        content: blocks
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(""),
        toolCalls: blocks
          .filter((b: any) => b.type === "tool_use")
          .map((b: any) => ({
            id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input ?? {}),
          })),
      },
      finishReason: j.stop_reason ?? "stop",
      usage: usage(
        j.usage?.input_tokens ?? 0,
        j.usage?.output_tokens ?? 0,
        j.usage?.cache_read_input_tokens ?? 0,
      ),
    };
  }
  async *streamChat(
    req: ChatRequest,
    ctx: ProviderContext,
  ): AsyncIterable<StreamEvent> {
    const r = await checked(
      await fetch(`${this.baseUrl.replace(/\/$/, "")}/messages`, {
        method: "POST",
        headers: this.h(),
        body: JSON.stringify(this.b(req, true)),
        signal: ctx.signal,
      }),
      this.id,
    );
    if (!r.body) throw new Error("stream body missing");
    yield { type: "start", id: crypto.randomUUID(), model: req.model ?? "" };
    const reader = r.body.getReader(),
      dec = new TextDecoder();
    let buf = "";
    let final: Usage = usage();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let j: any;
        try {
          j = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (j.type === "content_block_delta" && j.delta?.type === "text_delta")
          yield { type: "text_delta", text: j.delta.text };
        if (j.type === "message_delta" && j.usage)
          final = usage(0, j.usage.output_tokens ?? 0);
        if (j.type === "message_stop")
          yield { type: "finish", finishReason: "stop" };
      }
    }
    yield { type: "usage", usage: final };
  }
  async embeddings(): Promise<EmbeddingResponse> {
    throw new GatewayError({
      code: "unsupported_embeddings",
      message: "Anthropic adapter does not advertise embeddings",
      type: "client",
      retryable: false,
      status: 400,
      provider: this.id,
    });
  }
  async health(ctx: ProviderContext) {
    const t = performance.now();
    try {
      await this.discoverModels(ctx);
      return { ok: true, latencyMs: performance.now() - t };
    } catch (e) {
      return { ok: false, latencyMs: performance.now() - t, detail: String(e) };
    }
  }
}

const geminiSpecializedModel =
  /(embedding|image|nano-banana|tts|audio|transcribe|live|veo|lyria|robotics|computer-use|deep-research)/i;

class GeminiAdapter implements ProviderAdapter {
  kind = "gemini";
  constructor(
    public id: string,
    private baseUrl: string,
    private apiKey?: string,
  ) {}
  private url(path: string) {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }
  private headers() {
    return { ...(this.apiKey ? { "x-goog-api-key": this.apiKey } : {}) };
  }
  async discoverModels(ctx: ProviderContext) {
    const r = await checked(
      await fetch(this.url("/models"), {
        headers: this.headers(),
        signal: ctx.signal,
      }),
      this.id,
    );
    const j: any = await r.json();
    return (j.models ?? []).map((m: any) => {
      const id = String(m.name).replace(/^models\//, "");
      const methods = new Set<string>(
        Array.isArray(m.supportedGenerationMethods)
          ? m.supportedGenerationMethods.map(String)
          : [],
      );
      const embeds =
        methods.has("embedContent") ||
        methods.has("batchEmbedContents") ||
        methods.has("batchEmbedContent");
      const specialized = geminiSpecializedModel.test(id);
      const generatesText = methods.has("generateContent") && !specialized;
      const enabled = generatesText || embeds;
      return {
        provider: this.id,
        id,
        displayName: m.displayName,
        enabled,
        capabilities: {
          textInput: enabled,
          textOutput: generatesText,
          streaming: generatesText,
          toolCalling: generatesText,
          structuredOutput: generatesText,
          embeddings: embeds,
          contextWindow:
            typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : undefined,
          maxOutputTokens:
            typeof m.outputTokenLimit === "number"
              ? m.outputTokenLimit
              : undefined,
        },
        metadata: {
          supportedGenerationMethods: [...methods],
          specialized,
        },
      };
    });
  }
  private body(req: ChatRequest) {
    return {
      contents: req.messages
        .filter((m) => !["system", "developer"].includes(m.role))
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: text(m) }],
        })),
      systemInstruction: {
        parts: [
          {
            text: req.messages
              .filter((m) => ["system", "developer"].includes(m.role))
              .map(text)
              .join("\n"),
          },
        ],
      },
      generationConfig: {
        temperature: req.temperature,
        maxOutputTokens: req.maxOutputTokens,
        responseMimeType: req.structuredOutput ? "application/json" : undefined,
        responseSchema: req.structuredOutput?.schema,
      },
      tools: req.tools?.length
        ? [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              })),
            },
          ]
        : undefined,
    };
  }
  async chat(req: ChatRequest, ctx: ProviderContext): Promise<ChatResponse> {
    const model = req.model ?? "";
    const r = await checked(
      await fetch(
        this.url(`/models/${encodeURIComponent(model)}:generateContent`),
        {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers() },
          body: JSON.stringify(this.body(req)),
          signal: ctx.signal,
        },
      ),
      this.id,
    );
    const j: any = await r.json();
    const parts = j.candidates?.[0]?.content?.parts ?? [];
    return {
      id: crypto.randomUUID(),
      provider: this.id,
      model,
      message: {
        role: "assistant" as const,
        content: parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join(""),
        toolCalls: parts
          .filter((p: any) => p.functionCall)
          .map((p: any, i: number) => ({
            id: `gemini-${i}`,
            name: p.functionCall.name,
            arguments: JSON.stringify(p.functionCall.args ?? {}),
          })),
      },
      finishReason: j.candidates?.[0]?.finishReason ?? "stop",
      usage: usage(
        j.usageMetadata?.promptTokenCount ?? 0,
        j.usageMetadata?.candidatesTokenCount ?? 0,
        j.usageMetadata?.cachedContentTokenCount ?? 0,
      ),
    };
  }
  async *streamChat(
    req: ChatRequest,
    ctx: ProviderContext,
  ): AsyncIterable<StreamEvent> {
    const model = req.model ?? "";
    const r = await checked(
      await fetch(
        this.url(
          `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        ),
        {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers() },
          body: JSON.stringify(this.body(req)),
          signal: ctx.signal,
        },
      ),
      this.id,
    );
    if (!r.body) throw new Error("stream body missing");
    yield { type: "start", id: crypto.randomUUID(), model };
    const reader = r.body.getReader(),
      dec = new TextDecoder();
    let buf = "";
    let u = usage();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let j: any;
        try {
          j = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        for (const p of j.candidates?.[0]?.content?.parts ?? [])
          if (p.text) yield { type: "text_delta", text: p.text };
        if (j.usageMetadata)
          u = usage(
            j.usageMetadata.promptTokenCount ?? 0,
            j.usageMetadata.candidatesTokenCount ?? 0,
            j.usageMetadata.cachedContentTokenCount ?? 0,
          );
      }
    }
    yield { type: "finish", finishReason: "stop" };
    yield { type: "usage", usage: u };
  }
  async embeddings(req: EmbeddingRequest, ctx: ProviderContext) {
    const model = req.model ?? "";
    const inputs = Array.isArray(req.input) ? req.input : [req.input];
    const data = [] as { index: number; embedding: number[] }[];
    for (let i = 0; i < inputs.length; i++) {
      const r = await checked(
        await fetch(
          this.url(`/models/${encodeURIComponent(model)}:embedContent`),
          {
            method: "POST",
            headers: { "content-type": "application/json", ...this.headers() },
            body: JSON.stringify({ content: { parts: [{ text: inputs[i] }] } }),
            signal: ctx.signal,
          },
        ),
        this.id,
      );
      const j: any = await r.json();
      data.push({ index: i, embedding: j.embedding?.values ?? [] });
    }
    return { provider: this.id, model, data, usage: usage() };
  }
  async health(ctx: ProviderContext) {
    const t = performance.now();
    try {
      await this.discoverModels(ctx);
      return { ok: true, latencyMs: performance.now() - t };
    } catch {
      return {
        ok: false,
        latencyMs: performance.now() - t,
        detail: "Provider health check failed",
      };
    }
  }
}

class OllamaAdapter extends OpenAICompatibleAdapter {
  constructor(id: string, baseUrl: string) {
    super(id, "ollama", `${baseUrl.replace(/\/$/, "")}/v1`);
  }
}
export function createAdapter(c: AdapterConfig): ProviderAdapter {
  if (c.kind === "anthropic")
    return new AnthropicAdapter(c.id, c.baseUrl, c.apiKey);
  if (c.kind === "gemini") return new GeminiAdapter(c.id, c.baseUrl, c.apiKey);
  if (c.kind === "ollama") return new OllamaAdapter(c.id, c.baseUrl);
  return new OpenAICompatibleAdapter(
    c.id,
    c.kind,
    c.baseUrl,
    c.apiKey,
    c.headers,
  );
}
export function builtInAdapters(c: AppConfig): ProviderAdapter[] {
  return [
    createAdapter({
      id: "openai",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: c.OPENAI_API_KEY,
    }),
    createAdapter({
      id: "anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: c.ANTHROPIC_API_KEY,
    }),
    createAdapter({
      id: "gemini",
      kind: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: c.GEMINI_API_KEY,
    }),
    createAdapter({
      id: "xai",
      kind: "xai",
      baseUrl: "https://api.x.ai/v1",
      apiKey: c.XAI_API_KEY,
    }),
    createAdapter({
      id: "deepseek",
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: c.DEEPSEEK_API_KEY,
    }),
    createAdapter({ id: "ollama", kind: "ollama", baseUrl: c.OLLAMA_BASE_URL }),
  ];
}