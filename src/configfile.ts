import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContextBudget } from "./context.js";
import type { McpServerConfig } from "./mcp.js";
import type { LspServerConfig } from "./lsp.js";

/**
 * 层级配置
 *
 * 优先级（从低到高）：
 *   1. 全局   ~/.config/aicoder/aicoder.json
 *   2. 项目   <workdir>/.aicoder.json   或   <workdir>/aicoder.json
 *   3. 环境变量与运行时覆盖（在 config.ts 中处理）
 *
 * 合并规则：对象深合并；数组（如 permissions）按层拼接，高层追加。
 */

export interface ModelRoute {
  /** 匹配条件：任务类型 used 或工具名 */
  match: {
    /** 匹配的系统/任务类型，如 "explore" | "edit" | "test" */
    task?: string;
    /** 匹配触发的工具名 */
    tool?: string;
    /** 正则匹配用户输入 */
    input?: string;
  };
  /** 命中后使用的模型 */
  model: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
}

export interface FileConfig {
  $schema?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  maxSteps?: number;
  autoApprove?: boolean;
  permissions?: string[] | Record<string, string[]>;
  context?: Partial<ContextBudget>;
  mcpServers?: Record<string, McpServerConfig>;
  lspServers?: Record<string, LspServerConfig>;
  /** 多模型路由规则 */
  models?: ModelRoute[];
  /** 插件列表（本地路径或 npm 包名） */
  plugins?: string[];
  /** 向量检索配置 */
  embeddings?: {
    enabled?: boolean;
    model?: string;
    /** 混合检索中向量的权重 0..1，其余给 BM25 */
    weight?: number;
  };
  /** 可观测性配置 */
  observability?: {
    enabled?: boolean;
    /** trace 日志文件（相对工作目录或绝对路径） */
    logFile?: string;
    /** 自定义价格表：每千 token 美元 */
    pricing?: Record<string, { input: number; output: number }>;
    /** 费用预算（美元），超出时告警 */
    budgetUsd?: number;
  };
  /** 安全配置 */
  security?: {
    /** 额外阻断的命令正则 */
    blockedCommands?: string[];
    secretScan?: boolean;
    redactSecrets?: boolean;
    /** 审计日志文件 */
    auditLog?: string;
  };
  /** 重试与限流 */
  retry?: {
    /** 失败最大重试次数 */
    maxRetries?: number;
    /** 退避基数毫秒 */
    baseDelayMs?: number;
  };
  /** GitHub 集成 */
  github?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
  /** 团队多用户 */
  users?: Array<{
    name: string;
    token: string;
    quotaUsd?: number;
    allowedTools?: string[];
    allowWrite?: boolean;
  }>;
  /** 默认主题等 UI 配置 */
  ui?: {
    theme?: string;
    /** 是否启用 TUI，false 时用简单 CLI */
    rich?: boolean;
    /** 语言：zh | en */
    locale?: string;
  };
}

export interface LayeredConfig {
  config: FileConfig;
  /** 命中的配置文件路径（从低到高） */
  sources: string[];
}

function configHome(): string {
  if (process.env.AICODER_HOME) return process.env.AICODER_HOME;
  const home = os.homedir();
  return process.platform === "win32"
    ? process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
}

function globalConfigPath(): string {
  return path.join(configHome(), "aicoder", "aicoder.json");
}

function projectConfigPaths(workdir: string): string[] {
  return [
    path.join(workdir, ".aicoder.json"),
    path.join(workdir, "aicoder.json"),
  ];
}

function tryRead(p: string): FileConfig | null {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as FileConfig;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 深合并：数组拼接，对象递归，标量覆盖 */
export function mergeConfig<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>
): T {
  const out: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(override)) {
    const cur = out[key];
    if (isPlainObject(cur) && isPlainObject(val)) {
      out[key] = mergeConfig(cur, val);
    } else if (Array.isArray(cur) && Array.isArray(val)) {
      out[key] = [...cur, ...val];
    } else if (val !== undefined) {
      out[key] = val;
    }
  }
  return out as T;
}

export function loadLayeredConfig(workdir: string): LayeredConfig {
  const sources: string[] = [];
  let merged: FileConfig = {};

  const candidates = [
    globalConfigPath(),
    ...projectConfigPaths(workdir),
  ];

  for (const p of candidates) {
    const cfg = tryRead(p);
    if (cfg) {
      merged = mergeConfig(
        merged as Record<string, unknown>,
        cfg as Record<string, unknown>
      ) as FileConfig;
      sources.push(p);
    }
  }

  return { config: merged, sources };
}

/** 将 permissions 对象形式 { allow: [], ask: [], deny: [] } 转为规则文本 */
export function normalizePermissions(
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
