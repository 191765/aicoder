import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { checkContent, checkCommand, audit } from "./security.js";

export interface ToolContext {
  workdir: string;
  config: Config;
  /** 是否允许写入/执行（被用户确认后为 true） */
  approved: boolean;
  /** 交互式确认回调；返回 false 表示拒绝执行 */
  confirm?: (question: string) => Promise<boolean>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 是否属于写操作（需要确认） */
  mutating: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export const tools: ToolDef[] = [];

function register(t: ToolDef): void {
  if (tools.some((x) => x.name === t.name)) return;
  tools.push(t);
}

/** 供扩展模块（如子代理、MCP、Git）注册工具 */
export function registerTool(t: ToolDef): void {
  register(t);
}

/** 确保路径位于工作目录内，防止越界访问 */
export function safeResolve(workdir: string, target: string): string {
  const abs = path.resolve(workdir, target);
  const rel = path.relative(workdir, abs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return abs;
  }
  throw new Error(`拒绝访问工作目录之外的路径: ${target}`);
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

register({
  name: "read_file",
  description: "读取工作目录内某个文本文件的内容。可指定起始行 offset 与最大行数 limit。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      offset: { type: "number", description: "起始行号(1-based)，默认 1" },
      limit: { type: "number", description: "最大读取行数，默认 400" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const p = safeResolve(ctx.workdir, str(args, "path"));
    const offset = numArg(args, "offset", 1);
    const limit = numArg(args, "limit", 400);
    const raw = await fs.readFile(p, "utf8");
    const lines = raw.split(/\r?\n/);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${String(offset + i).padStart(5)}: ${l}`).join("\n");
    const note =
      offset - 1 + limit < lines.length ? `\n... (文件共 ${lines.length} 行，已截断)` : "";
    return numbered + note;
  },
});

register({
  name: "write_file",
  description: "将内容写入工作目录内的文件（覆盖式）。会创建不存在的父目录。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      content: { type: "string", description: "要写入的完整文本内容" },
    },
    required: ["path", "content"],
  },
  async run(args, ctx) {
    const p = safeResolve(ctx.workdir, str(args, "path"));
    let content = typeof args.content === "string" ? args.content : "";
    const sc = checkContent(content);
    if (!sc.allowed) {
      audit({
        action: "block_secret_write",
        tool: "write_file",
        target: args.path as string,
        ok: false,
        detail: sc.reason,
      });
      throw new Error(sc.reason);
    }
    if (sc.redacted !== undefined) content = sc.redacted;
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    audit({
      action: "write_file",
      tool: "write_file",
      target: path.relative(ctx.workdir, p),
      ok: true,
    });
    return `已写入 ${path.relative(ctx.workdir, p)} (${content.length} 字符)`;
  },
});

register({
  name: "edit_file",
  description:
    "在文件中将 old_string 精确替换为 new_string。old_string 必须唯一出现，否则报错。用于精准修改代码。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      old_string: { type: "string", description: "要被替换的原文（须唯一）" },
      new_string: { type: "string", description: "替换后的新文本" },
    },
    required: ["path", "old_string", "new_string"],
  },
  async run(args, ctx) {
    const p = safeResolve(ctx.workdir, str(args, "path"));
    const oldStr = str(args, "old_string");
    let newStr = typeof args.new_string === "string" ? args.new_string : "";
    const sc = checkContent(newStr);
    if (!sc.allowed) {
      audit({
        action: "block_secret_edit",
        tool: "edit_file",
        target: args.path as string,
        ok: false,
        detail: sc.reason,
      });
      throw new Error(sc.reason);
    }
    if (sc.redacted !== undefined) newStr = sc.redacted;
    const raw = await fs.readFile(p, "utf8");
    const count = raw.split(oldStr).length - 1;
    if (count === 0) throw new Error("未找到 old_string，无法替换");
    if (count > 1) throw new Error(`old_string 出现 ${count} 次，不唯一`);
    await fs.writeFile(p, raw.replace(oldStr, newStr), "utf8");
    audit({
      action: "edit_file",
      tool: "edit_file",
      target: path.relative(ctx.workdir, p),
      ok: true,
    });
    return `已修改 ${path.relative(ctx.workdir, p)}`;
  },
});

register({
  name: "list_dir",
  description: "列出工作目录内某个目录的文件与子目录。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的目录路径，默认 ." },
    },
    required: [],
  },
  async run(args, ctx) {
    const raw = str(args, "path", false) || ".";
    const p = safeResolve(ctx.workdir, raw);
    const entries = await fs.readdir(p, { withFileTypes: true });
    return (
      entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort()
        .join("\n") || "(空目录)"
    );
  },
});

register({
  name: "glob",
  description: "按 glob 模式查找文件，支持 * 与 ** 通配。例如 src/**/*.ts。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "glob 模式" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const pattern = str(args, "pattern");
    const results = await walkGlob(ctx.workdir, pattern, 500);
    return results.length ? results.join("\n") : "(无匹配)";
  },
});

register({
  name: "search",
  description: "在工作目录内按正则表达式搜索文件内容，返回匹配的文件、行号与文本。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "正则表达式" },
      include: { type: "string", description: "限制文件名后缀，如 .ts" },
    },
    required: ["pattern"],
  },
  async run(args, ctx) {
    const pattern = str(args, "pattern");
    const include = str(args, "include", false);
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      throw new Error(`非法正则: ${pattern}`);
    }
    const files = await walkAll(ctx.workdir, 2000);
    const out: string[] = [];
    for (const rel of files) {
      if (include && !rel.endsWith(include)) continue;
      const abs = path.join(ctx.workdir, rel);
      let content: string;
      try {
        content = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          out.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (out.length >= 200) return out.join("\n") + "\n... (结果过多已截断)";
        }
      }
    }
    return out.length ? out.join("\n") : "(无匹配)";
  },
});

register({
  name: "run_command",
  description:
    "在工作目录中执行 shell 命令并返回输出。Windows 使用 PowerShell。用于运行测试、构建、git 等。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      timeout_ms: { type: "number", description: "超时毫秒，默认 60000" },
    },
    required: ["command"],
  },
  async run(args, ctx) {
    const command = str(args, "command");
    const sec = checkCommand(command);
    if (!sec.allowed) {
      audit({
        action: "block_command",
        tool: "run_command",
        target: command,
        ok: false,
        detail: sec.reason,
      });
      throw new Error(sec.reason);
    }
    const timeout = numArg(args, "timeout_ms", 60_000);
    audit({ action: "run_command", tool: "run_command", target: command, ok: true });
    const { spawn } = await import("node:child_process");
    const isWin = process.platform === "win32";
    const shell = isWin ? "powershell.exe" : "/bin/sh";
    const shellArgs = isWin
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];
    return await new Promise<string>((resolve) => {
      const child = spawn(shell, shellArgs, { cwd: ctx.workdir });
      let out = "";
      const cap = 20_000;
      const onData = (b: Buffer) => {
        if (out.length < cap) out += b.toString("utf8");
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      const timer = setTimeout(() => {
        child.kill();
        resolve((out + `\n[超时 ${timeout}ms 已终止]`).slice(0, cap));
      }, timeout);
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve(`命令启动失败: ${e.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(`(exit ${code})\n${out}`.slice(0, cap));
      });
    });
  },
});

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
]);

async function walkAll(root: string, max: number): Promise<string[]> {
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    if (out.length >= max) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await rec(full);
      } else if (e.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  await rec(root);
  return out;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        re += ".*";
        i++;
        if (normalized[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

async function walkGlob(root: string, pattern: string, max: number): Promise<string[]> {
  const files = await walkAll(root, 5000);
  const re = globToRegExp(pattern);
  return files.filter((f) => re.test(f)).slice(0, max);
}

export function toolSchemas(exclude?: Set<string>) {
  const list = exclude ? tools.filter((t) => !exclude.has(t.name)) : tools;
  return list.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function findTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}
