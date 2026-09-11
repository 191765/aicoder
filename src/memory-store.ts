import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { tokenize } from "./rag.js";
import { cosineSimilarity } from "./embeddings.js";
import type { Config } from "./config.js";

/**
 * 分层记忆存储
 *
 * - 短时记忆：当前会话的要点（进程内）
 * - 长时记忆：项目级记忆条目，持久化到 .aicoder/memory.json
 * 检索：优先向量相似度（若启用 embeddings），否则关键词打分；返回 Top-K。
 *
 * 与 memory.ts 的约定文件互补：约定文件是人工维护的规则，
 * 这里是助手自动沉淀的结构化条目。
 */

export interface MemoryEntry {
  id: string;
  ts: number;
  text: string;
  tags?: string[];
  source?: string;
  vector?: number[];
}

const STORE_FILE = ".aicoder/memory.json";

export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private shortTerm: string[] = [];
  private root: string;
  private embed?: (texts: string[]) => Promise<number[][]>;

  constructor(config: Config) {
    this.root = config.workdir;
  }

  /** 注入向量编码器（可选） */
  setEmbedder(fn: (texts: string[]) => Promise<number[][]>): void {
    this.embed = fn;
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(path.join(this.root, STORE_FILE), "utf8");
      const data = JSON.parse(raw) as { entries?: MemoryEntry[] };
      if (Array.isArray(data.entries)) this.entries = data.entries;
    } catch {
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    const file = path.join(this.root, STORE_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ entries: this.entries }, null, 2), "utf8");
  }

  get size(): number {
    return this.entries.length;
  }

  /** 添加长时记忆条目 */
  async add(text: string, opts: { tags?: string[]; source?: string } = {}): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: crypto.randomBytes(6).toString("hex"),
      ts: Date.now(),
      text: text.trim(),
      tags: opts.tags,
      source: opts.source,
    };
    if (this.embed) {
      try {
        const [vec] = await this.embed([entry.text]);
        entry.vector = vec;
      } catch {
        /* 向量失败忽略 */
      }
    }
    this.entries.push(entry);
    await this.save();
    return entry;
  }

  /** 添加短时记忆（会话内） */
  addShortTerm(text: string): void {
    const t = text.trim();
    if (t) this.shortTerm.push(t);
    if (this.shortTerm.length > 50) this.shortTerm.shift();
  }

  get shortTermNotes(): string[] {
    return [...this.shortTerm];
  }

  /** 检索相关记忆 */
  async search(query: string, topK = 5): Promise<MemoryEntry[]> {
    if (!this.entries.length) return [];
    if (this.embed && this.entries.some((e) => e.vector)) {
      let qv: number[] | null = null;
      try {
        const [v] = await this.embed([query]);
        qv = v ?? null;
      } catch {
        qv = null;
      }
      if (qv) {
        return this.entries
          .filter((e) => e.vector)
          .map((e) => ({ e, score: cosineSimilarity(qv!, e.vector!) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)
          .map((x) => x.e);
      }
    }
    // 关键词回退
    const q = new Set(tokenize(query));
    return this.entries
      .map((e) => {
        const toks = tokenize(e.text);
        let overlap = 0;
        for (const t of toks) if (q.has(t)) overlap++;
        return { e, score: toks.length ? overlap / Math.sqrt(toks.length) : 0 };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((x) => x.e);
  }

  /** 格式化检索结果为提示文本 */
  async formatForPrompt(query: string, topK = 5): Promise<string> {
    const hits = await this.search(query, topK);
    const parts: string[] = [];
    if (this.shortTerm.length) {
      parts.push(
        "短时会话记忆:\n" +
          this.shortTerm
            .slice(-5)
            .map((t) => `- ${t}`)
            .join("\n")
      );
    }
    if (hits.length) {
      parts.push("相关项目记忆:\n" + hits.map((h) => `- ${h.text}`).join("\n"));
    }
    return parts.join("\n\n");
  }
}

let shared: MemoryStore | null = null;

export async function getMemoryStore(config: Config): Promise<MemoryStore> {
  if (!shared) {
    shared = new MemoryStore(config);
    await shared.load();
  }
  return shared;
}

export function resetMemoryStore(): void {
  shared = null;
}
