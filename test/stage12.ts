import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { loadConfig } from "../src/config.js";
import { initBudget, chargeBudget, isOverBudget, budgetStatus, BudgetExceededError } from "../src/budget.js";
import { verify, detectVerifyCommand, installVerifyTool } from "../src/verify.js";
import { MemoryStore, resetMemoryStore } from "../src/memory-store.js";
import { LocalVectorStore, localEmbed, cosine, installVectorTools } from "../src/vector-store.js";
import { createCheckpoint, listCheckpoints, replayCheckpoint, recentFiles } from "../src/checkpoint.js";
import { buildAgentCard, normalizeTask } from "../src/agent-protocol.js";
import { findTool } from "../src/tools.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-p12-"));
const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://x/v1" });

// ---- 预算强制 ----
initBudget(loadConfig({ workdir: tmp, costBudget: { sessionUsd: 0.001 } }));
ok(!isOverBudget().over, "under budget initially");
let threw = false;
try {
  chargeBudget("gpt-4o", 100000, 100000);
} catch (e) {
  threw = e instanceof BudgetExceededError;
}
ok(threw, "budget exceeded throws");
ok(isOverBudget().over, "isOverBudget after exceed");
ok(budgetStatus().sessionSpent > 0, "budget status spent");
initBudget(loadConfig({ workdir: tmp })); // reset no limits

// ---- 自验证 ----
const okScript = path.join(tmp, "ok.js");
const failScript = path.join(tmp, "fail.js");
fs.writeFileSync(okScript, "process.exit(0);");
fs.writeFileSync(failScript, "process.exit(3);");
const r = await verify(cfg, `node "${okScript}"`);
ok(r.ok && r.exitCode === 0, "verify success");
const r2 = await verify(cfg, `node "${failScript}"`);
ok(!r2.ok && r2.exitCode === 3, "verify failure exit code");
installVerifyTool();
ok(!!findTool("verify"), "verify tool registered");
const detected = await detectVerifyCommand(tmp);
ok(detected === null || typeof detected === "string", "detect verify command");

// ---- 记忆升级 ----
resetMemoryStore();
const store = new MemoryStore(cfg);
await store.load();
await store.add("项目使用 2 空格缩进", { tags: ["style"] });
await store.add("API 基路径是 /api/v1");
store.addShortTerm("刚才修改了 agent.ts");
ok(store.size === 2, "memory entries added");
const hits = await store.search("缩进风格");
ok(hits.length >= 1 && hits[0]!.text.includes("缩进"), "memory keyword search");
const prompt = await store.formatForPrompt("缩进");
ok(prompt.includes("缩进") && prompt.includes("短时"), "memory prompt format");

// ---- 本地向量库 ----
const v1 = localEmbed("hello world");
const v2 = localEmbed("hello world");
const v3 = localEmbed("completely different");
ok(Math.abs(cosine(v1, v2) - 1) < 1e-6, "local embed deterministic");
ok(cosine(v1, v2) > cosine(v1, v3), "similar text higher cosine");
const vs = new LocalVectorStore(tmp);
await vs.load();
await vs.add("a.ts", "export function addNumbers(a, b) { return a + b; }");
await vs.add("b.ts", "class UserRepository { findById() {} }");
await vs.add("c.ts", "const PI = 3.14;");
const vr = await vs.search("add numbers function", 2);
ok(vr.length === 2 && vr[0]!.score >= vr[1]!.score, "vector search sorted");
await vs.save();
ok(fs.existsSync(path.join(tmp, ".aicoder", "vectors.json")), "vector store persisted");
installVectorTools();
ok(!!findTool("semantic_search"), "semantic_search tool registered");

// ---- 检查点/回放 ----
const target = path.join(tmp, "keep.txt");
fs.writeFileSync(target, "original-content");
const cps = await createCheckpoint(tmp, "test-cp", [{ role: "user", content: "hi" }], "sess1", ["keep.txt"]);
ok(cps.id.startsWith("cp-"), "checkpoint created");
fs.writeFileSync(target, "changed-content");
const list = await listCheckpoints(tmp);
ok(list.length === 1 && list[0]!.id === cps.id, "list checkpoints");
const replay = await replayCheckpoint(tmp, cps.id);
ok(fs.readFileSync(target, "utf8") === "original-content", "replay restored file");
ok(replay.messages.length === 1, "replay restored messages");
const recent = await recentFiles(tmp, 10);
ok(recent.includes("keep.txt"), "recent files");

// ---- Agent 协议 ----
const card = buildAgentCard(cfg, 30, "0.1.0");
ok(card.name === "AICoder" && card.capabilities.tools === 30, "agent card");
ok(card.capabilities.skills.length >= 3, "agent skills");
ok(card.endpoints.tasks === "/api/agent/tasks", "agent endpoints");
const task = normalizeTask({ input: "hi", useRag: true });
ok(task.input === "hi" && task.useRag === true, "normalize task");

// ---- 端到端：Agent 协议端点（mock LLM）----
const mock = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "task-done" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => mock.listen(9960, () => resolve()));
const { Agent } = await import("../src/agent.js");
const apiCfg = loadConfig({ apiKey: "t", baseURL: "http://localhost:9960/v1", model: "mock", workdir: tmp, autoApprove: true });
const agent = new Agent({ config: apiCfg, quiet: true, persist: false });
let out = "";
for await (const ev of agent.chat("hi")) if (ev.type === "text") out += ev.delta;
ok(out === "task-done", "agent quiet output");
mock.close();

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
