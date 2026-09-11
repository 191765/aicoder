/**
 * 结构化日志
 *
 * 支持 text / json 两种格式与日志级别，通过环境变量控制：
 *  - AICODER_LOG_LEVEL: debug | info | warn | error（默认 info）
 *  - AICODER_LOG_FORMAT: text | json（默认 text）
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let level: LogLevel = "info";
let format: "text" | "json" = "text";

export function initLogger(): void {
  const l = (process.env.AICODER_LOG_LEVEL ?? "info").toLowerCase();
  if (l in LEVELS) level = l as LogLevel;
  const f = (process.env.AICODER_LOG_FORMAT ?? "text").toLowerCase();
  format = f === "json" ? "json" : "text";
}

function enabled(l: LogLevel): boolean {
  return LEVELS[l] >= LEVELS[level];
}

const COLORS: Record<LogLevel, string> = {
  debug: "\x1b[2m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};

export interface LogFields {
  [key: string]: unknown;
}

function emit(l: LogLevel, msg: string, fields?: LogFields): void {
  if (!enabled(l)) return;
  if (format === "json") {
    process.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level: l, msg, ...fields }) + "\n"
    );
    return;
  }
  const prefix = `${COLORS[l]}[${l.toUpperCase()}]\x1b[0m`;
  let extra = "";
  if (fields && Object.keys(fields).length) {
    extra =
      " " +
      Object.entries(fields)
        .map(([k, v]) => `${k}=${formatValue(v)}`)
        .join(" ");
  }
  process.stderr.write(`${prefix} ${msg}${extra}\n`);
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  debug: (msg: string, fields?: LogFields): void => emit("debug", msg, fields),
  info: (msg: string, fields?: LogFields): void => emit("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => emit("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => emit("error", msg, fields),
};

export function currentLogLevel(): LogLevel {
  return level;
}
