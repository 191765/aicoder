import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";
import { initExtensions, shutdownExtensions } from "../src/runtime.js";
import { findTool, tools } from "../src/tools.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-int-"));

// mock MCP server
const mcpPath = path.join(tmp, "mcp.cjs");
fs.writeFileSync(mcpPath, `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "mock", version: "1" } } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object", properties: {} } }] } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "pong" }] } });
});
`);

// plugin
const plugPath = path.join(tmp, "plug.mjs");
fs.writeFileSync(plugPath, `export default { name: "demo", tools: [{ name: "hi", description: "hi", mutating: false, async run(){ return "hi"; } }], commands: [{ name: "ping", run(){} }] };`);

const cfgPath = path.join(tmp, ".aicoder.json");
fs.writeFileSync(cfgPath, JSON.stringify({
  mcpServers: { mock: { command: process.execPath, args: [mcpPath] } },
  plugins: ["./plug.mjs"],
  lspServers: { typescript: { command: "typescript-language-server", args: ["--stdio"] } },
}));

const cfg = loadConfig({ workdir: tmp, apiKey: "t", baseURL: "http://x/v1" });
const report = await initExtensions(cfg);
console.log("report:", JSON.stringify(report));

ok(report.mcp.length === 1 && report.mcp[0].tools === 1, "mcp loaded");
ok(report.plugins.length === 1 && !report.plugins[0].error, "plugin loaded");
ok(report.lsp === 1, "lsp configured");
ok(!!findTool("mcp__mock__ping"), "mcp tool registered");
ok(!!findTool("plugin__demo__hi"), "plugin tool registered");
ok(!!findTool("git_status"), "git tool registered");
ok(!!findTool("find_symbol"), "symbol tool registered");
ok(!!findTool("remember"), "memory tool registered");
ok(!!findTool("github_pr_view"), "github tool registered");

// 调用 mcp 工具
const ping = findTool("mcp__mock__ping");
const ctx = { workdir: tmp, config: cfg, approved: true };
const out = await ping.run({}, ctx);
ok(out === "pong", "mcp tool call works");

shutdownExtensions();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
