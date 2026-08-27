import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdapter } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider credential safety", () => {
  it("sends Gemini credentials in a header instead of the URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdapter({
      id: "gemini",
      kind: "gemini",
      baseUrl: "https://example.invalid/v1beta",
      apiKey: "sensitive-gemini-key",
    });

    await adapter.discoverModels({
      signal: new AbortController().signal,
      requestId: "test",
    });

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain("sensitive-gemini-key");
    expect(options?.headers).toMatchObject({
      "x-goog-api-key": "sensitive-gemini-key",
    });
  });

  it("does not copy upstream response bodies into gateway errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("upstream-secret-details", { status: 400 }),
      ),
    );
    const adapter = createAdapter({
      id: "compatible",
      kind: "openai-compatible",
      baseUrl: "https://example.invalid/v1",
    });

    await expect(
      adapter.chat(
        { model: "model", messages: [{ role: "user", content: "hello" }] },
        { signal: new AbortController().signal, requestId: "test" },
      ),
    ).rejects.not.toThrow(/upstream-secret-details/);
  });
});

describe("Gemini model discovery", () => {
  it("classifies chat, embedding, and unsupported specialized models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  name: "models/gemini-3.7-flash",
                  displayName: "Gemini 3.7 Flash",
                  inputTokenLimit: 1048576,
                  outputTokenLimit: 65536,
                  supportedGenerationMethods: [
                    "generateContent",
                    "countTokens",
                  ],
                },
                {
                  name: "models/gemini-embedding-001",
                  displayName: "Gemini Embedding",
                  inputTokenLimit: 2048,
                  supportedGenerationMethods: ["embedContent"],
                },
                {
                  name: "models/veo-3.1-generate-preview",
                  displayName: "Veo",
                  supportedGenerationMethods: ["predictLongRunning"],
                },
                {
                  name: "models/gemini-3-pro-image-preview",
                  displayName: "Gemini Image",
                  supportedGenerationMethods: ["generateContent"],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const adapter = createAdapter({
      id: "gemini",
      kind: "gemini",
      baseUrl: "https://example.invalid/v1beta",
    });
    const models = await adapter.discoverModels({
      signal: new AbortController().signal,
      requestId: "test",
    });

    expect(models[0]).toMatchObject({
      id: "gemini-3.7-flash",
      enabled: true,
      capabilities: {
        textInput: true,
        textOutput: true,
        imageInput: true,
        streaming: true,
        embeddings: false,
        contextWindow: 1048576,
        maxOutputTokens: 65536,
      },
    });
    expect(models[1]).toMatchObject({
      id: "gemini-embedding-001",
      enabled: true,
      capabilities: {
        textInput: true,
        textOutput: false,
        streaming: false,
        embeddings: true,
      },
    });
    expect(models[2]).toMatchObject({
      id: "veo-3.1-generate-preview",
      enabled: false,
      capabilities: { textOutput: false, embeddings: false },
    });
    expect(models[3]).toMatchObject({
      id: "gemini-3-pro-image-preview",
      enabled: false,
      capabilities: { textOutput: false, embeddings: false },
    });
  });
});

describe("OpenAI-compatible capability discovery", () => {
  it("defaults to conservative capabilities and honors explicit upstream declarations", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "ordinary-model" },
      { id: "text-embedding-3-small" },
      { id: "declared-vision", capabilities: { imageInput: true, toolCalling: true } },
    ] }), { status: 200 })));
    const adapter = createAdapter({ id: "compatible", kind: "openai-compatible", baseUrl: "https://example.invalid/v1" });
    const models = await adapter.discoverModels({ signal: new AbortController().signal, requestId: "test" });
    expect(models[0]?.capabilities).toMatchObject({ textOutput: true, imageInput: false, toolCalling: false, embeddings: false });
    expect(models[1]?.capabilities).toMatchObject({ textOutput: false, embeddings: true });
    expect(models[2]?.capabilities).toMatchObject({ imageInput: true, toolCalling: true });
  });
});

describe("Gemini multimodal translation", () => {
  it("preserves system text and sends mixed text and base64 image parts", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdapter({ id: "gemini", kind: "gemini", baseUrl: "https://example.invalid/v1beta" });
    await adapter.chat({
      model: "gemini-3.7-flash",
      messages: [
        { role: "system", content: "Follow the policy" },
        { role: "developer", content: "Be concise" },
        { role: "user", content: [{ type: "text", text: "What is this?" }, { type: "image", base64: "aW1hZ2U=", mimeType: "image/png" }] },
      ],
    }, { signal: new AbortController().signal, requestId: "test" });
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.systemInstruction.parts[0].text).toBe("Follow the policy\nBe concise");
    expect(body.contents[0].parts).toEqual([{ text: "What is this?" }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }]);
  });

  it("accepts data image URLs and rejects unsupported remote URLs clearly", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createAdapter({ id: "gemini", kind: "gemini", baseUrl: "https://example.invalid/v1beta" });
    await adapter.chat({ model: "m", messages: [{ role: "user", content: [{ type: "image", url: "data:image/webp;base64,YQ==" }] }] }, { signal: new AbortController().signal, requestId: "test" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/webp", data: "YQ==" } });
    await expect(adapter.chat({ model: "m", messages: [{ role: "user", content: [{ type: "image", url: "https://example.com/image.png" }] }] }, { signal: new AbortController().signal, requestId: "test" })).rejects.toThrow(/requires base64/);
  });
});
