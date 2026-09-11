import { spawn } from "node:child_process";
import { registerTool, safeResolve, type ToolDef, type ToolContext } from "./tools.js";

/**
 * Git 集成工具
 *
 * 提供常用只读查询（status/diff/log/show/branch）与一次受控的提交能力。
 * 所有命令都在工作目录内执行，参数经过转义，避免注入。
 */

let installed = false;

function runGit(
  ctx: ToolContext,
  args: string[],
  timeout = 30_000
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd: ctx.workdir });
    let out = "";
    const cap = 40_000;
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
      resolve({ code: -1, out: `git 执行失败: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.slice(0, cap) });
    });
  });
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (required) throw new Error(`缺少参数 ${key}`);
  return "";
}

function numArg(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

const gitStatusTool: ToolDef = {
  name: "git_status",
  description: "查看 Git 工作区状态（当前分支、已暂存/未暂存/未跟踪文件）。",
  mutating: false,
  parameters: { type: "object", properties: {}, required: [] },
  async run(_args, ctx) {
    const [branch, status] = await Promise.all([
      runGit(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(ctx, ["status", "--short", "--branch"]),
    ]);
    return `分支: ${branch.out.trim() || "(未知)"}\n${status.out || "(工作区干净)"}`;
  },
};

const gitDiffTool: ToolDef = {
  name: "git_diff",
  description:
    "查看代码改动 diff。默认查看未暂存改动；staged=true 查看已暂存改动；可指定 path 限定文件。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      staged: { type: "boolean", description: "是否查看已暂存改动，默认 false" },
      path: { type: "string", description: "限定文件路径（可选）" },
    },
    required: [],
  },
  async run(args, ctx) {
    const argv = ["diff"];
    if (args.staged === true) argv.push("--cached");
    const p = str(args, "path", false);
    if (p) {
      safeResolve(ctx.workdir, p);
      argv.push("--", p);
    }
    const { out } = await runGit(ctx, argv);
    return out.trim() || "(无改动)";
  },
};

const gitLogTool: ToolDef = {
  name: "git_log",
  description: "查看最近的提交历史。可指定数量 limit（默认 10）与文件 path。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "提交数量，默认 10" },
      path: { type: "string", description: "限定文件路径（可选）" },
    },
    required: [],
  },
  async run(args, ctx) {
    const limit = Math.max(1, Math.min(50, Math.floor(numArg(args, "limit", 10))));
    const argv = ["log", `-n`, String(limit), "--oneline", "--decorate"];
    const p = str(args, "path", false);
    if (p) {
      safeResolve(ctx.workdir, p);
      argv.push("--", p);
    }
    const { out } = await runGit(ctx, argv);
    return out.trim() || "(无提交记录)";
  },
};

const gitDiffStagedSummary: ToolDef = {
  name: "git_show",
  description: "查看某个提交的详情（默认 HEAD）。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "提交引用，默认 HEAD" },
    },
    required: [],
  },
  async run(args, ctx) {
    const ref = str(args, "ref", false) || "HEAD";
    const { out } = await runGit(ctx, ["show", "--stat", "--patch", ref]);
    return out.trim() || "(无内容)";
  },
};

const gitCommitTool: ToolDef = {
  name: "git_commit",
  description:
    "将当前已暂存的改动创建一次提交。可先用 git add 暂存（通过 run_command），或使用 stage_all=true 暂存所有改动。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "提交信息" },
      stage_all: {
        type: "boolean",
        description: "是否先执行 git add -A，默认 false",
      },
    },
    required: ["message"],
  },
  async run(args, ctx) {
    const message = str(args, "message");
    if (args.stage_all === true) {
      const add = await runGit(ctx, ["add", "-A"]);
      if (add.code !== 0) return `暂存失败:\n${add.out}`;
    }
    const { code, out } = await runGit(ctx, ["commit", "-m", message]);
    if (code !== 0) return `提交失败（可能有未暂存改动或 hooks 未通过）:\n${out}`;
    return out.trim() || "提交成功";
  },
};

export function installGitTools(): void {
  if (installed) return;
  installed = true;
  registerTool(gitStatusTool);
  registerTool(gitDiffTool);
  registerTool(gitLogTool);
  registerTool(gitDiffStagedSummary);
  registerTool(gitCommitTool);
}
