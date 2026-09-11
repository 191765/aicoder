import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadWorkflows, getWorkflow, renderWorkflow, builtinWorkflows } from "../src/workflows.js";
import { rerank, sliceCode, DependencyGraph } from "../src/context-enhance.js";
import { CodeIndex } from "../src/rag.js";
import { SymbolIndex } from "../src/symbols.js";
import { createSnapshot, restoreSnapshot, listSnapshots, lastSnapshot, installSnapshotTools } from "../src/snapshots.js";
import { loadConfig } from "../src/config.js";
import { findTool } from "../src/tools.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-p9-"));
const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://x/v1" });

// ---- 工作流 ----
const flows = await loadWorkflows(cfg);
ok(flows.length >= 6, "builtin workflows loaded");
ok(builtinWorkflows().every((w) => w.source === "builtin"), "builtin source");
const review = getWorkflow(flows, "review")!;
ok(review !== undefined, "get review workflow");
const rendered = renderWorkflow(review, "src/a.ts", tmp);
ok(rendered.includes("src/a.ts") && !rendered.includes("{{args}}"), "render replaces args");

// 自定义工作流
fs.mkdirSync(path.join(tmp, ".aicoder", "workflows"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".aicoder", "workflows", "custom.md"), "# 自定义\n请做自定义任务 {{args}}");
const flows2 = await loadWorkflows(cfg);
const custom = getWorkflow(flows2, "custom");
ok(custom?.source === "user", "user workflow loaded");

// ---- 上下文增强：rerank ----
const hits = [
  { file: "a.ts", start: 1, end: 5, score: 1.0, preview: "function add numbers" },
  { file: "b.ts", start: 1, end: 5, score: 0.9, preview: "unrelated content here" },
  { file: "add.ts", start: 1, end: 5, score: 0.5, preview: "add helper" },
];
const reranked = rerank(hits, "add function");
ok(reranked[0].score >= reranked[reranked.length - 1].score, "rerank sorted");
ok(reranked.some((h) => h.file === "a.ts"), "relevant kept");

// ---- 代码切片 ----
const code = "function unrelated() {\n  return 1;\n}\n\nfunction targetAdd(a, b) {\n  return a + b;\n}";
const slice = sliceCode(code, "targetAdd");
ok(slice.includes("targetAdd"), "slice picks relevant block");

// ---- 依赖图 ----
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "a.ts"), "import { b } from './b';\nexport const a = b + 1;");
fs.writeFileSync(path.join(tmp, "src", "b.ts"), "export const b = 2;");
fs.writeFileSync(path.join(tmp, "src", "c.ts"), "export const c = 3;");
const graph = new DependencyGraph(tmp);
await graph.build(["src/a.ts", "src/b.ts", "src/c.ts"]);
ok(graph.related("src/a.ts").includes("src/b.ts"), "dependency graph edge");
const closure = graph.relatedClosure(["src/b.ts"], 1);
ok(closure.has("src/a.ts"), "reverse dependency in closure");

// ---- 增量索引 ----
const idx = new CodeIndex(cfg);
await idx.build();
const before = idx.size;
fs.writeFileSync(path.join(tmp, "src", "newfile.ts"), "export const newThing = 42;\n".repeat(5));
const changed = await idx.updateFile("src/newfile.ts");
ok(changed && idx.size > before, "incremental add");
const removed = await idx.removeFile("src/newfile.ts");
ok(removed && idx.size === before, "incremental remove");

const sym = new SymbolIndex(cfg);
await sym.build();
const symBefore = sym.size;
fs.writeFileSync(path.join(tmp, "src", "symnew.ts"), "export function brandNewSym() {}");
const symChanged = await sym.updateFile("src/symnew.ts");
ok(symChanged && sym.size > symBefore, "symbol incremental update");

// ---- 快照与恢复 ----
const target = path.join(tmp, "src", "a.ts");
const original = fs.readFileSync(target, "utf8");
const snap = await createSnapshot(tmp, ["src/a.ts", "src/nonexist.ts"], "test");
ok(snap.files.length === 2 && snap.files[1].existed === false, "snapshot captured");
fs.writeFileSync(target, "MODIFIED");
fs.writeFileSync(path.join(tmp, "src", "nonexist.ts"), "created later");
const restored = await restoreSnapshot(tmp, snap.id);
ok(restored.restored >= 1, "restore count");
ok(fs.readFileSync(target, "utf8") === original, "file restored to original");
ok(!fs.existsSync(path.join(tmp, "src", "nonexist.ts")), "new file removed on rollback");
const snaps = await listSnapshots(tmp);
ok(snaps.length >= 1, "list snapshots");
ok((await lastSnapshot(tmp))?.id === snap.id, "last snapshot");

installSnapshotTools();
ok(!!findTool("restore_snapshot"), "restore_snapshot tool registered");
ok(!!findTool("list_snapshots"), "list_snapshots tool registered");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
