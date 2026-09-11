import OpenAI from "openai";
import type { Config } from "./config.js";

/**
 * 向量检索支持
 *
 * 通过 OpenAI 兼容的 /embeddings 接口生成向量。
 * 未配置 embeddingModel 时，返回 null，调用方回退到 BM25。
 */

export class EmbeddingsClient {
  private client: OpenAI;
  readonly model: string;
  private cache = new Map<string, number[]>();

  constructor(cfg: Config) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey || "not-needed",
      baseURL: cfg.baseURL,
    });
    this.model = cfg.embeddings?.model ?? "text-embedding-3-small";
  }

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = new Array(texts.length);
    const missing: string[] = [];
    const missingIdx: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const cached = this.cache.get(texts[i]!);
      if (cached) out[i] = cached;
      else {
        missing.push(texts[i]!);
        missingIdx.push(i);
      }
    }
    if (missing.length) {
      const res = await this.client.embeddings.create({
        model: this.model,
        input: missing,
      });
      for (let j = 0; j < res.data.length; j++) {
        const vec = res.data[j]!.embedding as number[];
        out[missingIdx[j]!] = vec;
        this.cache.set(missing[j]!, vec);
      }
    }
    return out;
  }

  async embedOne(text: string): Promise<number[]> {
    const [v] = await this.embed([text]);
    return v!;
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createEmbeddingsClient(cfg: Config): EmbeddingsClient | null {
  if (!cfg.embeddings?.enabled) return null;
  return new EmbeddingsClient(cfg);
}
