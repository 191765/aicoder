import fs from "node:fs/promises";
import path from "node:path";
import { tokenize } from "./rag.js";
import type { SearchHit } from "./rag.js";

/**
 * 上下文增强
 *
 * - rerank：对检索结果按相关性与新鲜度重排
 * - sliceCode：从整块文本中截取与查询最相关的片段（代码切片）
 * - DependencyGraph：解析 import/require 关系，用于跨文件相关度
 */

export interface RerankOptions {
  /** 最近修改的文件（相对路径）加权 */
  recentFiles?: Set<string>;
  /** 每个文件最多保留的命中块数 */
  perFileLimit?: number;
}

/** 对检索命中重排：结合原始分数、词命中密度与新鲜度 */
export function rerank(hits: SearchHit[], query: string, opts: RerankOptions = {}): SearchHit[] {
  const q = new Set(tokenize(query));
  const perFileLimit = opts.perFileLimit ?? 3;
  const now = Date.now();

  const scored = hits.map((h) => {
    const tokens = tokenize(h.preview);
    let overlap = 0;
    for (const t of tokens) if (q.has(t)) overlap++;
    const density = tokens.length ? overlap / Math.sqrt(tokens.length) : 0;
    const recency = opts.recentFiles?.has(h.file) ? 0.15 : 0;
    // 文件名命中额外加权
    const nameHit = [...q].some((t) => h.file.toLowerCase().includes(t)) ? 0.1 : 0;
    const score = h.score * 0.6 + density * 0.3 + recency + nameHit;
    return { ...h, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // 限制每文件块数，保证多样性
  const counts = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const h of scored) {
    const c = counts.get(h.file) ?? 0;
    if (c >= perFileLimit) continue;
    counts.set(h.file, c + 1);
    out.push(h);
  }
  void now;
  return out;
}

/**
 * 代码切片：从一段代码文本中，找出与查询最相关的片段
 * （以函数/类边界或空行分块，返回最相关的前 N 块）。
 */
export function sliceCode(text: string, query: string, maxBlocks = 3): string {
  const q = new Set(tokenize(query));
  if (!q.size) return text.slice(0, 2000);

  const blocks: Array<{ text: string; score: number }> = [];
  // 以空行或顶层定义边界分块
  const rawBlocks = text.split(/\n\s*\n/);
  for (const b of rawBlocks) {
    const trimmed = b.trim();
    if (!trimmed) continue;
    const tokens = tokenize(trimmed);
    let overlap = 0;
    for (const t of tokens) if (q.has(t)) overlap++;
    const score = tokens.length ? overlap / Math.sqrt(tokens.length) : 0;
    blocks.push({ text: trimmed, score });
  }
  if (!blocks.length) return text.slice(0, 2000);

  blocks.sort((a, b) => b.score - a.score);
  const picked = blocks.slice(0, maxBlocks).filter((b) => b.score > 0);
  if (!picked.length) return blocks[0]!.text;
  return picked.map((b) => b.text).join("\n\n// ...\n\n");
}

/** 依赖图：解析 import/require 关系 */
export class DependencyGraph {
  private deps = new Map<string, Set<string>>();
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  async build(files: string[]): Promise<void> {
    for (const rel of files) {
      const deps = new Set<string>();
      try {
        const content = await fs.readFile(path.join(this.root, rel), "utf8");
        const re =
          /(?:import\s+[^'"]*from\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"])/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content))) {
          const spec = m[1] ?? m[2] ?? m[3];
          if (spec && (spec.startsWith(".") || spec.startsWith("/"))) {
            const resolved = this.resolve(rel, spec);
            if (resolved) deps.add(resolved);
          }
        }
      } catch {
        /* 忽略 */
      }
      this.deps.set(rel, deps);
    }
  }

  private resolve(fromRel: string, spec: string): string | null {
    const baseDir = path.posix.dirname(fromRel.split(path.sep).join("/"));
    let target = path.posix.normalize(path.posix.join(baseDir, spec));
    // 去掉扩展名后尝试常见后缀
    target = target.replace(/\.(js|mjs|cjs)$/, "");
    const candidates = [
      `${target}.ts`,
      `${target}.tsx`,
      `${target}.js`,
      `${target}.jsx`,
      `${target}/index.ts`,
      `${target}/index.js`,
    ];
    return candidates[0] ?? null;
  }

  /** 返回与某文件直接相关的文件（被依赖 + 依赖） */
  related(rel: string): string[] {
    const normalized = rel.split(path.sep).join("/");
    const out = new Set<string>();
    for (const d of this.deps.get(normalized) ?? []) out.add(d);
    for (const [file, deps] of this.deps) {
      if (deps.has(normalized)) out.add(file);
    }
    return [...out];
  }

  /** 展开相关文件为一个集合，用于给检索结果加权 */
  relatedClosure(seeds: string[], depth = 1): Set<string> {
    const result = new Set<string>();
    let frontier = seeds.map((s) => s.split(path.sep).join("/"));
    for (const f of frontier) result.add(f);
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const r of this.related(f)) {
          if (!result.has(r)) {
            result.add(r);
            next.push(r);
          }
        }
      }
      if (!next.length) break;
      frontier = next;
    }
    return result;
  }
}
