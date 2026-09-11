import http from "node:http";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { attachRealtime, closeRealtime } from "../src/realtime.js";

// mock LLM：第一次请求触发 run_command 工具
let llmCalls = 0;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const hasTool = JSON.parse(body).messages.some((m) => m.role === "tool");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!hasTool) {
      llmCalls++;
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "run_command", arguments: '{"command":"echo hi"}' } }] }, finish_reason: null }] });
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "done after tool" }, finish_reason: null }] });
      send({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mock.listen(9920, () => r()));

const cfg = loadConfig({
  apiKey: "t",
  baseURL: "http://localhost:9920/v1",
  model: "mock",
  workdir: process.cwd(),
});
const config = { ...cfg, autoApprove: false };

// 起一个 HTTP 服务器挂载 WS
const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
await new Promise((r) => server.listen(9921, () => r()));
attachRealtime(server, config, "tok", (t) => t === "tok");

const events = [];
const ws = new WebSocket("ws://localhost:9921/ws?token=tok");
let confirmed = false;

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout")), 15000);
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "chat", message: "跑个命令" }));
  });
  ws.on("message", (data) => {
    const ev = JSON.parse(data.toString());
    events.push(ev.type);
    if (ev.type === "confirm") {
      confirmed = true;
      // 批准
      ws.send(JSON.stringify({ type: "confirm_result", id: ev.id, allow: true }));
    }
    if (ev.type === "end") {
      clearTimeout(timer);
      resolve();
    }
    if (ev.type === "error") {
      console.log("ERR:", ev.message);
    }
  });
  ws.on("error", reject);
});

ws.close();
server.close();
mock.close();
closeRealtime();

console.log("events:", events.join(", "));
console.log("confirm received:", confirmed);
const okFlow = confirmed && events.includes("tool_start") && events.includes("tool_end") && events.includes("end");
console.log("ok:", okFlow, "| llmCalls:", llmCalls);
if (!okFlow) process.exit(1);
console.log("OK");
process.exit(0);
