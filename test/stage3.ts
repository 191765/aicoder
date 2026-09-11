import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadLayeredConfig, mergeConfig } from "../src/configfile.js";
import { loadConfig } from "../src/config.js";
import {
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  buildSession,
  sessionsDir,
} from "../src/session.js";
import { ModelRouter, inferTaskForTool } from "../src/router.js";

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) pass++;
  else { fail++; console.error("FAIL:", label); }
}

// 临时目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-test-"));
const prevHome = process.env.AICODER_HOME;
process.env.AICODER_HOME = path.join(tmp, "home");
process.env.AICODER_WORKDIR = tmp;

// ---- mergeConfig ----
const merged = mergeConfig(
  { a: 1, obj: { x: 1 }, arr: [1] },
  { a: 2, obj: { y: 2 }, arr: [2] }
);
ok(merged.a === 2, "scalar override");
ok(merged.obj.x === 1 && merged.obj.y === 2, "deep merge object");
ok(JSON.stringify(merged.arr) === "[1,2]", "array concat");

// ---- 层级配置 ----
// 全局
const globalPath = path.join(tmp, "home", "aicoder", "aicoder.json");
fs.mkdirSync(path.dirname(globalPath), { recursive: true });
fs.writeFileSync(globalPath, JSON.stringify({
  model: "global-model",
  permissions: ["allow:read_file"],
  context: { maxContextTokens: 1111 },
}));
// 项目
const projPath = path.join(tmp, ".aicoder.json");
fs.writeFileSync(projPath, JSON.stringify({
  model: "project-model",
  permissions: ["deny:run_command(rm)"],
  context: { keepRecentMessages: 3 },
}));

const layered = loadLayeredConfig(tmp);
ok(layered.config.model === "project-model", "project overrides global model");
ok(layered.config.permissions.length === 2, "permissions concatenated");
ok(layered.config.context.maxContextTokens === 1111, "global context kept");
ok(layered.config.context.keepRecentMessages === 3, "project context merged");
ok(layered.sources.length === 2, "two config sources");

const cfg = loadConfig({ workdir: tmp });
ok(cfg.model === "project-model", "loadConfig uses layered model");
ok(cfg.rules.length === 2, "rules parsed from layers");

// ---- 会话持久化 ----
const s1 = buildSession("sess-1", tmp, "m1", [
  { role: "user", content: "帮我写一个函数" },
  { role: "assistant", content: "好的" },
]);
ok(s1.title.includes("帮我写"), "derive title");
await saveSession(s1);
const loaded = await loadSession("sess-1");
ok(loaded && loaded.messages.length === 2, "load session");
const list = await listSessions();
ok(list.length === 1 && list[0].id === "sess-1", "list sessions");
ok(sessionsDir().startsWith(tmp), "sessions dir under AICODER_HOME");
const del = await deleteSession("sess-1");
ok(del, "delete session");
ok((await listSessions()).length === 0, "list after delete");

// ---- 模型路由 ----
const router = new ModelRouter(
  { model: "base", baseURL: "u", apiKey: "k", temperature: 0.2 },
  [
    { match: { input: "重构|架构" }, model: "strong" },
    { match: { task: "explore" }, model: "cheap" },
    { model: "default" },
  ]
);
ok(router.resolve({ task: "chat", input: "请重构这段代码" }).model === "strong", "route by input regex");
ok(router.resolve({ task: "explore", input: "看看文件" }).model === "cheap", "route by task");
ok(router.resolve({ task: "chat", input: "你好" }).model === "default", "route default");
ok(inferTaskForTool("read_file") === "explore", "infer explore");
ok(inferTaskForTool("edit_file") === "edit", "infer edit");
ok(inferTaskForTool("run_command") === "test", "infer test");

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
if (prevHome === undefined) delete process.env.AICODER_HOME;
else process.env.AICODER_HOME = prevHome;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
