import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";
import { loadProjectMemory, installMemoryTool } from "../src/memory.js";
import { SymbolIndex, installSymbolTools, resetSymbolIndex } from "../src/symbols.js";
import { setLocale, getLocale, t } from "../src/i18n.js";
import { installGithubTools } from "../src/github.js";
import { findTool, tools } from "../src/tools.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-p5-"));

// ---- 项目记忆 ----
fs.writeFileSync(path.join(tmp, "AGENTS.md"), "# 约定\n- 使用 2 空格缩进\n- 提交信息用中文");
fs.mkdirSync(path.join(tmp, ".aicoder", "notes"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".aicoder", "notes", "arch.md"), "架构说明：分层设计");
const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://x/v1" });
const mem = await loadProjectMemory(cfg);
ok(mem.conventions.includes("2 空格缩进"), "AGENTS.md loaded");
ok(mem.conventions.includes("架构说明"), "notes loaded");
ok(mem.sources.length === 2, "two memory sources");

// remember 工具写入
installMemoryTool();
const remember = findTool("remember");
const ctx = { workdir: tmp, config: cfg, approved: true };
await remember.run({ content: "测试结论" }, ctx);
const mem2 = await loadProjectMemory(cfg);
ok(mem2.conventions.includes("测试结论"), "remember persisted");

// ---- 符号索引 ----
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "a.ts"), [
  "export function add(a: number, b: number) { return a + b; }",
  "export class Calculator {",
  "  multiply(x: number) { return x * 2; }",
  "}",
  "export const PI = 3.14;",
].join("\n"));
fs.writeFileSync(path.join(tmp, "src", "b.ts"), [
  "import { add } from './a';",
  "const r = add(1, 2);",
  "add(3, 4);",
].join("\n"));

const idx = new SymbolIndex(cfg);
const n = await idx.build();
ok(n >= 4, "symbols extracted (" + n + ")");
const addDefs = idx.find("add");
ok(addDefs.some((d) => d.kind === "function" && d.file === "src/a.ts"), "find add function");
ok(idx.find("Calc").length >= 1, "fuzzy find Calculator");
const refs = await idx.references("add");
ok(refs.some((r) => r.file === "src/b.ts"), "cross-file references");
ok(refs.length >= 3, "multiple references");

resetSymbolIndex();
installSymbolTools();
ok(!!findTool("find_symbol"), "find_symbol registered");
ok(!!findTool("find_references"), "find_references registered");

// ---- i18n ----
setLocale("en");
ok(getLocale() === "en", "locale en");
ok(t("app.ready") === "Ready", "en translation");
setLocale("zh");
ok(t("app.ready") === "就绪", "zh translation");
setLocale("en-US");
ok(getLocale() === "en", "prefix locale match");
setLocale(undefined);

// ---- GitHub 工具注册 ----
installGithubTools();
ok(!!findTool("github_pr_view"), "github_pr_view registered");
ok(!!findTool("github_issue_view"), "github_issue_view registered");
ok(!!findTool("github_ci_logs"), "github_ci_logs registered");

// ---- 重试配置 ----
ok(cfg.retry.maxRetries === 3 && cfg.retry.baseDelayMs === 500, "retry defaults");
ok(cfg.toolTimeoutMs === 120000, "tool timeout default");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
