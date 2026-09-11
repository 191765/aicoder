import type { ChatMessage, StreamEvent, ToolSchema } from "./types.js";
import { createProvider, type Provider } from "./provider.js";
import type { Config } from "./config.js";

/**
 * 模型降级链
 *
 * 主模型不可用（网络/限流/服务错误）时，依次尝试备用模型。
 * 切换发生在收到 error 事件且尚未产生任何文本/工具调用时，避免重复输出。
 */

export interface FallbackSpec {
  model: string;
  baseURL?: string;
  apiKey?: string;
}

export class FallbackProvider implements Provider {
  readonly model: string;
  private providers: Provider[];

  constructor(base: Config, fallbacks: FallbackSpec[]) {
    const chain: Config[] = [
      base,
      ...fallbacks.map((f) => ({
        ...base,
        model: f.model,
        baseURL: f.baseURL ?? base.baseURL,
        apiKey: f.apiKey ?? base.apiKey,
      })),
    ];
    this.providers = chain.map((c) => createProvider(c));
    this.model = base.model;
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    let lastError: string | null = null;
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      let producedAny = false;
      let errored = false;
      const buffered: StreamEvent[] = [];

      for await (const ev of provider.stream(messages, tools, signal)) {
        if (ev.type === "error") {
          errored = true;
          lastError = ev.message;
          break;
        }
        if (ev.type === "text") producedAny = true;
        if (ev.type === "tool_calls") producedAny = true;
        buffered.push(ev);
      }

      if (!errored) {
        for (const ev of buffered) yield ev;
        return;
      }

      // 已产生部分输出则不降级，直接把错误抛给上层
      if (producedAny) {
        for (const ev of buffered) yield ev;
        yield { type: "error", message: lastError ?? "未知错误" };
        return;
      }
      // 未产生输出，尝试下一个备用模型
    }

    yield { type: "error", message: `所有模型均不可用：${lastError ?? "未知错误"}` };
  }
}

export function createFallbackProvider(base: Config, fallbacks: FallbackSpec[]): Provider {
  if (!fallbacks.length) return createProvider(base);
  return new FallbackProvider(base, fallbacks);
}
