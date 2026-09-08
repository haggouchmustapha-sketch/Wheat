const http = require("node:http");

// A local protocol fixture, not model inference. No keys, downloads or external requests.
async function startOllamaFixture() {
  const requests = [];
  const pending = [];
  let holdChat = false;
  const models = [
    { name: "wheat-test-text", capabilities: ["completion"] },
    { name: "wheat-test-vision", capabilities: ["completion", "vision"] },
  ].map((model) => ({ ...model, model: model.name, size: 1000, digest: "a".repeat(64), details: { family: "test" } }));
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (data) => { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
    if (request.url === "/api/tags") return send({ models });
    if (request.url === "/api/chat") {
      requests.push(body);
      const reply = () => send({ message: { role: "assistant", content: "Réponse synthétique du dossier A." }, done: true, done_reason: "stop" });
      if (holdChat) pending.push(reply); else reply();
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`, requests,
    hold: () => { holdChat = true; },
    release: () => { holdChat = false; pending.splice(0).forEach((reply) => reply()); },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
module.exports = { startOllamaFixture };
