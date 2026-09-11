import { spawn } from "node:child_process";
import { registerTool, type ToolDef, type ToolContext } from "./tools.js";
import type { Config } from "./config.js";

/**
 * 自验证回路
 *
 * 提供 `verify` 工具：运行项目的测试/构建命令并给出结构化结果，
 * 便于 Agent 在修改后自动验证并对失败进行修复。
 *
 * 命令来源（按优先级）：
 *   1. 工具参数 command
 *   2. 配置 verify.commands
 *   3. 自动探测 package.json 的 test / build 脚本
 */

export interface VerifyResult {
  ok: boolean;
  command: string;
  exitCode: number;
  output: string;
  durationMs: number;
}

function run(
  command: string,
  cwd: string,
  timeout: number
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(
      isWin ? "powershell.exe" : "/bin/sh",
      isWin
        ? ["-NoProfile", "-NonInteractive", "-Command", `${command}; exit $LASTEXITCODE`]
        : ["-c", command],
      { cwd }
    );
    let out = "";
    const cap = 30_000;
    const onData = (b: Buffer) => {
      if (out.length < cap) out += b.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out: out + `\n[超时 ${timeout}ms]` });
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `执行失败: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.slice(0, cap) });
    });
  });
}

/** 推断默认验证命令 */
export async function detectVerifyCommand(workdir: string): Promise<string | null> {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(`${workdir}/package.json`, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    if (scripts.test && !scripts.test.includes("Error: no test")) return "npm test";
    if (scripts.build) return "npm run build";
    return null;
  } catch {
    return null;
  }
}

export async function verify(
  config: Config,
  commandOverride?: string,
  timeout = 300_000
): Promise<VerifyResult> {
  const command =
    commandOverride ??
    config.verify?.commands?.[0] ??
    (await detectVerifyCommand(config.workdir)) ??
    "npm test";
  const start = Date.now();
  const { code, out } = await run(command, config.workdir, timeout);
  return {
    ok: code === 0,
    command,
    exitCode: code,
    output: out,
    durationMs: Date.now() - start,
  };
}

let installed = false;

const verifyTool: ToolDef = {
  name: "verify",
  description:
    "运行项目的验证命令（默认测试，可配置），返回是否通过、退出码与输出。修改代码后用它自检，失败时根据输出修复后重试。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要运行的命令（可选，默认项目测试命令）" },
      timeout_ms: { type: "number", description: "超时毫秒，默认 300000" },
    },
    required: [],
  },
  async run(args, ctx: ToolContext) {
    const command = typeof args.command === "string" ? args.command : undefined;
    const timeout =
      typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : 300_000;
    const r = await verify(ctx.config, command, timeout);
    const head = r.ok ? "✅ 验证通过" : "❌ 验证失败";
    return `${head}\n命令: ${r.command}\n退出码: ${r.exitCode}  耗时: ${r.durationMs}ms\n\n${r.output}`;
  },
};

export function installVerifyTool(): void {
  if (installed) return;
  installed = true;
  registerTool(verifyTool);
}
