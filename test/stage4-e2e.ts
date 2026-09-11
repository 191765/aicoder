import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";
import { Agent } from "../src/agent.js";
import { initSecurity } from "../src/security.js";
import { findTool } from "../src/tools.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-orch-"));
let subCalls = 0;

// mock：主代理调用 parallel，子代理返回结论
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const isSub = body.includes("编排子代理");
    const parsed = JSON.parse(body);
    const hasToolResult = parsed.messages.some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (isSub) {
      subCalls++;
      send({ id: "s", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `子代理结论#${subCalls}` }, finish_reason: null }] });
      send({ id: "s", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    } else if (!hasToolResult) {
      // 派发 parallel
      const tasks = [
        { description: "任务A", prompt: "做A" },
        { description: "任务B", prompt: "做B" },
      ];
      send({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "p1", type: "function", function: { name: "parallel", arguments: JSON.stringify({ tasks }) } }] }, finish_reason: null }] });
      send({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "收到并行结果。" }, finish_reason: null }] });
      send({ id: "m", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mock.listen(9916, () => r()));

const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://localhost:9916/v1", model: "mock", autoApprove: true });
initSecurity(cfg);
const agent = new Agent({ config: cfg });

let parallelResult = "";
for await (const ev of agent.chat("并行做两件事")) {
  if (ev.type === "tool_end" && ev.name === "parallel") parallelResult = ev.result;
  if (ev.type === "error") console.log("ERR:", ev.message);
}
console.log("subCalls:", subCalls);
console.log("parallelResult:", parallelResult.slice(0, 200));
const okParallel = parallelResult.includes("子代理结论") && parallelResult.includes("任务A") && parallelResult.includes("任务B");

// ---- 安全：写文件拦截密钥 ----
const writeTool = findTool("write_file");
const ctx = { workdir: tmp, config: cfg, approved: true };
let blocked = false;
try {
  await writeTool.run({ path: "leak.txt", content: "key sk-abcdefghijklmnopqrstuvwx" }, ctx);
} catch (e) {
  blocked = /密钥/.test(e.message);
}

mock.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("parallel ok:", okParallel, "| secret write blocked:", blocked);
if (!okParallel || !blocked) process.exit(1);
console.log("OK");
