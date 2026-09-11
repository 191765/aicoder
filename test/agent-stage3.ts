import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";
import { Agent } from "../src/agent.js";
import { loadSession } from "../src/session.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-agent3-"));
process.env.AICODER_HOME = path.join(tmp, "home");

// 记录每次请求用的模型，验证路由
const seenModels = [];
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    seenModels.push(parsed.model);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `model=${parsed.model}` }, finish_reason: null }] });
    send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mock.listen(9915, () => r()));

const cfg = loadConfig({
  workdir: tmp,
  apiKey: "t",
  baseURL: "http://localhost:9915/v1",
  model: "base-model",
  models: [
    { match: { input: "重构|架构" }, model: "strong-model" },
    { model: "default-model" },
  ],
});

const agent = new Agent({ config: cfg, sessionId: "route-sess", persist: true });

let out1 = "";
for await (const ev of agent.chat("帮我重构这个模块")) if (ev.type === "text") out1 += ev.delta;
console.log("turn1:", out1, "| model used:", seenModels[0]);

let out2 = "";
for await (const ev of agent.chat("你好")) if (ev.type === "text") out2 += ev.delta;
console.log("turn2:", out2, "| model used:", seenModels[1]);

// 会话已保存
const saved = await loadSession("route-sess");
console.log("saved messages:", saved?.messages.length, "| title:", saved?.title);

mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
delete process.env.AICODER_HOME;

if (seenModels[0] !== "strong-model" || seenModels[1] !== "default-model") {
  console.error("FAIL: routing");
  process.exit(1);
}
if (!saved || saved.messages.length < 4) { console.error("FAIL: persistence"); process.exit(1); }
console.log("OK");
