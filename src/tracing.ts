import { log } from "./logger.js";

/**
 * 轻量链路追踪（OpenTelemetry 风格）
 *
 * 记录 span 的开始/结束与耗时，输出到结构化日志与可观测性 trace。
 * 无外部依赖；如需接入 OTel，可在 span 结束时导出。
 */

export interface Span {
  name: string;
  start: number;
  end(): number;
  setAttribute(key: string, value: unknown): void;
}

let seq = 0;

export function startSpan(name: string, attributes: Record<string, unknown> = {}): Span {
  const id = ++seq;
  const start = Date.now();
  const attrs: Record<string, unknown> = { spanId: id, ...attributes };
  log.debug(`span.start ${name}`, attrs);

  return {
    name,
    start,
    setAttribute(key, value) {
      attrs[key] = value;
    },
    end() {
      const duration = Date.now() - start;
      log.debug(`span.end ${name}`, { ...attrs, durationMs: duration });
      void import("./observability.js")
        .then((obs) => {
          obs.trace({ type: "span", name, durationMs: duration, ...attrs });
        })
        .catch(() => {
          /* 观测未初始化时忽略 */
        });
      return duration;
    },
  };
}

/** 包裹一个异步函数并自动结束 span */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const span = startSpan(name, attributes);
  try {
    const result = await fn(span);
    span.end();
    return result;
  } catch (err) {
    span.setAttribute("error", err instanceof Error ? err.message : String(err));
    span.end();
    throw err;
  }
}
