import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerTool, safeResolve, type ToolDef, type ToolContext } from "./tools.js";

/**
 * 轻量 LSP 集成
 *
 * 通过 stdio 启动语言服务器，实现：
 *   - textDocument/definition  跳转定义
 *   - textDocument/references  查找引用
 *   - textDocument/hover       悬停信息
 *   - textDocument/diagnostic  拉取诊断
 *
 * 默认针对 TypeScript/JavaScript 使用 `typescript-language-server --stdio`。
 * 未安装时工具会返回明确的安装提示，而不是崩溃。
 */

export interface LspServerConfig {
  command: string;
  args?: string[];
}

interface PendingResolver {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, PendingResolver>();
  private opened = new Map<string, number>();
  readonly root: string;
  readonly name: string;

  constructor(name: string, root: string, cfg: LspServerConfig) {
    this.name = name;
    this.root = root;
    this.child = spawn(cfg.command, cfg.args ?? [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (c: Buffer) => this.onData(c));
    this.child.on("error", () => this.failAll("语言服务器启动失败"));
    this.child.on("close", () => this.failAll("语言服务器已退出"));
  }

  private failAll(msg: string): void {
    for (const [, p] of this.pending) p.reject(new Error(msg));
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + len) break;
      const body = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      try {
        const msg = JSON.parse(body) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message));
          else p.resolve(msg.result);
        }
      } catch {
        /* 忽略 */
      }
    }
  }

  private send(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.child.stdin.write(Buffer.concat([header, body]));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP 请求超时: ${method}`));
        }
      }, 20_000);
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async initialize(): Promise<void> {
    const rootUri = pathToFileURL(this.root).toString();
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          definition: {},
          references: {},
          hover: {},
          diagnostic: {},
        },
      },
    });
    this.notify("initialized", {});
  }

  async openFile(abs: string): Promise<string> {
    const uri = pathToFileURL(abs).toString();
    if (this.opened.has(uri)) return uri;
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      return uri;
    }
    const languageId = languageIdFor(abs);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.opened.set(uri, 1);
    return uri;
  }

  close(): void {
    try {
      this.child.kill();
    } catch {
      /* 忽略 */
    }
  }
}

function languageIdFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] ?? "plaintext";
}

const clients = new Map<string, LspClient>();
let lspConfig: Record<string, LspServerConfig> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
  },
};

export function setLspServers(cfg: Record<string, LspServerConfig>): void {
  if (cfg && Object.keys(cfg).length) lspConfig = cfg;
}

function pickServer(file: string): LspServerConfig | null {
  const ext = path.extname(file).toLowerCase();
  if (
    ext === ".ts" ||
    ext === ".tsx" ||
    ext === ".js" ||
    ext === ".jsx" ||
    ext === ".mjs" ||
    ext === ".cjs"
  ) {
    return lspConfig["typescript"] ?? null;
  }
  if (ext === ".py") return lspConfig["python"] ?? null;
  if (ext === ".go") return lspConfig["go"] ?? null;
  if (ext === ".rs") return lspConfig["rust"] ?? null;
  return null;
}

async function getClient(file: string, ctx: ToolContext): Promise<LspClient | null> {
  const cfg = pickServer(file);
  if (!cfg) return null;
  const key = cfg.command;
  let client = clients.get(key);
  if (!client) {
    client = new LspClient(cfg.command, ctx.workdir, cfg);
    try {
      await client.initialize();
    } catch (err) {
      client.close();
      clients.delete(key);
      throw err;
    }
    clients.set(key, client);
  }
  return client;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`缺少参数 ${key}`);
  return v;
}

function numArg(args: Record<string, unknown>, key: string, def: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : def;
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length };
}

async function resolvePosition(
  ctx: ToolContext,
  fileArg: string,
  args: Record<string, unknown>
): Promise<{ abs: string; uri: string; line: number; character: number; server: LspServerConfig }> {
  const abs = safeResolve(ctx.workdir, fileArg);
  const server = pickServer(abs);
  if (!server) throw new Error(`未配置该文件类型的语言服务器: ${fileArg}`);
  let line = numArg(args, "line", 0);
  let character = numArg(args, "character", 0);
  if (args.offset !== undefined) {
    const text = await fs.readFile(abs, "utf8");
    const pos = offsetToPosition(text, numArg(args, "offset", 0));
    line = pos.line;
    character = pos.character;
  }
  const client = await getClient(abs, ctx);
  if (!client) throw new Error("语言服务器不可用");
  const uri = await client.openFile(abs);
  return { abs, uri, line, character, server };
}

const lspDefinition: ToolDef = {
  name: "lsp_definition",
  description:
    "跳转到符号定义位置。用于精确定位函数/变量/类的定义。需提供文件与行列（line/character 从 0 开始）或字符偏移 offset。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      line: { type: "number", description: "行号（0 起）" },
      character: { type: "number", description: "列号（0 起）" },
      offset: { type: "number", description: "字符偏移（与 line/character 二选一）" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const file = str(args, "path");
    const { uri, line, character } = await resolvePosition(ctx, file, args);
    const client = await getClient(safeResolve(ctx.workdir, file), ctx);
    if (!client) throw new Error("语言服务器不可用");
    const result = await client.request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
    return formatLocations(result, ctx.workdir);
  },
};

const lspReferences: ToolDef = {
  name: "lsp_references",
  description: "查找符号被引用的所有位置。适合重构前评估影响范围。需提供文件与位置。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      line: { type: "number", description: "行号（0 起）" },
      character: { type: "number", description: "列号（0 起）" },
      offset: { type: "number", description: "字符偏移（可选）" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const file = str(args, "path");
    const { uri, line, character } = await resolvePosition(ctx, file, args);
    const client = await getClient(safeResolve(ctx.workdir, file), ctx);
    if (!client) throw new Error("语言服务器不可用");
    const result = await client.request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return formatLocations(result, ctx.workdir);
  },
};

const lspHover: ToolDef = {
  name: "lsp_hover",
  description: "获取某个位置符号的悬停信息（类型签名、文档）。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
      line: { type: "number", description: "行号（0 起）" },
      character: { type: "number", description: "列号（0 起）" },
      offset: { type: "number", description: "字符偏移（可选）" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const file = str(args, "path");
    const { uri, line, character } = await resolvePosition(ctx, file, args);
    const client = await getClient(safeResolve(ctx.workdir, file), ctx);
    if (!client) throw new Error("语言服务器不可用");
    const result = (await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    })) as { contents?: unknown } | null;
    if (!result?.contents) return "(无悬停信息)";
    return stringifyHover(result.contents);
  },
};

const lspDiagnostics: ToolDef = {
  name: "lsp_diagnostics",
  description: "获取某个文件的诊断信息（编译错误、类型错误、警告）。修改代码后用它验证。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件路径" },
    },
    required: ["path"],
  },
  async run(args, ctx) {
    const abs = safeResolve(ctx.workdir, str(args, "path"));
    const client = await getClient(abs, ctx);
    if (!client) throw new Error("语言服务器不可用");
    const uri = await client.openFile(abs);
    const result = (await client.request("textDocument/diagnostic", {
      textDocument: { uri },
    })) as {
      items?: Array<{
        message: string;
        severity?: number;
        range?: { start: { line: number; character: number } };
      }>;
    } | null;
    const items = result?.items ?? [];
    if (!items.length) return "(无诊断问题)";
    const sev = ["", "错误", "警告", "信息", "提示"];
    return items
      .map((d) => {
        const loc = d.range ? `:${d.range.start.line + 1}:${d.range.start.character + 1}` : "";
        return `[${sev[d.severity ?? 1] ?? "问题"}]${loc} ${d.message}`;
      })
      .join("\n");
  },
};

function formatLocations(result: unknown, workdir: string): string {
  if (!result) return "(无结果)";
  const arr = Array.isArray(result) ? result : [result];
  const lines: string[] = [];
  for (const item of arr) {
    const loc = item as { uri?: string; range?: { start: { line: number; character: number } } };
    if (!loc?.uri || !loc.range) continue;
    const rel = loc.uri.startsWith("file:")
      ? path
          .relative(
            workdir,
            decodeURIComponent(new URL(loc.uri).pathname.replace(/^\/([A-Za-z]:)/, "$1"))
          )
          .split(path.sep)
          .join("/")
      : loc.uri;
    lines.push(`${rel}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`);
  }
  return lines.join("\n") || "(无结果)";
}

function stringifyHover(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === "string" ? c : ((c as { value?: string }).value ?? "")))
      .join("\n");
  }
  const c = contents as { value?: string };
  return c.value ?? JSON.stringify(contents);
}

export function installLspTools(): void {
  registerTool(lspDefinition);
  registerTool(lspReferences);
  registerTool(lspHover);
  registerTool(lspDiagnostics);
}

export function closeLspClients(): void {
  for (const [, c] of clients) c.close();
  clients.clear();
}
