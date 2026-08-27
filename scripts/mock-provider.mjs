/* global console, process */
import http from "node:http";

const expectedAuthorization = "Bearer test";
const server = http.createServer(async (request, response) => {
  if (
    request.headers.authorization !== expectedAuthorization ||
    request.headers["x-test-secret"] !== "test-header"
  ) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unauthorized" } }));
    return;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: [{ id: "mock-model", object: "model", capabilities: { textInput: true, textOutput: true, streaming: true, toolCalling: true, structuredOutput: true, imageInput: true, embeddings: true } }] }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}");
    if (body.stream) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      if (body.tools?.length) {
        response.write(`data: ${JSON.stringify({ id: "mock-stream", choices: [{ delta: { tool_calls: [{ index: 0, id: "call-weather", type: "function", function: { name: "weather", arguments: "{\"city\":" } }] }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "mock-stream", choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"Paris\"}" } }, { index: 1, id: "call-time", type: "function", function: { name: "time", arguments: "{}" } }] }, finish_reason: null }] })}\n\n`);
      } else {
        response.write(
          `data: ${JSON.stringify({ id: "mock-stream", choices: [{ delta: { content: "persistent-" }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ id: "mock-stream", choices: [{ delta: { content: "stream-ok" }, finish_reason: null }] })}\n\n`,
        );
      }
      response.write(
        `data: ${JSON.stringify({ id: "mock-stream", choices: [{ delta: {}, finish_reason: body.tools?.length ? "tool_calls" : "stop" }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ id: "mock-stream", choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    const containsImage = body.messages?.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image_url"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "mock-response",
        model: "mock-model",
        choices: [
          {
            message: { role: "assistant", content: containsImage ? "image-input-ok" : "persistent-provider-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/v1/embeddings") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}");
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: "mock-model",
        data: inputs.map((_value, index) => ({
          object: "embedding",
          index,
          embedding: [0.1, 0.2, 0.3],
        })),
        usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
      }),
    );
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(18080, "0.0.0.0", () => {
  console.log("mock provider listening on 18080");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
