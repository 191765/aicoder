import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.js";

export interface Chunk {
  file: string;
  start: number;
  end: number;
  text: string;
  /** 词 -> 频次 */
  tf: Map<string, number>;
  len: number;
}

export interface SearchHit {
  file: string;
  start: number;
  end: number;
  score: number;
  preview: string;
}

interface IndexFile {
  version: number;
  root: string;
  builtAt: number;
  chunks: Array<{
    file: string;
    start: number;
    end: number;
    text: string;
  }>;
}

const INDEX_FILENAME = ".aicoder-index.json";
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".rb", ".php", ".swift", ".kt",
  ".scala", ".sh", ".ps1", ".sql", ".html", ".css", ".scss", ".vue", ".svelte",
  ".json", ".yaml", ".yml", ".toml", ".md", ".txt", ".xml", ".ini",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "coverage",
  "__pycache__", ".venv", "venv", ".idea", ".vscode", "target", ".turbo",
]);

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for", "on",
  "with", "as", "at", "by", "be", "this", "that", "are", "was", "from",
]);

/** 支持中英文的简易分词：英文/数字按词，中文按字 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const lower = input.toLowerCase();
  const re = /[a-z0-9_]+|[\u4e00-\u9fff]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(lower))) {
    const t = m[0];
    if (t.length === 1 && /[a-z0-9]/.test(t)) continue;
    if (STOP.has(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

export class CodeIndex {
  private chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private root: string;
  readonly indexPath: string;

  constructor(cfg: Config) {
    this.root = cfg.workdir;
    this.indexPath = path.join(this.root, INDEX_FILENAME);
  }

  get size(): number {
    return this.chunks.length;
  }

  async build(prebuiltText?: string): Promise<number> {
    const files = await this.collectFiles(this.root, 5000);
    const chunks: Chunk[] = [];
    for (const rel of files) {
      let content: string;
      try {
        content = await fs.readFile(path.join(this.root, rel), "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue;
      chunks.push(...splitChunks(rel, content));
    }
    this.setChunks(chunks);
    await this.save();
    return this.chunks.length - (prebuiltText ? 0 : 0);
  }

  async loadOrBuild(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      if (parsed.root === this.root && Array.isArray(parsed.chunks)) {
        this.setChunks(
          parsed.chunks.map((c) => makeChunk(c.file, c.start, c.end, c.text))
        );
        return;
      }
    } catch {
      /* 忽略 */
    }
    await this.build();
  }

  private setChunks(chunks: Chunk[]): void {
    this.chunks = chunks;
    this.df = new Map();
    let totalLen = 0;
    for (const c of chunks) {
      totalLen += c.len;
      for (const term of new Set(c.tf.keys())) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
    this.avgLen = chunks.length ? totalLen / chunks.length : 1;
  }

  private async save(): Promise<void> {
    const data: IndexFile = {
      version: 1,
      root: this.root,
      builtAt: Date.now(),
      chunks: this.chunks.map((c) => ({
        file: c.file,
        start: c.start,
        end: c.end,
        text: c.text,
      })),
    };
    await fs.writeFile(this.indexPath, JSON.stringify(data), "utf8");
  }

  search(query: string, topK = 6): SearchHit[] {
    const qTokens = tokenize(query);
    if (!qTokens.length || !this.chunks.length) return [];
    const N = this.chunks.length;
    const k1 = 1.5;
    const b = 0.75;
    const qSet = new Set(qTokens);
    const scored: SearchHit[] = [];

    for (const c of this.chunks) {
      let score = 0;
      for (const term of qSet) {
        const f = c.tf.get(term);
        if (!f) continue;
        const idf = Math.log(1 + (N - (this.df.get(term) ?? 0) + 0.5) /
          ((this.df.get(term) ?? 0) + 0.5));
        const denom = f + k1 * (1 - b + b * (c.len / this.avgLen));
        score += idf * ((f * (k1 + 1)) / denom);
      }
      if (score > 0) {
        scored.push({
          file: c.file,
          start: c.start,
          end: c.end,
          score,
          preview: c.text.slice(0, 400),
        });
      }
    }
    scored.sort((a, b2) => b2.score - a.score);
    return scored.slice(0, topK);
  }

  /** 将检索结果格式化为给 LLM 的上下文 */
  formatContext(query: string, topK = 6, maxChars = 6000): string {
    const hits = this.search(query, topK);
    if (!hits.length) return "";
    let out = "";
    for (const h of hits) {
      const block = `### ${h.file}:${h.start}-${h.end} (score ${h.score.toFixed(2)})\n${h.preview}\n\n`;
      if (out.length + block.length > maxChars) break;
      out += block;
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
        if (IGNORE_DIRS.has(e.name)) continue;
        if (e.name === INDEX_FILENAME) continue;
        if (e.name.startsWith(".") && e.name !== ".env.example") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await rec(full);
        } else if (e.isFile()) {
          if (CODE_EXT.has(path.extname(e.name).toLowerCase())) {
            out.push(path.relative(root, full).split(path.sep).join("/"));
          }
        }
      }
    };
    await rec(root);
    return out;
  }
}

function makeChunk(file: string, start: number, end: number, text: string): Chunk {
  const tokens = tokenize(text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { file, start, end, text, tf, len: tokens.length || 1 };
}

function splitChunks(file: string, content: string, maxLines = 60): Chunk[] {
  const lines = content.split(/\r?\n/);
  const chunks: Chunk[] = [];
  const key = crypto.createHash("md5").update(file).digest("hex").slice(0, 8);
  void key;
  for (let i = 0; i < lines.length; i += maxLines) {
    const slice = lines.slice(i, i + maxLines);
    if (!slice.join("").trim()) continue;
    chunks.push(makeChunk(file, i + 1, Math.min(i + maxLines, lines.length), slice.join("\n")));
  }
  if (!chunks.length && content.trim()) {
    chunks.push(makeChunk(file, 1, lines.length, content));
  }
  return chunks;
}
