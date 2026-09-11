import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateConfig, migrateConfig, configJsonSchema, CURRENT_CONFIG_VERSION } from "../src/config-schema.js";
import { loadConfig } from "../src/config.js";
import { generateSummary, getProjectSummary, loadCachedSummary } from "../src/summary.js";
import { applyEdits } from "../src/editer.js";
import { installEditEngine } from "../src/editer.js";
import { findTool, tools } from "../src/tools.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

// ---- 配置校验 ----
ok(validateConfig({ model: "x", temperature: 0.5 }).length === 0, "valid config");
const bad = validateConfig({ model: 123, context: { maxContextTokens: "x" }, unknownKey: 1 });
ok(bad.some((i) => i.path === "model"), "detect wrong type");
ok(bad.some((i) => i.path === "context.maxContextTokens"), "detect nested wrong type");
ok(bad.some((i) => i.path === "unknownKey" && i.severity === "warning"), "warn unknown key");
const badUsers = validateConfig({ users: [{ name: "x" }] });
ok(badUsers.some((i) => i.path.includes("token")), "detect missing user token");

// ---- 迁移 ----
const migrated = migrateConfig({
  blockedCommands: ["rm"],
  auditLog: "a.log",
  traceFile: "t.log",
});
ok(migrated.config.security?.blockedCommands?.[0] === "rm", "migrate blockedCommands");
ok(migrated.config.security?.auditLog === "a.log", "migrate auditLog");
ok(migrated.config.observability?.logFile === "t.log", "migrate traceFile");
ok(migrated.config.$version === CURRENT_CONFIG_VERSION, "version bumped");
ok(migrated.migrations.length >= 2, "migrations reported");

// schema 生成
const schema = configJsonSchema();
ok(schema.type === "object" && schema.properties.model, "schema generated");

// ---- 编辑引擎 ----
const original = "a\nb\nc\nd\n";
const r1 = applyEdits(original, [
  { old_string: "a", new_string: "A" },
  { old_string: "c", new_string: "C" },
]);
ok(r1.errors.length === 0, "multi edit no errors");
ok(r1.text === "A\nb\nC\nd\n", "multi edit applied");

const r2 = applyEdits(original, [
  { old_string: "a", new_string: "A" },
  { old_string: "zzz", new_string: "X" },
]);
ok(r2.errors.length === 1, "conflict detected");
ok(r2.text.includes("A") && !r2.errors.length === false, "partial (engine) - caller must rollback");

const r3 = applyEdits("x x x", [{ old_string: "x", new_string: "y", unique: false }]);
ok(r3.text === "y y y", "non-unique replace all");

installEditEngine();
ok(!!findTool("multi_edit"), "multi_edit registered");

// ---- 项目摘要 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-p7-"));
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "a.ts"), "export const x = 1;");
fs.writeFileSync(path.join(tmp, "README.md"), "# demo");
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x", scripts: { test: "echo" }, dependencies: { foo: "1" } }));

const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://x/v1" });
const summary = await generateSummary(cfg);
ok(summary.text.includes("文件总数"), "summary has file count");
ok(summary.languages.some((l) => l.lang === "TypeScript"), "summary detects language");
ok(summary.text.includes("npm 脚本") || summary.text.includes("test"), "summary includes scripts");

const cached = await getProjectSummary(cfg);
ok(cached.includes("文件总数"), "summary cached/returned");
ok((await loadCachedSummary(cfg)) !== null, "summary file saved");

// ---- 多模态 content tokens ----
const { estimateTokens } = await import("../src/context.js");
const { messageTokens } = await import("../src/context.js");
const imgMsg = { role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,xxx" } }] };
ok(messageTokens(imgMsg) > estimateTokens("hello") + 4, "image tokens counted");

fssCleanup(tmp);
function fssCleanup(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
