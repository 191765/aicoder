import http from "node:http";
import { loadConfig } from "../src/config.js";
import { Agent } from "../src/agent.js";

/**
 * 压力测试：并发运行多个 Agent，检验稳定性与正确性。
 */

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

let served = 0;
const mock = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    served++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mock.listen(9931, () => r()));

const cfg = loadConfig({
  apiKey: "t",
  baseURL: "http://localhost:9931/v1",
  model: "mock",
  workdir: process.cwd(),
});

const N = 30;
const start = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const agent = new Agent({ config: cfg, quiet: true });
    let text = "";
    for await (const ev of agent.chat(`req ${i}`)) {
      if (ev.type === "text") text += ev.delta;
    }
    return text;
  })
);
const elapsed = Date.now() - start;

ok(results.length === N, "all agents completed");
ok(results.every((r) => r === "ok"), "all replies correct");
ok(served === N, "server received N requests");
console.log(`并发 ${N} 个 Agent，耗时 ${elapsed}ms，请求 ${served} 次`);

// 大量历史下的上下文裁剪压力
const { buildContext } = await import("../src/context.js");
const history = [];
for (let i = 0; i < 5000; i++) {
  history.push({ role: "user", content: `m${i} `.repeat(30) });
  history.push({ role: "assistant", content: `r${i} `.repeat(30) });
}
const t2 = Date.now();
const ctx = buildContext("sys", history, {
  maxContextTokens: 8000,
  reserveForOutput: 1000,
  keepRecentMessages: 6,
  toolResultMaxChars: 4000,
});
const trimMs = Date.now() - t2;
ok(ctx.trimmed, "huge history trimmed");
ok(ctx.messages.length < 300, "trimmed to bounded window");
console.log(`裁剪 10000 条消息耗时 ${trimMs}ms，保留 ${ctx.messages.length} 条`);

mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
