import http from "node:http";
import { loadConfig } from "../src/config.js";
import { createProvider } from "../src/provider.js";
import { Agent } from "../src/agent.js";
import { findTool } from "../src/tools.js";

let attempts = 0;
const mock = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    attempts++;
    if (attempts < 3) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "overloaded" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "after retry" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mock.listen(9917, () => r()));

const cfg = loadConfig({
  apiKey: "t",
  baseURL: "http://localhost:9917/v1",
  model: "mock",
  workdir: process.cwd(),
  retry: { maxRetries: 5, baseDelayMs: 50 },
});
const provider = createProvider(cfg);
let text = "";
for await (const ev of provider.stream([{ role: "user", content: "hi" }], [])) {
  if (ev.type === "text") text += ev.delta;
  if (ev.type === "error") console.log("ERR:", ev.message);
}
console.log("attempts:", attempts, "| text:", JSON.stringify(text));

// 工具超时
new Agent({ config: cfg });
const { registerTool } = await import("../src/tools.js");
registerTool({
  name: "slow_tool",
  description: "slow",
  mutating: false,
  parameters: { type: "object", properties: {} },
  async run() { await new Promise((r) => setTimeout(r, 5000)); return "done"; },
});
const slowCfg = loadConfig({ ...cfg, toolTimeoutMs: 200 });
const agent = new Agent({ config: slowCfg });
void agent;
mock.close();
console.log("retry ok:", attempts === 3 && text === "after retry");
if (!(attempts === 3 && text === "after retry")) process.exit(1);
console.log("OK");
