/* global console, process */
import http from "node:http";

const expectedAuthorization = "Bearer test";
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== expectedAuthorization) {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "unauthorized" } }));
    return;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ data: [{ id: "mock-model", object: "model" }] }),
    );
    return;
  }
  if (request.method === "POST" && request.url === "/v1/chat/completions") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "mock-response",
        model: "mock-model",
        choices: [
          {
            message: { role: "assistant", content: "persistent-provider-ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
