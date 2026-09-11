/**
 * 权限规则系统
 *
 * 规则形式： "allow:read_file", "ask:write_file", "deny:run_command(rm *)"
 *  - 工具名支持 * 通配
 *  - 可选括号内为参数匹配模式，对命令/路径等关键字段做匹配
 *  - 优先级：deny > ask > allow > 默认策略
 */

export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  action: PermissionDecision;
  tool: RegExp;
  /** 参数匹配（正则），无则匹配全部 */
  argPattern?: RegExp;
  /** 原始文本，便于展示 */
  raw: string;
}

export interface PermissionResult {
  decision: PermissionDecision;
  rule?: PermissionRule;
  reason: string;
}

/** 默认策略：只读工具放行，写工具询问 */
export const DEFAULT_READONLY_TOOLS = [
  "read_file",
  "list_dir",
  "glob",
  "search",
];

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const body = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`, "i");
}

export function parseRule(text: string): PermissionRule | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(allow|ask|deny)\s*:\s*([^(]+?)\s*(?:\(([\s\S]*)\))?\s*$/i);
  if (!m) return null;
  const action = m[1]!.toLowerCase() as PermissionDecision;
  const toolPattern = m[2]!.trim();
  const argPattern = m[3];
  if (!toolPattern) return null;

  const rule: PermissionRule = {
    action,
    tool: wildcardToRegExp(toolPattern),
    raw: trimmed,
  };
  if (argPattern !== undefined) {
    try {
      rule.argPattern = new RegExp(argPattern, "i");
    } catch {
      // 参数模式非法时忽略参数匹配，仅按工具名匹配
    }
  }
  return rule;
}

export function parseRules(texts: string[]): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const t of texts) {
    // 支持一行多条，用逗号或分号分隔
    for (const part of t.split(/[;,]/)) {
      const rule = parseRule(part);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/** 从工具参数中提取用于参数匹配的文本 */
export function extractArgText(
  toolName: string,
  args: Record<string, unknown>
): string {
  if (toolName === "run_command") {
    return String(args.command ?? "");
  }
  if (
    toolName === "read_file" ||
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "list_dir"
  ) {
    return String(args.path ?? "");
  }
  if (toolName === "glob") return String(args.pattern ?? "");
  if (toolName === "search") return String(args.pattern ?? "");
  return JSON.stringify(args);
}

export interface PermissionContext {
  rules: PermissionRule[];
  /** 规则未命中时的默认行为 */
  defaultDecision: PermissionDecision;
  /** 是否自动批准（AICODER_AUTO_APPROVE），为 true 时 ask 视为 allow */
  autoApprove: boolean;
}

export function decide(
  ctx: PermissionContext,
  toolName: string,
  args: Record<string, unknown>
): PermissionResult {
  const argText = extractArgText(toolName, args);
  const matches: PermissionRule[] = [];

  for (const rule of ctx.rules) {
    if (!rule.tool.test(toolName)) continue;
    if (rule.argPattern && !rule.argPattern.test(argText)) continue;
    matches.push(rule);
  }

  // 优先级：deny > ask > allow
  const denied = matches.find((r) => r.action === "deny");
  if (denied) {
    return {
      decision: "deny",
      rule: denied,
      reason: `命中拒绝规则: ${denied.raw}`,
    };
  }
  const asked = matches.find((r) => r.action === "ask");
  if (asked) {
    if (ctx.autoApprove) {
      return {
        decision: "allow",
        rule: asked,
        reason: `命中询问规则但已自动批准: ${asked.raw}`,
      };
    }
    return {
      decision: "ask",
      rule: asked,
      reason: `命中询问规则: ${asked.raw}`,
    };
  }
  const allowed = matches.find((r) => r.action === "allow");
  if (allowed) {
    return {
      decision: "allow",
      rule: allowed,
      reason: `命中允许规则: ${allowed.raw}`,
    };
  }

  // 无匹配 -> 默认策略
  return {
    decision: ctx.defaultDecision,
    reason: ctx.defaultDecision === "allow" ? "默认放行" : "默认询问",
  };
}

/** 根据工具是否为写操作推导默认策略 */
export function defaultDecisionFor(isMutating: boolean): PermissionDecision {
  return isMutating ? "ask" : "allow";
}
