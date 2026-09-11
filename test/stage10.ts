import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { ResponseCache } from "../src/cache.js";
import { createFallbackProvider } from "../src/fallback.js";
import { initSandbox, sandboxEnv, wrapCommand, sandboxStatus } from "../src/sandbox.js";
import { installPlugin, addPluginToConfig } from "../src/marketplace.js";
import { builtinEvals, compareWithBaseline } from "../src/eval.js";
import { recordFeedback, readFeedback, exportTrainingData, installFeedbackTool } from "../src/feedback.js";
import { detectChannel, parseIncoming, formatReply } from "../src/channels.js";
import { loadConfig } from "../src/config.js";
import { findTool } from "../src/tools.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-p10-"));
const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://x/v1" });

// ---- 响应缓存 ----
const cache = new ResponseCache({ enabled: true, ttlMs: 60000, maxEntries: 2, persistent: false, dir: "" });
const key = ResponseCache.key("m", [{ role: "user", content: "hi" }], [], 0);
ok(cache.get(key) === null, "cache miss");
await cache.set(key, [{ type: "text", delta: "hello" }], "m");
ok(cache.get(key)?.[0].type === "text", "cache hit");
const key2 = ResponseCache.key("m", [{ role: "user", content: "hi" }], [], 0);
ok(key === key2, "deterministic key");
const key3 = ResponseCache.key("m", [{ role: "user", content: "hi" }], [], 0.5);
ok(key !== key3, "different temp -> different key");
ok(cache.getStats().hits >= 1, "cache stats");

// ---- 模型降级链 ----
let attempts = 0;
const mock = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    attempts++;
    if (attempts < 2) {
      res.writeHead(500);
      res.end("fail");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "fallback-ok" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => mock.listen(9950, () => resolve()));
const fbCfg = loadConfig({
  apiKey: "t",
  baseURL: "http://localhost:9950/v1",
  model: "primary",
  workdir: tmp,
  retry: { maxRetries: 0, baseDelayMs: 1 },
});
const fbProvider = createFallbackProvider(fbCfg, [{ model: "backup" }]);
let fbText = "";
for await (const ev of fbProvider.stream([{ role: "user", content: "hi" }], [])) {
  if (ev.type === "text") fbText += ev.delta;
  if (ev.type === "error") console.log("fb err:", ev.message);
}
ok(fbText === "fallback-ok", "fallback chain works");
mock.close();

// ---- 沙箱 ----
process.env.SECRET_TOKEN = "should-be-scrubbed";
initSandbox(loadConfig({ workdir: tmp, sandbox: { enabled: true, envAllowlist: ["PATH"], noNetwork: false } }));
const env = sandboxEnv();
ok(env.PATH !== undefined, "sandbox keeps PATH");
ok(env.SECRET_TOKEN === undefined, "sandbox scrubs secrets");
ok(sandboxStatus().enabled === true, "sandbox status");
const wrapped = wrapCommand("echo hi");
ok(typeof wrapped.shell === "string" && wrapped.maxOutputBytes > 0, "wrapCommand result");
initSandbox(cfg); // 关闭

// ---- 插件市场：包名校验 + 写入配置 ----
const bad = await installPlugin(cfg, "bad; rm -rf /");
ok(!bad.ok, "reject illegal package name");
const cfgPath = await addPluginToConfig(cfg, "example-plugin");
ok(fs.existsSync(cfgPath), "plugin config written");
const written = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
ok(written.plugins.includes("example-plugin"), "plugin added to config");

// ---- 评估基准 ----
const evals = builtinEvals();
ok(evals.length >= 2, "builtin evals");
ok(evals.every((e) => e.checks.length > 0), "evals have checks");
const cmp = compareWithBaseline(
  { total: 1, passed: 0, score: 0.5, ts: 0, results: [{ name: "t", passed: false, score: 0.5, details: [], durationMs: 0, text: "" }] },
  { total: 1, passed: 1, score: 1, ts: 0, results: [{ name: "t", passed: true, score: 1, details: [], durationMs: 0, text: "" }] }
);
ok(cmp.regressions.length === 1, "detect regression");

// ---- 反馈与微调 ----
await recordFeedback(tmp, { ts: Date.now(), rating: 1, prompt: "p1", response: "good" });
await recordFeedback(tmp, { ts: Date.now(), rating: -1, prompt: "p1", response: "bad" });
await recordFeedback(tmp, { ts: Date.now(), rating: 1, prompt: "p2", response: "nice" });
const fb = await readFeedback(tmp);
ok(fb.length === 3, "feedback recorded");
const sft = await exportTrainingData(tmp, "sft");
ok(sft.count === 2, "sft export count");
const dpo = await exportTrainingData(tmp, "dpo");
ok(dpo.count === 1, "dpo export count");
installFeedbackTool();
ok(!!findTool("submit_feedback"), "feedback tool registered");

// ---- 多渠道 ----
ok(detectChannel({ "user-agent": "Slackbot" }, {}) === "slack", "detect slack");
ok(detectChannel({}, { msgtype: "text" }) === "dingtalk", "detect dingtalk");
const slackMsg = parseIncoming("slack", { event: { text: "hello slack", user: "U1" } });
ok(slackMsg?.text === "hello slack", "parse slack");
const feishuMsg = parseIncoming("feishu", { event: { message: { content: JSON.stringify({ text: "hi feishu" }) } } });
ok(feishuMsg?.text === "hi feishu", "parse feishu");
const generic = parseIncoming("generic", { message: "hi" });
ok(generic?.text === "hi", "parse generic");
ok(formatReply("slack", "x").text === "x", "format slack");
ok((formatReply("dingtalk", "x").text as { content: string }).content === "x", "format dingtalk");

fs.rmSync(tmp, { recursive: true, force: true });
delete process.env.SECRET_TOKEN;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
