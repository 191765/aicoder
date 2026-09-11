import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CLI 端到端测试：真实启动 dist/cli.js，用一个 mock LLM。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const cli = path.join(root, "dist", "cli.js");

// 确保已构建
if (!fs.existsSync(cli)) {
  console.log("dist 不存在，先构建...");
  spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
}

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const mock = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "E2E-REPLY" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => mock.listen(9930, () => r()));

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString("utf8")));
    child.stderr.on("data", (b) => (out += b.toString("utf8")));
    const timer = setTimeout(() => { child.kill(); resolve(out); }, 20000);
    child.on("close", () => { clearTimeout(timer); resolve(out); });
  });
}

const baseEnv = {
  AICODER_API_KEY: "t",
  AICODER_BASE_URL: "http://localhost:9930/v1",
  AICODER_MODEL: "mock",
  AICODER_WORKDIR: root,
  AICODER_HOME: path.join(root, ".aicoder-e2e-home"),
  AICODER_SUMMARY: "false",
};

// 1. --help
const help = await runCli(["--help"], baseEnv);
ok(help.includes("AICoder"), "cli help shows title");
ok(help.includes("web"), "cli help lists web");

// 2. --prompt
const prompt = await runCli(["--prompt=hello"], baseEnv);
ok(prompt.includes("E2E-REPLY"), "cli prompt gets reply");

// 3. sessions（空）
const sessions = await runCli(["sessions"], baseEnv);
ok(sessions.includes("会话") || sessions.includes("sessions") || sessions.includes("暂无"), "cli sessions command");

mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
