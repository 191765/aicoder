import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Config } from "./config.js";
import { createEmbeddingsClient, cosineSimilarity, type EmbeddingsClient } from "./embeddings.js";

export interface Chunk {
  file: string;
  start: number;
  end: number;
  text: string;
  /** 词 -> 频次 */
  tf: Map<string, number>;
  len: number;
  /** 向量（启用 embeddings 时存在） */
  vector?: number[];
}

export interface SearchHit {
  file: string;
  start: number;
  end: number;
  score: number;
  preview: string;
  /** 命中来源：bm25 / vector / hybrid */
  via?: "bm25" | "vector" | "hybrid";
}

interface IndexFile {
  version: number;
  root: string;
  builtAt: number;
  embeddingModel?: string;
  chunks: Array<{
    file: string;
    start: number;
    end: number;
    text: string;
    vector?: number[];
  }>;
}

const INDEX_FILENAME = ".aicoder-index.json";
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
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cc",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".sh",
  ".ps1",
  ".sql",
  ".html",
  ".css",
  ".scss",
  ".vue",
  ".svelte",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".txt",
  ".xml",
  ".ini",
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
  ".idea",
  ".vscode",
  "target",
  ".turbo",
]);

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "is",
  "it",
  "for",
  "on",
  "with",
  "as",
  "at",
  "by",
  "be",
  "this",
  "that",
  "are",
  "was",
  "from",
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
  private embedder: EmbeddingsClient | null;
  private vectorWeight: number;
  readonly indexPath: string;

  constructor(cfg: Config) {
    this.root = cfg.workdir;
    this.indexPath = path.join(this.root, INDEX_FILENAME);
    this.embedder = createEmbeddingsClient(cfg);
    this.vectorWeight = cfg.embeddings?.weight ?? 0.5;
  }

  get size(): number {
    return this.chunks.length;
  }

  get vectorEnabled(): boolean {
    return this.embedder !== null;
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
    if (this.embedder) {
      await this.buildVectors();
    }
    await this.save();
    return this.chunks.length - (prebuiltText ? 0 : 0);
  }

  /**
   * 增量更新单个文件：重新切块并替换该文件的所有旧块。
   * 文件被删除或为空时移除对应块。返回是否发生变化。
   */
  async updateFile(rel: string): Promise<boolean> {
    const normalized = rel.split(path.sep).join("/");
    const abs = path.join(this.root, normalized);
    let content: string | null;
    try {
      content = await fs.readFile(abs, "utf8");
      if (content.includes("\u0000")) content = null;
    } catch {
      content = null;
    }

    const before = this.chunks.filter((c) => c.file !== normalized);
    const removed = this.chunks.length - before.length;
    let addedChunks: Chunk[] = [];
    if (content !== null) {
      addedChunks = splitChunks(normalized, content);
      if (this.embedder) {
        try {
          const vecs = await this.embedder.embed(addedChunks.map((c) => c.text));
          addedChunks.forEach((c, i) => (c.vector = vecs[i]));
        } catch {
          /* 向量失败不影响 BM25 */
        }
      }
    }

    const changed = removed > 0 || addedChunks.length > 0;
    this.setChunks([...before, ...addedChunks]);
    if (changed) await this.save();
    return changed;
  }

  /** 从索引中移除某文件 */
  async removeFile(rel: string): Promise<boolean> {
    const normalized = rel.split(path.sep).join("/");
    const before = this.chunks.filter((c) => c.file !== normalized);
    if (before.length === this.chunks.length) return false;
    this.setChunks(before);
    await this.save();
    return true;
  }

  /**
   * 监听工作目录变化，增量更新索引。返回停止函数。
   */
  watch(debounceMs = 800): () => void {
    const dirs = new Set<string>();
    let timer: NodeJS.Timeout | null = null;
    const pending = new Set<string>();

    const flush = async (): Promise<void> => {
      const files = [...pending];
      pending.clear();
      let changed = false;
      for (const rel of files) {
        try {
          const updated = await this.updateFile(rel);
          changed = changed || updated;
        } catch {
          /* 忽略 */
        }
      }
      void changed;
    };

    const schedule = (rel: string): void => {
      pending.add(rel);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void flush(), debounceMs);
    };

    const watchers: fsSync.FSWatcher[] = [];
    const watchDir = (dir: string): void => {
      if (dirs.has(dir)) return;
      dirs.add(dir);
      try {
        const w = fsSync.watch(dir, { persistent: false }, (_event, filename) => {
          if (!filename) return;
          const rel = path.relative(this.root, path.join(dir, filename.toString()));
          schedule(rel);
        });
        watchers.push(w);
      } catch {
        /* 目录不可监听 */
      }
    };

    // 监听顶层与已索引文件所在目录
    watchDir(this.root);
    for (const c of this.chunks) {
      const dir = path.dirname(path.join(this.root, c.file));
      watchDir(dir);
    }

    return () => {
      if (timer) clearTimeout(timer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* 忽略 */
        }
      }
    };
  }

  /** 为所有片块生成向量（分批，避免单次请求过大） */
  async buildVectors(): Promise<number> {
    if (!this.embedder) return 0;
    const batchSize = 32;
    let done = 0;
    for (let i = 0; i < this.chunks.length; i += batchSize) {
      const batch = this.chunks.slice(i, i + batchSize);
      try {
        const vecs = await this.embedder.embed(batch.map((c) => c.text));
        for (let j = 0; j < batch.length; j++) {
          batch[j]!.vector = vecs[j];
        }
        done += batch.length;
      } catch {
        // 向量失败时保留已有（BM25 仍可用）
        break;
      }
    }
    return done;
  }

  async loadOrBuild(): Promise<void> {
    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as IndexFile;
      if (parsed.root === this.root && Array.isArray(parsed.chunks)) {
        const chunks = parsed.chunks.map((c) => {
          const chunk = makeChunk(c.file, c.start, c.end, c.text);
          chunk.vector = c.vector;
          return chunk;
        });
        this.setChunks(chunks);
        // 启用向量但索引缺少向量时增量补齐
        if (this.embedder && !chunks.some((c) => c.vector)) {
          await this.buildVectors();
          await this.save();
        }
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
      version: this.embedder ? 2 : 1,
      root: this.root,
      builtAt: Date.now(),
      embeddingModel: this.embedder?.model,
      chunks: this.chunks.map((c) => ({
        file: c.file,
        start: c.start,
        end: c.end,
        text: c.text,
        vector: c.vector,
      })),
    };
    await fs.writeFile(this.indexPath, JSON.stringify(data), "utf8");
  }

  /** 纯 BM25 打分 */
  private bm25Scores(query: string): Map<Chunk, number> {
    const qTokens = tokenize(query);
    const out = new Map<Chunk, number>();
    if (!qTokens.length) return out;
    const N = this.chunks.length;
    const k1 = 1.5;
    const b = 0.75;
    const qSet = new Set(qTokens);
    for (const c of this.chunks) {
      let score = 0;
      for (const term of qSet) {
        const f = c.tf.get(term);
        if (!f) continue;
        const idf = Math.log(
          1 + (N - (this.df.get(term) ?? 0) + 0.5) / ((this.df.get(term) ?? 0) + 0.5)
        );
        const denom = f + k1 * (1 - b + b * (c.len / this.avgLen));
        score += idf * ((f * (k1 + 1)) / denom);
      }
      if (score > 0) out.set(c, score);
    }
    return out;
  }

  /** 同步检索（BM25）。向量检索请用 searchAsync */
  search(query: string, topK = 6): SearchHit[] {
    const bm25 = this.bm25Scores(query);
    const scored: SearchHit[] = [...bm25.entries()].map(([c, score]) => ({
      file: c.file,
      start: c.start,
      end: c.end,
      score,
      preview: c.text.slice(0, 400),
      via: "bm25" as const,
    }));
    scored.sort((a, b2) => b2.score - a.score);
    return scored.slice(0, topK);
  }

  /** 混合检索：BM25 + 向量（需启用 embeddings） */
  async searchAsync(query: string, topK = 6): Promise<SearchHit[]> {
    const bm25 = this.bm25Scores(query);
    const hasVectors = this.embedder && this.chunks.some((c) => c.vector);
    if (!this.embedder || !hasVectors) return this.search(query, topK);

    let qVec: number[];
    try {
      qVec = await this.embedder.embedOne(query);
    } catch {
      return this.search(query, topK);
    }
    if (!qVec) return this.search(query, topK);

    // 归一化两种分数
    const maxBm25 = Math.max(1e-6, ...bm25.values());
    const vecScores = new Map<Chunk, number>();
    for (const c of this.chunks) {
      if (!c.vector) continue;
      const sim = cosineSimilarity(qVec, c.vector);
      vecScores.set(c, sim);
    }
    const maxVec = Math.max(1e-6, ...vecScores.values());
    const w = Math.max(0, Math.min(1, this.vectorWeight));

    const combined: SearchHit[] = [];
    for (const c of this.chunks) {
      const b = (bm25.get(c) ?? 0) / maxBm25;
      const v = (vecScores.get(c) ?? 0) / maxVec;
      const score = (1 - w) * b + w * v;
      if (score <= 0) continue;
      combined.push({
        file: c.file,
        start: c.start,
        end: c.end,
        score,
        preview: c.text.slice(0, 400),
        via: "hybrid",
      });
    }
    combined.sort((a, b2) => b2.score - a.score);
    return combined.slice(0, topK);
  }

  /** 将检索结果格式化为给 LLM 的上下文 */
  formatContext(query: string, topK = 6, maxChars = 6000): string {
    return this.formatHits(this.search(query, topK), maxChars);
  }

  /** 异步版本，启用向量时使用混合检索，并对结果重排 */
  async formatContextAsync(query: string, topK = 6, maxChars = 6000): Promise<string> {
    const raw = this.vectorEnabled
      ? await this.searchAsync(query, topK * 2)
      : this.search(query, topK * 2);
    let hits: SearchHit[];
    try {
      const { rerank } = await import("./context-enhance.js");
      hits = rerank(raw, query, { perFileLimit: 2 }).slice(0, topK);
    } catch {
      hits = raw.slice(0, topK);
    }
    return this.formatHits(hits, maxChars);
  }

  private formatHits(hits: SearchHit[], maxChars: number): string {
    if (!hits.length) return "";
    let out = "";
    for (const h of hits) {
      const via = h.via && h.via !== "bm25" ? `/${h.via}` : "";
      const block = `### ${h.file}:${h.start}-${h.end} (score ${h.score.toFixed(2)}${via})\n${h.preview}\n\n`;
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
