import OpenAI from "openai";
import type { ChatMessage, StreamEvent, ToolCall, ToolSchema } from "./types.js";
import type { Config } from "./config.js";

export interface Provider {
  readonly model: string;
  stream(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent>;
}

/**
 * 通用 OpenAI 兼容 Provider。
 * 兼容 OpenAI / DeepSeek / Moonshot / 通义 / Ollama / vLLM 等所有 /chat/completions 端点。
 */
export class OpenAICompatProvider implements Provider {
  private client: OpenAI;
  readonly model: string;
  private temperature: number;
  private maxTokens: number;
  private maxRetries: number;
  private baseDelayMs: number;

  constructor(cfg: Config) {
    this.client = new OpenAI({
      apiKey: cfg.apiKey || "not-needed",
      baseURL: cfg.baseURL,
      maxRetries: 0,
    });
    this.model = cfg.model;
    this.temperature = cfg.temperature;
    this.maxTokens = cfg.maxTokens;
    this.maxRetries = cfg.retry?.maxRetries ?? 3;
    this.baseDelayMs = cfg.retry?.baseDelayMs ?? 500;
  }

  private isRetryable(err: unknown): boolean {
    const e = err as { status?: number; code?: string; message?: string };
    if (!e.status) return true; // 网络类错误
    return (
      e.status === 429 ||
      e.status === 500 ||
      e.status === 502 ||
      e.status === 503 ||
      e.status === 504
    );
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error("aborted"));
        }, { once: true });
      }
    });
  }

  private async createStream(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal?: AbortSignal
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return (await this.client.chat.completions.create(
          {
            model: this.model,
            messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
            tools: tools.length
              ? (tools as OpenAI.Chat.Completions.ChatCompletionTool[])
              : undefined,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            stream: true,
          },
          { signal }
        )) as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
      } catch (err) {
        lastErr = err;
        if (attempt >= this.maxRetries || !this.isRetryable(err)) break;
        const delay = this.baseDelayMs * Math.pow(2, attempt);
        try {
          await this.sleep(delay, signal);
        } catch {
          break;
        }
      }
    }
    throw lastErr;
  }

  async *stream(
    messages: ChatMessage[],
    tools: ToolSchema[],
    signal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const toolAcc = new Map<number, ToolCall>();

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.createStream(messages, tools, signal);
    } catch (err) {
      yield { type: "error", message: toErrorMessage(err) };
      return;
    }

    let finishReason: string | null = null;
    try {
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.content) {
          yield { type: "text", delta: delta.content };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const existing = toolAcc.get(idx) ?? {
              id: tc.id ?? `call_${idx}`,
              type: "function" as const,
              function: { name: "", arguments: "" },
            };
            if (tc.id) existing.id = tc.id;
            if (tc.function?.name) existing.function.name = tc.function.name;
            if (tc.function?.arguments) {
              existing.function.arguments += tc.function.arguments;
            }
            toolAcc.set(idx, existing);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      yield { type: "error", message: toErrorMessage(err) };
      return;
    }

    if (toolAcc.size > 0) {
      yield {
        type: "tool_calls",
        toolCalls: [...toolAcc.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, v]) => v),
      };
    }
    yield { type: "done", finishReason };
  }
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const anyErr = err as { status?: number; message: string };
    return anyErr.status
      ? `[HTTP ${anyErr.status}] ${anyErr.message}`
      : anyErr.message;
  }
  return String(err);
}

export function createProvider(cfg: Config): Provider {
  return new OpenAICompatProvider(cfg);
}
