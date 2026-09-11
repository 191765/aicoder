import http from "node:http";
import { loadConfig } from "../src/config.js";
import { Agent } from "../src/agent.js";
import { registerTool } from "../src/tools.js";

// 注册三个只读慢工具
for (let i = 1; i <= 3; i++) {
  const idx = i;
  registerTool({
    name: `slow_read_${idx}`,
    description: "slow read",
    mutating: false,
    parameters: { type: "object", properties: {} },
    async run() {
      await new Promise((r) => setTimeout(r, 300));
      return `result-${idx}`;
    },
  });
}

let mainCalls = 0;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const hasTool = JSON.parse(body).messages.some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!hasTool) {
      mainCalls++;
      const calls = [1, 2, 3].map((i) => ({
        index: i - 1,
        id: `c${i}`,
        type: "function",
        function: { name: `slow_read_${i}`, arguments: "{}" },
      }));
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason: null }] });
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "done" }, finish_reason: null }] });
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mock.listen(9918, () => r()));

const cfg = loadConfig({
  apiKey: "t",
  baseURL: "http://localhost:9918/v1",
  model: "mock",
  workdir: process.cwd(),
  autoApprove: true,
  concurrency: 4,
});
const agent = new Agent({ config: cfg });

const order = [];
const start = Date.now();
for await (const ev of agent.chat("run tools")) {
  if (ev.type === "tool_end") order.push(ev.name);
}
const elapsed = Date.now() - start;
mock.close();

console.log("order:", order.join(", "));
console.log("elapsed:", elapsed, "ms");

const orderOk = order.join(",") === "slow_read_1,slow_read_2,slow_read_3";
const concurrent = elapsed < 800; // 串行需 ~900ms
console.log("order ok:", orderOk, "| concurrent:", concurrent);
if (!orderOk || !concurrent) process.exit(1);
console.log("OK");
