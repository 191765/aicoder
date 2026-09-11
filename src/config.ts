import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { parseRules, type PermissionRule } from "./permissions.js";
import { DEFAULT_BUDGET, type ContextBudget } from "./context.js";

function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  workdir: string;
  port: number;
  token: string;
  tokenGenerated?: boolean;
  autoApprove: boolean;
  /** 原始权限规则文本 */
  permissionRules: string[];
  /** 解析后的权限规则 */
  rules: PermissionRule[];
  /** 上下文预算 */
  budget: ContextBudget;
}

interface FileConfig {
  model?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  autoApprove?: boolean;
  permissions?: string[] | Record<string, string[]>;
  context?: Partial<ContextBudget>;
}

function loadFileConfig(workdir: string): FileConfig {
  for (const name of [".aicoder.json", "aicoder.json"]) {
    const p = path.join(workdir, name);
    try {
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8")) as FileConfig;
      }
    } catch {
      /* 忽略损坏的配置文件 */
    }
  }
  return {};
}

/** 将 permissions 对象形式 { allow: [...], ask: [...], deny: [...] } 转为规则文本 */
function normalizePermissions(
  perms: FileConfig["permissions"]
): string[] {
  if (!perms) return [];
  if (Array.isArray(perms)) return perms;
  const out: string[] = [];
  for (const [action, tools] of Object.entries(perms)) {
    for (const t of tools) out.push(`${action}:${t}`);
  }
  return out;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const workdir = path.resolve(process.env.AICODER_WORKDIR ?? process.cwd());
  const file = loadFileConfig(workdir);

  const envRules = process.env.AICODER_PERMISSIONS
    ? process.env.AICODER_PERMISSIONS.split(/\n/)
    : [];
  const permissionRules = [
    ...normalizePermissions(file.permissions),
    ...envRules,
  ].filter((s) => s.trim().length > 0);

  const budget: ContextBudget = {
    ...DEFAULT_BUDGET,
    ...(file.context ?? {}),
    maxContextTokens: num(
      process.env.AICODER_MAX_CONTEXT_TOKENS,
      file.context?.maxContextTokens ?? DEFAULT_BUDGET.maxContextTokens
    ),
    reserveForOutput: num(
      process.env.AICODER_RESERVE_TOKENS,
      file.context?.reserveForOutput ?? DEFAULT_BUDGET.reserveForOutput
    ),
    keepRecentMessages: num(
      process.env.AICODER_KEEP_RECENT,
      file.context?.keepRecentMessages ?? DEFAULT_BUDGET.keepRecentMessages
    ),
    toolResultMaxChars: num(
      process.env.AICODER_TOOL_RESULT_MAX_CHARS,
      file.context?.toolResultMaxChars ?? DEFAULT_BUDGET.toolResultMaxChars
    ),
  };

  const cfg: Config = {
    apiKey: process.env.AICODER_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    baseURL:
      process.env.AICODER_BASE_URL ??
      process.env.OPENAI_BASE_URL ??
      file.baseURL ??
      "https://api.openai.com/v1",
    model: process.env.AICODER_MODEL ?? file.model ?? "gpt-4o-mini",
    temperature:
      process.env.AICODER_TEMPERATURE !== undefined
        ? num(process.env.AICODER_TEMPERATURE, 0.2)
        : (file.temperature ?? 0.2),
    maxTokens:
      process.env.AICODER_MAX_TOKENS !== undefined
        ? num(process.env.AICODER_MAX_TOKENS, 4096)
        : (file.maxTokens ?? 4096),
    maxSteps:
      process.env.AICODER_MAX_STEPS !== undefined
        ? num(process.env.AICODER_MAX_STEPS, 25)
        : (file.maxSteps ?? 25),
    workdir,
    port: num(process.env.AICODER_PORT, 8787),
    token: process.env.AICODER_TOKEN ?? "",
    autoApprove:
      process.env.AICODER_AUTO_APPROVE !== undefined
        ? bool(process.env.AICODER_AUTO_APPROVE, false)
        : (file.autoApprove ?? false),
    permissionRules,
    rules: parseRules(permissionRules),
    budget,
    ...overrides,
  };
  // 派生字段归一化：若覆盖了 permissionRules 但未显式覆盖 rules，则重新解析
  if (overrides.permissionRules && !overrides.rules) {
    cfg.rules = parseRules(cfg.permissionRules);
  }
  if (overrides.budget && !overrides.budget.maxContextTokens) {
    cfg.budget = { ...DEFAULT_BUDGET, ...overrides.budget };
  }
  return cfg;
}
