import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { log, initLogger, currentLogLevel } from "../src/logger.js";
import { startSpan, withSpan } from "../src/tracing.js";
import { loadConfig } from "../src/config.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

// ---- 结构化日志 ----
process.env.AICODER_LOG_LEVEL = "debug";
initLogger();
ok(currentLogLevel() === "debug", "log level set");

// 捕获 stderr
const origWrite = process.stderr.write.bind(process.stderr);
let captured = "";
process.stderr.write = ((chunk) => { captured += chunk.toString(); return true; });
process.env.AICODER_LOG_FORMAT = "json";
initLogger();
log.info("hello", { a: 1 });
process.stderr.write = origWrite;
ok(captured.includes('"level":"info"') && captured.includes("hello"), "json log emitted");

// ---- 追踪 ----
const span = startSpan("test.span", { foo: "bar" });
const dur = span.end();
ok(typeof dur === "number" && dur >= 0, "span duration");

const result = await withSpan("test.wrap", async (s) => {
  s.setAttribute("k", "v");
  return 42;
});
ok(result === 42, "withSpan returns value");

let threw = false;
try {
  await withSpan("test.err", async () => { throw new Error("boom"); });
} catch { threw = true; }
ok(threw, "withSpan propagates error");

// ---- 配置 Schema/校验已在 stage7 覆盖，这里验证 logger 初始化不抛 ----
const cfg = loadConfig({ workdir: process.cwd() });
ok(typeof cfg.model === "string", "config loads");

// ---- SBOM 脚本 ----
const { spawnSync } = await import("node:child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-sbom-"));
const sbomOut = path.join(tmp, "sbom.json");
const r = spawnSync(process.execPath, ["scripts/sbom.mjs", sbomOut], { cwd: process.cwd() });
ok(r.status === 0 && fs.existsSync(sbomOut), "sbom generated");
if (fs.existsSync(sbomOut)) {
  const bom = JSON.parse(fs.readFileSync(sbomOut, "utf8"));
  ok(bom.bomFormat === "CycloneDX" && Array.isArray(bom.components), "sbom structure");
}
fs.rmSync(tmp, { recursive: true, force: true });

// ---- /api/run 可编程 API（直接测试 Agent quiet 行为等价）----
// mock LLM
const mock = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "API-OK" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => mock.listen(9940, () => resolve()));
const { Agent } = await import("../src/agent.js");
const apiCfg = loadConfig({ apiKey: "t", baseURL: "http://localhost:9940/v1", model: "mock", workdir: process.cwd(), autoApprove: true });
const agent = new Agent({ config: apiCfg, quiet: true, persist: false });
let text = "";
for await (const ev of agent.chat("hi")) if (ev.type === "text") text += ev.delta;
ok(text === "API-OK", "quiet agent returns text");
mock.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
