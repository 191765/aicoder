import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatMessage, StreamEvent, ToolSchema } from "./types.js";

/**
 * 响应缓存（成本与延迟优化）
 *
 * 对完全相同的请求（messages + tools + model + 温度）返回缓存结果。
 * 默认内存缓存；可选磁盘持久化到 .aicoder/cache/。
 * 注意：仅缓存确定性请求（temperature 为 0 或显式开启）以避免错误复用。
 */

export interface CacheEntry {
  key: string;
  ts: number;
  events: StreamEvent[];
  model: string;
}

export interface CacheConfig {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
  persistent: boolean;
  dir: string;
}

interface CacheStats {
  hits: number;
  misses: number;
  stores: number;
}

export class ResponseCache {
  private mem = new Map<string, CacheEntry>();
  private stats: CacheStats = { hits: 0, misses: 0, stores: 0 };
  private cfg: CacheConfig;

  constructor(cfg: CacheConfig) {
    this.cfg = cfg;
  }

  static key(
    model: string,
    messages: ChatMessage[],
    tools: ToolSchema[],
    temperature: number
  ): string {
    const payload = JSON.stringify({ model, messages, tools, temperature });
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  get(key: string): StreamEvent[] | null {
    if (!this.cfg.enabled) return null;
    const entry = this.mem.get(key);
    if (!entry) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() - entry.ts > this.cfg.ttlMs) {
      this.mem.delete(key);
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return entry.events;
  }

  async set(key: string, events: StreamEvent[], model: string): Promise<void> {
    if (!this.cfg.enabled) return;
    this.stats.stores++;
    const entry: CacheEntry = { key, ts: Date.now(), events, model };
    this.mem.set(key, entry);
    // 淘汰最旧
    if (this.mem.size > this.cfg.maxEntries) {
      const oldest = [...this.mem.values()].sort((a, b) => a.ts - b.ts)[0];
      if (oldest) this.mem.delete(oldest.key);
    }
    if (this.cfg.persistent) {
      try {
        await fs.mkdir(this.cfg.dir, { recursive: true });
        await fs.writeFile(path.join(this.cfg.dir, `${key}.json`), JSON.stringify(entry), "utf8");
      } catch {
        /* 持久化失败不影响 */
      }
    }
  }

  async load(key: string): Promise<StreamEvent[] | null> {
    const mem = this.get(key);
    if (mem) return mem;
    if (!this.cfg.persistent) return null;
    try {
      const raw = await fs.readFile(path.join(this.cfg.dir, `${key}.json`), "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() - entry.ts > this.cfg.ttlMs) return null;
      this.mem.set(key, entry);
      this.stats.hits++;
      return entry.events;
    } catch {
      return null;
    }
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  clear(): void {
    this.mem.clear();
  }
}
