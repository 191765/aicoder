/**
 * 配置校验与迁移
 *
 * 手写轻量校验（不引入重型依赖），并提供 JSON Schema 供编辑器提示。
 * 支持 $version 字段，未来结构变化时可自动迁移。
 */

export interface ValidationIssue {
  path: string;
  message: string;
  severity: "error" | "warning";
}

export type ConfigObject = Record<string, unknown>;

export const CURRENT_CONFIG_VERSION = 1;

function isObject(v: unknown): v is ConfigObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

type FieldType = "string" | "number" | "boolean" | "object" | "array";

interface FieldSpec {
  type: FieldType;
  optional?: boolean;
}

const TOP_LEVEL: Record<string, FieldSpec> = {
  $schema: { type: "string", optional: true },
  $version: { type: "number", optional: true },
  model: { type: "string", optional: true },
  baseURL: { type: "string", optional: true },
  apiKey: { type: "string", optional: true },
  temperature: { type: "number", optional: true },
  maxTokens: { type: "number", optional: true },
  maxSteps: { type: "number", optional: true },
  autoApprove: { type: "boolean", optional: true },
  permissions: { type: "object", optional: true }, // 对象或数组，单独校验
  context: { type: "object", optional: true },
  models: { type: "array", optional: true },
  embeddings: { type: "object", optional: true },
  mcpServers: { type: "object", optional: true },
  lspServers: { type: "object", optional: true },
  plugins: { type: "array", optional: true },
  security: { type: "object", optional: true },
  observability: { type: "object", optional: true },
  retry: { type: "object", optional: true },
  ui: { type: "object", optional: true },
  github: { type: "object", optional: true },
  users: { type: "array", optional: true },
  cache: { type: "object", optional: true },
  fallbackModels: { type: "array", optional: true },
  sandbox: { type: "object", optional: true },
  telemetry: { type: "object", optional: true },
  budget: { type: "object", optional: true },
  verify: { type: "object", optional: true },
};

function typeOf(v: unknown): FieldType | "unknown" {
  if (isString(v)) return "string";
  if (isNumber(v)) return "number";
  if (isBoolean(v)) return "boolean";
  if (Array.isArray(v)) return "array";
  if (isObject(v)) return "object";
  return "unknown";
}

export function validateConfig(raw: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isObject(raw)) {
    return [{ path: "", message: "配置根节点必须是对象", severity: "error" }];
  }

  for (const [key, value] of Object.entries(raw)) {
    // permissions 允许对象或数组
    if (key === "permissions") {
      if (!isObject(value) && !Array.isArray(value)) {
        issues.push({ path: key, message: "应为对象或数组", severity: "error" });
      }
      continue;
    }
    const spec = TOP_LEVEL[key];
    if (!spec) {
      issues.push({ path: key, message: `未知配置项`, severity: "warning" });
      continue;
    }
    const actual = typeOf(value);
    if (actual !== spec.type) {
      issues.push({
        path: key,
        message: `类型应为 ${spec.type}，实际为 ${actual}`,
        severity: "error",
      });
    }
  }

  // 校验 context
  if (isObject(raw.context)) {
    for (const f of [
      "maxContextTokens",
      "reserveForOutput",
      "keepRecentMessages",
      "toolResultMaxChars",
    ]) {
      const v = (raw.context as ConfigObject)[f];
      if (v !== undefined && !isNumber(v)) {
        issues.push({ path: `context.${f}`, message: "应为数字", severity: "error" });
      }
    }
  }

  // 校验 models 路由
  if (Array.isArray(raw.models)) {
    raw.models.forEach((m, i) => {
      if (!isObject(m)) {
        issues.push({ path: `models[${i}]`, message: "应为对象", severity: "error" });
        return;
      }
      if (!isString(m.model)) {
        issues.push({
          path: `models[${i}].model`,
          message: "缺少 model 字符串",
          severity: "error",
        });
      }
    });
  }

  // 校验 users
  if (Array.isArray(raw.users)) {
    raw.users.forEach((u, i) => {
      if (!isObject(u)) {
        issues.push({ path: `users[${i}]`, message: "应为对象", severity: "error" });
        return;
      }
      if (!isString(u.name))
        issues.push({ path: `users[${i}].name`, message: "缺少 name", severity: "error" });
      if (!isString(u.token))
        issues.push({ path: `users[${i}].token`, message: "缺少 token", severity: "error" });
      if (u.quotaUsd !== undefined && !isNumber(u.quotaUsd)) {
        issues.push({ path: `users[${i}].quotaUsd`, message: "应为数字", severity: "error" });
      }
    });
  }

  // 校验 timeouts / retry 范围
  if (isObject(raw.retry)) {
    const mr = (raw.retry as ConfigObject).maxRetries;
    if (mr !== undefined && (!isNumber(mr) || mr < 0)) {
      issues.push({ path: "retry.maxRetries", message: "应为非负数字", severity: "error" });
    }
  }

  return issues;
}

/**
 * 迁移旧版配置到当前版本。
 * 返回迁移后的对象与所执行的迁移说明。
 */
export function migrateConfig(raw: ConfigObject): { config: ConfigObject; migrations: string[] } {
  const config: ConfigObject = { ...raw };
  const migrations: string[] = [];
  const version = isNumber(config.$version) ? config.$version : 0;

  // v0 -> v1：早期用顶层 blockedCommands/auditLog 等，迁移到 security 下
  if (version < 1) {
    const security: ConfigObject = isObject(config.security) ? { ...config.security } : {};
    let moved = false;
    for (const key of ["blockedCommands", "secretScan", "redactSecrets", "auditLog"]) {
      if (config[key] !== undefined) {
        security[key] = config[key];
        delete config[key];
        moved = true;
      }
    }
    if (moved) {
      config.security = security;
      migrations.push("将顶层安全项迁移到 security 下");
    }
    // 早期用 traceFile 顶层
    if (config.traceFile !== undefined) {
      const obs: ConfigObject = isObject(config.observability) ? { ...config.observability } : {};
      obs.logFile = config.traceFile;
      delete config.traceFile;
      config.observability = obs;
      migrations.push("将 traceFile 迁移到 observability.logFile");
    }
    config.$version = 1;
  }

  return { config, migrations };
}

/** 生成 JSON Schema（用于 $schema 提示与编辑器补全） */
export function configJsonSchema(): ConfigObject {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "AICoder 配置",
    type: "object",
    properties: {
      $version: { type: "number", description: "配置版本" },
      model: { type: "string" },
      baseURL: { type: "string" },
      apiKey: { type: "string" },
      temperature: { type: "number" },
      maxTokens: { type: "number" },
      maxSteps: { type: "number" },
      autoApprove: { type: "boolean" },
      permissions: {
        oneOf: [
          { type: "array", items: { type: "string" } },
          {
            type: "object",
            properties: {
              allow: { type: "array", items: { type: "string" } },
              ask: { type: "array", items: { type: "string" } },
              deny: { type: "array", items: { type: "string" } },
            },
          },
        ],
      },
      context: {
        type: "object",
        properties: {
          maxContextTokens: { type: "number" },
          reserveForOutput: { type: "number" },
          keepRecentMessages: { type: "number" },
          toolResultMaxChars: { type: "number" },
        },
      },
      models: {
        type: "array",
        items: {
          type: "object",
          properties: {
            match: {
              type: "object",
              properties: {
                task: { type: "string" },
                tool: { type: "string" },
                input: { type: "string" },
              },
            },
            model: { type: "string" },
            baseURL: { type: "string" },
            apiKey: { type: "string" },
            temperature: { type: "number" },
          },
          required: ["model"],
        },
      },
      embeddings: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          model: { type: "string" },
          weight: { type: "number", minimum: 0, maximum: 1 },
        },
      },
      mcpServers: { type: "object" },
      lspServers: { type: "object" },
      plugins: { type: "array", items: { type: "string" } },
      security: {
        type: "object",
        properties: {
          blockedCommands: { type: "array", items: { type: "string" } },
          secretScan: { type: "boolean" },
          redactSecrets: { type: "boolean" },
          auditLog: { type: "string" },
        },
      },
      observability: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          logFile: { type: "string" },
          budgetUsd: { type: "number" },
          pricing: { type: "object" },
        },
      },
      retry: {
        type: "object",
        properties: {
          maxRetries: { type: "number", minimum: 0 },
          baseDelayMs: { type: "number", minimum: 0 },
        },
      },
      ui: {
        type: "object",
        properties: {
          theme: { type: "string", enum: ["dark", "light", "plain"] },
          rich: { type: "boolean" },
          locale: { type: "string", enum: ["zh", "en"] },
        },
      },
      github: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          token: { type: "string" },
        },
      },
      users: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            token: { type: "string" },
            quotaUsd: { type: "number" },
            allowedTools: { type: "array", items: { type: "string" } },
            allowWrite: { type: "boolean" },
          },
          required: ["name", "token"],
        },
      },
    },
  };
}
