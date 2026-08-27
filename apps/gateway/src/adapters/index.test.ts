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
