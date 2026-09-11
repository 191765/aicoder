import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";
import { loadPlugins, findPluginCommand, listPluginCommands } from "../src/plugins.js";
import { initSecurity, checkCommand, scanSecrets, checkContent, redactSecrets } from "../src/security.js";
import { initObservability, recordUsage, getUsage, estimateCost } from "../src/observability.js";
import { tools, findTool } from "../src/tools.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-p4-"));

// ---- 插件 ----
const pluginPath = path.join(tmp, "my-plugin.mjs");
fs.writeFileSync(pluginPath, `
export default {
  name: "demo",
  tools: [
    { name: "hello", description: "打招呼", mutating: false, async run(args) { return "hello " + (args.who || "world"); } }
  ],
  commands: [
    { name: "greet", description: "问候命令", run(ctx) { ctx.print("hi"); } }
  ]
};
`);
const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://x/v1" });
const report = await loadPlugins(cfg, ["./my-plugin.mjs"]);
ok(report.length === 1 && !report[0].error, "plugin loaded without error");
ok(report[0].tools.length === 1, "plugin tool registered");
const hello = findTool("plugin__demo__hello");
ok(!!hello, "plugin tool namespaced");
if (hello) {
  const ctx = { workdir: tmp, config: cfg, approved: true };
  const out = await hello.run({ who: "AICoder" }, ctx);
  ok(out === "hello AICoder", "plugin tool runs");
}
ok(findPluginCommand("/greet")?.plugin === "demo", "find plugin command");
ok(listPluginCommands().length === 1, "list plugin commands");

// ---- 安全 ----
initSecurity(cfg);
ok(!checkCommand("rm -rf /").allowed, "block rm -rf /");
ok(!checkCommand("mkfs.ext4 /dev/sda").allowed, "block mkfs");
ok(checkCommand("npm test").allowed, "allow npm test");
ok(!checkCommand(":(){ :|:& };:").allowed, "block fork bomb");

const secrets = scanSecrets("token sk-abcdefghijklmnopqrstuvwx and AKIAIOSFODNN7EXAMPLE");
ok(secrets.length >= 2, "scan finds multiple secrets");
ok(redactSecrets("key sk-abcdefghijklmnopqrstuvwx").includes("[REDACTED"), "redact secrets");
const sc = checkContent("my api key is sk-abcdefghijklmnopqrstuvwx");
ok(!sc.allowed, "block secret write by default");
ok(sc.findings.length === 1, "secret finding reported");

// redact 模式
const cfg2 = loadConfig({ workdir: tmp, security: { secretScan: true, redactSecrets: true, blockedCommands: [] } });
initSecurity(cfg2);
const sc2 = checkContent("my api key is sk-abcdefghijklmnopqrstuvwx");
ok(sc2.allowed && sc2.redacted && !sc2.redacted.includes("sk-abcdef"), "redact mode allows");

// ---- 观测 ----
initObservability(cfg);
recordUsage({ model: "gpt-4o-mini", messages: [{ content: "hello ".repeat(100) }], outputText: "world".repeat(50), durationMs: 100, steps: 1, toolCalls: 0 });
const usage = getUsage();
ok(usage.calls === 1, "usage calls recorded");
ok(usage.inputTokens > 0 && usage.outputTokens > 0, "tokens estimated");
ok(usage.costUsd > 0, "cost estimated");
ok(estimateCost("gpt-4o", 1000, 1000) > estimateCost("gpt-4o-mini", 1000, 1000), "pricing differs by model");

// ---- 编排工具已注册 ----
const { installOrchestratorTools } = await import("../src/orchestrator.js");
installOrchestratorTools();
ok(!!findTool("parallel"), "parallel tool registered");
ok(!!findTool("pipeline"), "pipeline tool registered");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
