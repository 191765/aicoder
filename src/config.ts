import "dotenv/config";
import path from "node:path";
import { parseRules, type PermissionRule } from "./permissions.js";
import { DEFAULT_BUDGET, type ContextBudget } from "./context.js";
import type { McpServerConfig } from "./mcp.js";
import type { LspServerConfig } from "./lsp.js";
import {
  loadLayeredConfig,
  normalizePermissions,
  type FileConfig,
  type ModelRoute,
} from "./configfile.js";

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
  /** MCP 服务器配置 */
  mcpServers: Record<string, McpServerConfig>;
  /** LSP 服务器配置（按语言） */
  lspServers: Record<string, LspServerConfig>;
  /** 多模型路由规则 */
  models: ModelRoute[];
  /** 插件列表（本地路径或 npm 包名） */
  plugins: string[];
  /** 向量检索配置 */
  embeddings: { enabled: boolean; model: string; weight: number };
  /** 可观测性配置 */
  observability: {
    enabled: boolean;
    logFile?: string;
    pricing?: Record<string, { input: number; output: number }>;
  };
  /** 安全配置 */
  security: {
    blockedCommands?: string[];
    secretScan: boolean;
    redactSecrets: boolean;
    auditLog?: string;
  };
  /** 重试配置 */
  retry: { maxRetries: number; baseDelayMs: number };
  /** 单个工具执行超时（毫秒） */
  toolTimeoutMs: number;
  /** GitHub 集成 */
  github: { owner?: string; repo?: string; token?: string };
  /** UI 配置 */
  ui: { theme?: string; rich?: boolean; locale?: string };
  /** 命中的配置文件路径 */
  configSources: string[];
}

function loadFileConfig(workdir: string): { file: FileConfig; sources: string[] } {
  const { config, sources } = loadLayeredConfig(workdir);
  return { file: config, sources };
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const workdir = path.resolve(process.env.AICODER_WORKDIR ?? process.cwd());
  const { file, sources } = loadFileConfig(workdir);

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
    mcpServers: file.mcpServers ?? {},
    lspServers: file.lspServers ?? {},
    models: file.models ?? [],
    plugins: process.env.AICODER_PLUGINS
      ? process.env.AICODER_PLUGINS.split(/[;,]/).map((s) => s.trim()).filter(Boolean)
      : (file.plugins ?? []),
    embeddings: {
      enabled:
        process.env.AICODER_EMBEDDINGS !== undefined
          ? bool(process.env.AICODER_EMBEDDINGS, false)
          : (file.embeddings?.enabled ?? false),
      model:
        process.env.AICODER_EMBEDDING_MODEL ??
        file.embeddings?.model ??
        "text-embedding-3-small",
      weight: num(
        process.env.AICODER_EMBEDDING_WEIGHT,
        file.embeddings?.weight ?? 0.5
      ),
    },
    ui: {
      theme: process.env.AICODER_THEME ?? file.ui?.theme,
      rich: file.ui?.rich,
      locale: process.env.AICODER_LANG ?? file.ui?.locale,
    },
    observability: {
      enabled:
        process.env.AICODER_USAGE !== undefined
          ? bool(process.env.AICODER_USAGE, true)
          : (file.observability?.enabled ?? true),
      logFile: process.env.AICODER_TRACE_FILE ?? file.observability?.logFile,
      pricing: file.observability?.pricing,
    },
    security: {
      blockedCommands: file.security?.blockedCommands,
      secretScan:
        process.env.AICODER_SECRET_SCAN !== undefined
          ? bool(process.env.AICODER_SECRET_SCAN, true)
          : (file.security?.secretScan ?? true),
      redactSecrets: file.security?.redactSecrets ?? false,
      auditLog: process.env.AICODER_AUDIT_LOG ?? file.security?.auditLog,
    },
    retry: {
      maxRetries: num(
        process.env.AICODER_MAX_RETRIES,
        file.retry?.maxRetries ?? 3
      ),
      baseDelayMs: num(
        process.env.AICODER_RETRY_DELAY_MS,
        file.retry?.baseDelayMs ?? 500
      ),
    },
    toolTimeoutMs: num(process.env.AICODER_TOOL_TIMEOUT_MS, 120000),
    github: {
      owner: process.env.AICODER_GITHUB_OWNER ?? file.github?.owner,
      repo: process.env.AICODER_GITHUB_REPO ?? file.github?.repo,
      token: process.env.GITHUB_TOKEN ?? file.github?.token,
    },
    configSources: sources,
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
