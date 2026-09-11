import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * 安全强化
 *
 * 1. 危险命令阻断：run_command 执行前做硬性黑名单检查（即使权限放行也拦截）。
 * 2. 密钥防泄露：对写入内容与命令做敏感信息扫描，命中则拒绝并可选择脱敏。
 * 3. 审计日志：记录所有写操作与命令执行为 JSONL。
 */

export interface SecurityConfig {
  /** 硬性禁止的命令正则（即使权限 allow 也拒绝） */
  blockedCommands: RegExp[];
  /** 是否启用密钥扫描 */
  secretScan: boolean;
  /** 审计日志文件（绝对路径） */
  auditLog?: string;
  /** 命中密钥时是否脱敏而非拒绝（默认拒绝写操作） */
  redactSecrets: boolean;
}

const DEFAULT_BLOCKED = [
  /\brm\s+-rf\s+\/(?:\s|$)/i,
  /\brm\s+-rf\s+~\//i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\}/, // fork bomb
  /\bformat\s+[a-z]:/i,
  /\bdel\s+\/[sq]\s+.*\\/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bdrop\s+database\b/i,
  /\bchmod\s+-R\s+777\s+\//i,
];

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "OpenAI API Key", re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "Anthropic API Key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "Google API Key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "Slack Token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Private Key Block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: "Generic Bearer", re: /Bearer\s+[A-Za-z0-9._-]{30,}/g },
];

let sec: SecurityConfig = {
  blockedCommands: [...DEFAULT_BLOCKED],
  secretScan: true,
  redactSecrets: false,
};

export function initSecurity(config: Config): void {
  const s = config.security;
  sec = {
    blockedCommands: [
      ...DEFAULT_BLOCKED,
      ...((s?.blockedCommands ?? []).map((p) => safeRegExp(p)).filter(Boolean) as RegExp[]),
    ],
    secretScan: s?.secretScan ?? true,
    auditLog:
      s?.auditLog &&
      (path.isAbsolute(s.auditLog) ? s.auditLog : path.join(config.workdir, s.auditLog)),
    redactSecrets: s?.redactSecrets ?? false,
  };
}

function safeRegExp(p: string): RegExp | null {
  try {
    return new RegExp(p, "i");
  } catch {
    return null;
  }
}

export interface SecurityCheck {
  allowed: boolean;
  reason?: string;
}

/** 检查命令是否被硬性阻断 */
export function checkCommand(command: string): SecurityCheck {
  for (const re of sec.blockedCommands) {
    if (re.test(command)) {
      return { allowed: false, reason: `命令命中安全黑名单: ${re}` };
    }
  }
  return { allowed: true };
}

export interface SecretFinding {
  name: string;
  match: string;
}

export function scanSecrets(text: string): SecretFinding[] {
  if (!sec.secretScan) return [];
  const found: SecretFinding[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      found.push({ name, match: m[0] });
    }
  }
  return found;
}

/** 将文本中的密钥替换为占位符 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { name, re } of SECRET_PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

export interface SecretCheck {
  allowed: boolean;
  reason?: string;
  redacted?: string;
  findings: SecretFinding[];
}

/**
 * 检查待写入内容是否含密钥。
 * redactSecrets=true 时返回脱敏后的文本并放行；否则拒绝。
 */
export function checkContent(content: string): SecretCheck {
  const findings = scanSecrets(content);
  if (!findings.length) return { allowed: true, findings: [] };
  if (sec.redactSecrets) {
    return { allowed: true, redacted: redactSecrets(content), findings };
  }
  const names = [...new Set(findings.map((f) => f.name))].join(", ");
  return {
    allowed: false,
    reason: `检测到疑似密钥（${names}），已阻止写入以防泄露。可在配置中启用 redactSecrets 改为脱敏。`,
    findings,
  };
}

export interface AuditEntry {
  action: string;
  tool?: string;
  target?: string;
  ok: boolean;
  detail?: string;
  model?: string;
}

export function audit(entry: AuditEntry): void {
  if (!sec.auditLog) return;
  const line = JSON.stringify({ ts: Date.now(), ...entry });
  fs.appendFile(sec.auditLog, line + "\n", "utf8").catch(() => {
    /* 忽略 */
  });
}

export function auditEnabled(): boolean {
  return Boolean(sec.auditLog);
}
