import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tokenize } from "./rag.js";
import { registerTool, type ToolDef } from "./tools.js";

/**
 * 本地向量库
 *
 * 内置轻量向量存储，支持两种向量来源：
 *  1. 外部 embedding（注入 embed 函数）
 *  2. 本地哈希嵌入（无需任何外部服务，默认）
 *
 * 适用于离线环境、隐私敏感场景或作为外部 embedding 的回退。
 */

export interface VectorRecord {
  id: string;
  vector: number[];
  text: string;
  meta?: Record<string, unknown>;
}

/** 本地哈希嵌入：把词映射到固定维度，加权累加并归一化 */
export function localEmbed(text: string, dims = 256): number[] {
  const vec = new Array(dims).fill(0);
  const tokens = tokenize(text);
  for (const t of tokens) {
    const h = crypto.createHash("md5").update(t).digest();
    const idx = ((h[0]! << 8) | h[1]!) % dims;
    const sign = h[2]! % 2 === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  // L2 归一化
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export class LocalVectorStore {
  private records: VectorRecord[] = [];
  private dims: number;
  private file: string;
  private embed?: (texts: string[]) => Promise<number[][]>;

  constructor(root: string, dims = 256) {
    this.dims = dims;
    this.file = path.join(root, ".aicoder", "vectors.json");
  }

  setEmbedder(fn: (texts: string[]) => Promise<number[][]>): void {
    this.embed = fn;
  }

  private async vectorize(text: string): Promise<number[]> {
    if (this.embed) {
      try {
        const [v] = await this.embed([text]);
        if (v) return v;
      } catch {
        /* 回退本地 */
      }
    }
    return localEmbed(text, this.dims);
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const data = JSON.parse(raw) as { records?: VectorRecord[]; dims?: number };
      if (Array.isArray(data.records)) {
        this.records = data.records;
        if (data.dims) this.dims = data.dims;
      }
    } catch {
      this.records = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(
      this.file,
      JSON.stringify({ dims: this.dims, records: this.records }),
      "utf8"
    );
  }

  get size(): number {
    return this.records.length;
  }

  async add(id: string, text: string, meta?: Record<string, unknown>): Promise<void> {
    const vector = await this.vectorize(text);
    const existing = this.records.findIndex((r) => r.id === id);
    const rec: VectorRecord = { id, vector, text, meta };
    if (existing >= 0) this.records[existing] = rec;
    else this.records.push(rec);
  }

  async addMany(
    items: Array<{ id: string; text: string; meta?: Record<string, unknown> }>
  ): Promise<void> {
    for (const it of items) await this.add(it.id, it.text, it.meta);
  }

  remove(id: string): boolean {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.id !== id);
    return this.records.length < before;
  }

  async search(query: string, topK = 5): Promise<Array<VectorRecord & { score: number }>> {
    if (!this.records.length) return [];
    const qv = await this.vectorize(query);
    return this.records
      .map((r) => ({ ...r, score: cosine(qv, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

let shared: LocalVectorStore | null = null;

export async function getVectorStore(root: string): Promise<LocalVectorStore> {
  if (!shared) {
    shared = new LocalVectorStore(root);
    await shared.load();
  }
  return shared;
}

export function resetVectorStore(): void {
  shared = null;
}

// ---- 工具：把工作目录文件索引进本地向量库并支持语义检索 ----

let installed = false;
let indexed = false;

async function collectFiles(root: string, max = 2000): Promise<string[]> {
  const ignore = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "coverage",
    "__pycache__",
    ".aicoder",
    ".venv",
    "target",
  ]);
  const ext = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".rb",
    ".php",
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
  ]);
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
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      if (ignore.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile() && ext.has(path.extname(e.name).toLowerCase())) {
        out.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  await rec(root);
  return out;
}

const semanticSearchTool: ToolDef = {
  name: "semantic_search",
  description:
    "基于本地向量库的语义搜索：对工作目录代码进行语义检索，返回最相关的文件片段。无需外部 embedding 服务。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "查询文本" },
      top_k: { type: "number", description: "返回条数，默认 5" },
    },
    required: ["query"],
  },
  async run(args, ctx) {
    const query = typeof args.query === "string" ? args.query : "";
    if (!query) throw new Error("缺少 query");
    const topK = typeof args.top_k === "number" && args.top_k > 0 ? args.top_k : 5;
    const store = await getVectorStore(ctx.workdir);

    if (!indexed && store.size === 0) {
      const files = await collectFiles(ctx.workdir, 400);
      const items: Array<{ id: string; text: string }> = [];
      for (const f of files) {
        let content = "";
        try {
          content = (await fs.readFile(path.join(ctx.workdir, f), "utf8")).slice(0, 4000);
        } catch {
          /* 忽略 */
        }
        items.push({ id: f, text: `${f}\n${content}` });
      }
      await store.addMany(items);
      await store.save();
      indexed = true;
    }

    const hits = await store.search(query, topK);
    if (!hits.length) return "(无结果)";
    return hits.map((h) => `${h.id}  (相似度 ${h.score.toFixed(3)})`).join("\n");
  },
};

export function installVectorTools(): void {
  if (installed) return;
  installed = true;
  registerTool(semanticSearchTool);
}
