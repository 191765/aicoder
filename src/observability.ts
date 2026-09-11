import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { estimateTokens } from "./context.js";

/**
 * 可观测性：用量统计、费用估算、调用日志与 trace。
 *
 * - 记录每次 LLM 调用的输入/输出 token（估算或 provider 返回值）
 * - 按模型累计用量与费用
 * - trace 以 JSONL 追加写入日志文件，便于调试
 */

export interface UsageRecord {
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  steps: number;
  toolCalls: number;
  durationMs: number;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  byModel: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; costUsd: number }
  >;
}

/** 每千 token 的美元价格（可在配置中覆盖） */
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 0.0025, output: 0.01 },
  "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
  "gpt-4.1": { input: 0.002, output: 0.008 },
  "deepseek-chat": { input: 0.00027, output: 0.0011 },
  "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
  "qwen-plus": { input: 0.0004, output: 0.0012 },
  "moonshot-v1-8k": { input: 0.0017, output: 0.0017 },
};

let logPath: string | null = null;
let pricing: Record<string, { input: number; output: number }> = { ...DEFAULT_PRICING };
let usageEnabled = true;
let budgetUsd: number | undefined;
let budgetWarned = false;

const records: UsageRecord[] = [];
const sessionStart = Date.now();

export function initObservability(config: Config): void {
  usageEnabled = config.observability?.enabled ?? true;
  if (config.observability?.pricing) {
    pricing = { ...DEFAULT_PRICING, ...config.observability.pricing };
  }
  budgetUsd = config.observability?.budgetUsd;
  if (config.observability?.logFile) {
    logPath = path.isAbsolute(config.observability.logFile)
      ? config.observability.logFile
      : path.join(config.workdir, config.observability.logFile);
  }
}

export function shutdownObservability(): void {
  /* 目前无需要关闭的资源，保留钩子 */
}

function priceFor(model: string): { input: number; output: number } {
  // 前缀匹配，如 gpt-4o-2024-xx 命中 gpt-4o
  const keys = Object.keys(pricing).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (model.startsWith(k)) return pricing[k]!;
  }
  return { input: 0, output: 0 };
}

export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const p = priceFor(model);
  return (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
}

export interface TraceEvent {
  type: string;
  [key: string]: unknown;
}

/** 追加一条 trace（JSONL）。失败静默，不影响主流程。 */
export function trace(event: TraceEvent): void {
  const line = JSON.stringify({ ts: Date.now(), ...event });
  if (logPath) {
    fs.appendFile(logPath, line + "\n", "utf8").catch(() => {
      /* 忽略 */
    });
  }
  if (process.env.AICODER_TRACE === "1") {
    process.stderr.write(`[trace] ${line}\n`);
  }
}

export interface RecordUsageInput {
  model: string;
  messages: Array<{ content: string | null }>;
  outputText: string;
  durationMs: number;
  steps: number;
  toolCalls: number;
  /** provider 返回的真实 token 用量（若有） */
  providerInputTokens?: number;
  providerOutputTokens?: number;
}

export function recordUsage(input: RecordUsageInput): UsageRecord {
  const inputTokens =
    input.providerInputTokens ??
    input.messages.reduce((s, m) => s + estimateTokens(m.content ?? ""), 0) + 4;
  const outputTokens =
    input.providerOutputTokens ?? estimateTokens(input.outputText);
  const costUsd = estimateCost(input.model, inputTokens, outputTokens);
  const rec: UsageRecord = {
    ts: Date.now(),
    model: input.model,
    inputTokens,
    outputTokens,
    costUsd,
    steps: input.steps,
    toolCalls: input.toolCalls,
    durationMs: input.durationMs,
  };
  records.push(rec);
  trace({ type: "usage", ...rec });
  if (budgetUsd !== undefined && !budgetWarned) {
    const total = records.reduce((s, r) => s + r.costUsd, 0);
    if (total >= budgetUsd) {
      budgetWarned = true;
      trace({ type: "budget_exceeded", budgetUsd, total });
      process.stderr.write(
        `\n[预算告警] 累计费用 $${total.toFixed(4)} 已超出预算 $${budgetUsd}\n`
      );
    }
  }
  return rec;
}

export function getUsage(): UsageSummary {
  const summary: UsageSummary = {
    calls: records.length,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    byModel: {},
  };
  for (const r of records) {
    summary.inputTokens += r.inputTokens;
    summary.outputTokens += r.outputTokens;
    summary.costUsd += r.costUsd;
    const m = (summary.byModel[r.model] ??= {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
    m.calls++;
    m.inputTokens += r.inputTokens;
    m.outputTokens += r.outputTokens;
    m.costUsd += r.costUsd;
  }
  summary.totalTokens = summary.inputTokens + summary.outputTokens;
  return summary;
}

export function resetUsage(): void {
  records.length = 0;
  budgetWarned = false;
}

/** 供监控仪表盘使用的汇总指标 */
export function getMetrics(): {
  usage: UsageSummary;
  budgetUsd?: number;
  budgetExceeded: boolean;
  sessionDurationMs: number;
  recent: UsageRecord[];
} {
  const usage = getUsage();
  return {
    usage,
    budgetUsd,
    budgetExceeded: budgetUsd !== undefined && usage.costUsd >= budgetUsd,
    sessionDurationMs: sessionDurationMs(),
    recent: records.slice(-50).reverse(),
  };
}

export function usageEnabledStatus(): boolean {
  return usageEnabled;
}

export function sessionDurationMs(): number {
  return Date.now() - sessionStart;
}
