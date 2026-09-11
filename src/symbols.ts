import fs from "node:fs/promises";
import path from "node:path";
import { registerTool, type ToolDef, type ToolContext } from "./tools.js";
import type { Config } from "./config.js";

/**
 * 代码智能：轻量符号索引
 *
 * 用正则提取常见语言的符号定义（函数/类/接口/变量/常量/方法），
 * 并扫描跨文件引用。无需语言服务器，作为 LSP 之外的兜底能力。
 */

export interface SymbolDef {
  name: string;
  kind: string;
  file: string;
  line: number;
  column: number;
  signature?: string;
}

export interface SymbolReference {
  file: string;
  line: number;
  column: number;
  text: string;
}

const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".rb",
  ".php",
]);

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
  "target",
  ".turbo",
  ".aicoder",
]);

const PATTERNS: Array<{ re: RegExp; kind: string; group: number }> = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    kind: "function",
    group: 1,
  },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", group: 1 },
  { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", group: 1 },
  { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: "type", group: 1 },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
    kind: "variable",
    group: 1,
  },
  { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: "enum", group: 1 },
  {
    re: /^\s*(?:public|private|protected|static|async|\s)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/,
    kind: "method",
    group: 1,
  },
  { re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/, kind: "function", group: 1 },
  { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: "class", group: 1 },
  { re: /^\s*func\s+([A-Za-z_][\w]*)\s*\(/, kind: "function", group: 1 },
  { re: /^\s*fn\s+([A-Za-z_][\w]*)\s*\(/, kind: "function", group: 1 },
  { re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/, kind: "struct", group: 1 },
];

export class SymbolIndex {
  private symbols: SymbolDef[] = [];
  private byName = new Map<string, SymbolDef[]>();
  private root: string;

  constructor(config: Config) {
    this.root = config.workdir;
  }

  get size(): number {
    return this.symbols.length;
  }

  async build(): Promise<number> {
    const files = await this.collectFiles(this.root, 3000);
    const symbols: SymbolDef[] = [];
    for (const rel of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, rel), "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.length > 500) continue;
        for (const { re, kind, group } of PATTERNS) {
          const m = re.exec(line);
          if (m && m[group]) {
            symbols.push({
              name: m[group]!,
              kind,
              file: rel,
              line: i + 1,
              column: m.index + 1,
              signature: line.trim().slice(0, 160),
            });
            break;
          }
        }
      }
    }
    this.symbols = symbols;
    this.byName = new Map();
    for (const s of symbols) {
      const arr = this.byName.get(s.name) ?? [];
      arr.push(s);
      this.byName.set(s.name, arr);
    }
    return symbols.length;
  }

  /** 模糊查找符号定义 */
  find(name: string, limit = 50): SymbolDef[] {
    const lower = name.toLowerCase();
    const exact = this.byName.get(name) ?? [];
    if (exact.length) return exact.slice(0, limit);
    // 子串匹配
    const out: SymbolDef[] = [];
    for (const [key, defs] of this.byName) {
      if (key.toLowerCase().includes(lower)) {
        out.push(...defs);
        if (out.length >= limit) break;
      }
    }
    return out.slice(0, limit);
  }

  /** 查找符号的跨文件引用 */
  async references(name: string, limit = 100): Promise<SymbolReference[]> {
    const files = await this.collectFiles(this.root, 3000);
    const wordRe = new RegExp(`\\b${escapeRegExp(name)}\\b`);
    const out: SymbolReference[] = [];
    for (const rel of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, rel), "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (!wordRe.test(line)) continue;
        const col = line.search(wordRe) + 1;
        out.push({ file: rel, line: i + 1, column: col, text: line.trim().slice(0, 200) });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  private async collectFiles(root: string, max: number): Promise<string[]> {
    const out: string[] = [];
    const rec = async (dir: string): Promise<void> => {
      if (out.length >= max) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= max) return;
        if (e.name.startsWith(".")) continue;
        if (IGNORE_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await rec(full);
        } else if (e.isFile() && CODE_EXT.has(path.extname(e.name).toLowerCase())) {
          out.push(path.relative(root, full).split(path.sep).join("/"));
        }
      }
    };
    await rec(root);
    return out;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- 工具 ----

let installed = false;
let sharedIndex: SymbolIndex | null = null;

function getIndex(ctx: ToolContext): SymbolIndex {
  if (!sharedIndex) {
    sharedIndex = new SymbolIndex(ctx.config);
  }
  return sharedIndex;
}

const findSymbolTool: ToolDef = {
  name: "find_symbol",
  description: "在工作目录中查找符号（函数/类/接口/变量等）的定义位置。可先用它定位再读取文件。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "符号名（支持子串匹配）" },
    },
    required: ["name"],
  },
  async run(args, ctx) {
    const name = typeof args.name === "string" ? args.name : "";
    if (!name) throw new Error("缺少 name");
    const idx = getIndex(ctx);
    if (idx.size === 0) await idx.build();
    const defs = idx.find(name);
    if (!defs.length) return `(未找到符号 ${name})`;
    return defs
      .map((d) => `${d.file}:${d.line}:${d.column}  [${d.kind}] ${d.name}  ${d.signature ?? ""}`)
      .join("\n");
  },
};

const findReferencesTool: ToolDef = {
  name: "find_references",
  description: "查找某个符号在工作目录中的所有引用位置（跨文件）。重构前评估影响范围时很有用。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "符号名" },
      limit: { type: "number", description: "最多返回条数，默认 100" },
    },
    required: ["name"],
  },
  async run(args, ctx) {
    const name = typeof args.name === "string" ? args.name : "";
    if (!name) throw new Error("缺少 name");
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 100;
    const idx = getIndex(ctx);
    const refs = await idx.references(name, limit);
    if (!refs.length) return `(未找到 ${name} 的引用)`;
    return refs.map((r) => `${r.file}:${r.line}:${r.column}  ${r.text}`).join("\n");
  },
};

export function installSymbolTools(): void {
  if (installed) return;
  installed = true;
  registerTool(findSymbolTool);
  registerTool(findReferencesTool);
}

export function resetSymbolIndex(): void {
  sharedIndex = null;
}
