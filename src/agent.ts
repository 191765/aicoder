import type { Config } from "./config.js";
import type { ChatMessage, ToolCall } from "./types.js";
import { createProvider, type Provider } from "./provider.js";
import { findTool, toolSchemas, type ToolContext } from "./tools.js";
import { CodeIndex } from "./rag.js";
import {
  decide,
  type PermissionContext,
} from "./permissions.js";
import { buildContext, historyTokens } from "./context.js";
import { installSubagentTool } from "./subagent.js";
import { installGitTools } from "./git.js";
import { installLspTools } from "./lsp.js";
import { installOrchestratorTools } from "./orchestrator.js";
import { installMemoryTool } from "./memory.js";
import { installSymbolTools } from "./symbols.js";
import { ModelRouter } from "./router.js";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; name: string; args: string }
  | { type: "tool_end"; name: string; ok: boolean; result: string }
  | { type: "tool_denied"; name: string; reason: string }
  | { type: "context"; tokens: number; dropped: number; trimmed: boolean }
  | { type: "step"; index: number }
  | { type: "error"; message: string }
  | { type: "done" };

export interface AgentOptions {
  config: Config;
  useRag?: boolean;
  onConfirm?: (question: string) => Promise<boolean>;
  /** 运行期动态追加的允许工具（如 web 端用户本次批准） */
  extraAllow?: Set<string>;
  /** 排除的工具名（如子代理禁止再次派发 task） */
  excludeTools?: Set<string>;
  /** 覆盖系统提示（子代理使用专用提示） */
  systemPrompt?: string;
  /** 静默模式：不产生 tool_* 事件，仅返回文本（子代理内部使用） */
  quiet?: boolean;
  /** 会话持久化：会话 id，传入则自动保存历史 */
  sessionId?: string;
  /** 是否启用持久化（默认 sessionId 存在时启用） */
  persist?: boolean;
}

const SYSTEM_PROMPT = `你是 AICoder，一个开源 AI 编程助手，运行在用户的开发环境中。

工作目录：{WORKDIR}
操作系统：{OS}

你可以使用工具来读取、修改文件并执行命令。请遵循：
1. 先理解再行动：修改前先用 read_file / search / glob 了解代码结构。
2. 精准编辑：优先用 edit_file 做小范围修改，避免整文件覆盖。
3. 验证结果：修改后尽量运行测试或构建命令验证。
4. 路径安全：所有路径相对于工作目录，不要访问目录之外的路径。
5. 回答简洁：用中文或与用户相同的语言，直接给出结论和必要说明。
6. 权限受限：部分工具可能被权限规则拒绝，若被拒绝请勿重复尝试，改为说明原因或提供替代方案。

{RAG_CONTEXT}`;

export class Agent {
  private provider: Provider;
  private config: Config;
  private router: ModelRouter;
  private providerCache = new Map<string, Provider>();
  private history: ChatMessage[] = [];
  private index: CodeIndex | null = null;
  private useRag: boolean;
  private onConfirm?: (question: string) => Promise<boolean>;
  private extraAllow: Set<string>;
  private excludeTools: Set<string>;
  private systemPromptOverride?: string;
  private quiet: boolean;
  private sessionId?: string;
  private persist: boolean;
  private createdAt: number;

  constructor(opts: AgentOptions) {
    installSubagentTool();
    installGitTools();
    installLspTools();
    installOrchestratorTools();
    installMemoryTool();
    installSymbolTools();
    this.config = opts.config;
    this.provider = createProvider(opts.config);
    this.router = new ModelRouter(opts.config, opts.config.models ?? []);
    this.useRag = opts.useRag ?? false;
    this.onConfirm = opts.onConfirm;
    this.extraAllow = opts.extraAllow ?? new Set();
    this.excludeTools = opts.excludeTools ?? new Set();
    this.systemPromptOverride = opts.systemPrompt;
    this.quiet = opts.quiet ?? false;
    this.sessionId = opts.sessionId;
    this.persist = opts.persist ?? Boolean(opts.sessionId);
    this.createdAt = Date.now();
  }

  /** 载入已有历史（恢复会话） */
  loadHistory(messages: ChatMessage[]): void {
    this.history = messages.map((m) => ({ ...m }));
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  set id(value: string | undefined) {
    this.sessionId = value;
  }

  /** 持久化当前会话 */
  async save(): Promise<void> {
    if (!this.persist || !this.sessionId || this.quiet) return;
    const { saveSession, buildSession } = await import("./session.js");
    await saveSession(
      buildSession(
        this.sessionId,
        this.config.workdir,
        this.config.model,
        this.history,
        this.createdAt
      )
    );
  }

  get messages(): ChatMessage[] {
    return this.history;
  }

  get contextTokens(): number {
    return historyTokens(this.history);
  }

  get model(): string {
    return this.config.model;
  }

  reset(): void {
    this.history = [];
  }

  /** 追加运行期允许的工具（用户批准后调用） */
  allowTool(name: string): void {
    this.extraAllow.add(name);
  }

  async prepareRag(): Promise<number> {
    this.index = new CodeIndex(this.config);
    await this.index.loadOrBuild();
    this.useRag = true;
    return this.index.size;
  }

  private permissionContext(): PermissionContext {
    return {
      rules: this.config.rules,
      defaultDecision: "ask",
      autoApprove: this.config.autoApprove,
    };
  }

  private providerFor(input: string): Provider {
    if (!this.router.enabled) return this.provider;
    const resolved = this.router.resolve({ task: "chat", input });
    const key = `${resolved.baseURL}|${resolved.model}|${resolved.apiKey}`;
    let p = this.providerCache.get(key);
    if (!p) {
      p = createProvider(resolved);
      this.providerCache.set(key, p);
    }
    return p;
  }

  async *chat(userInput: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    this.history.push({ role: "user", content: userInput });

    const activeProvider = this.providerFor(userInput);
    const turnStart = Date.now();
    let turnOutput = "";
    let turnToolCalls = 0;
    let turnSteps = 0;
    const baseLen = this.history.length;

    const toolContext: ToolContext = {
      workdir: this.config.workdir,
      config: this.config,
      approved: this.config.autoApprove,
      confirm: this.onConfirm,
    };

    let ragContext = "";
    if (this.useRag && this.index) {
      ragContext = await this.index.formatContextAsync(userInput, 6, 6000);
    }
    let memoryContext = "";
    if (!this.quiet) {
      try {
        const { loadProjectMemory } = await import("./memory.js");
        const mem = await loadProjectMemory(this.config);
        if (mem.conventions) memoryContext = mem.conventions;
      } catch {
        /* 忽略记忆读取失败 */
      }
    }
    const system = this.buildSystem(ragContext, memoryContext);

    for (let step = 0; step < this.config.maxSteps; step++) {
      turnSteps = step + 1;
      if (!this.quiet) yield { type: "step", index: step + 1 };

      const ctx = buildContext(system, this.history, this.config.budget);
      if (ctx.trimmed && !this.quiet) {
        yield {
          type: "context",
          tokens: ctx.tokens,
          dropped: ctx.dropped,
          trimmed: true,
        };
      }

      let assistantText = "";
      let toolCalls: ToolCall[] = [];
      let errored = false;

      for await (const ev of activeProvider.stream(
        ctx.messages,
        toolSchemas(this.excludeTools),
        signal
      )) {
        if (ev.type === "text") {
          assistantText += ev.delta;
          turnOutput += ev.delta;
          yield { type: "text", delta: ev.delta };
        } else if (ev.type === "tool_calls") {
          toolCalls = ev.toolCalls;
        } else if (ev.type === "error") {
          errored = true;
          yield { type: "error", message: ev.message };
        }
      }

      if (errored) return;

      if (toolCalls.length === 0) {
        this.history.push({ role: "assistant", content: assistantText });
        await this.save();
        this.recordTurnUsage(activeProvider, turnStart, turnOutput, turnSteps, turnToolCalls, baseLen);
        yield { type: "done" };
        return;
      }

      this.history.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        turnToolCalls++;
        const name = call.function.name;
        const rawArgs = call.function.arguments || "{}";
        if (!this.quiet) yield { type: "tool_start", name, args: rawArgs };

        let result: string;
        let ok = true;
        try {
          const tool = findTool(name);
          if (!tool) throw new Error(`未知工具: ${name}`);
          if (this.excludeTools.has(name)) {
            throw new Error(`该工具在当前上下文不可用: ${name}`);
          }
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {
            throw new Error(`工具参数不是合法 JSON: ${rawArgs}`);
          }

          // ---- 权限决策 ----
          const perm = decide(this.permissionContext(), name, parsed);
          // 规则未命中时：写操作默认询问，只读操作默认放行
          if (!perm.rule) {
            perm.decision = tool.mutating
              ? this.config.autoApprove
                ? "allow"
                : "ask"
              : "allow";
          }
          if (this.extraAllow.has(name) && perm.decision !== "deny") {
            perm.decision = "allow";
          }

          if (perm.decision === "deny") {
            result = `该工具被权限规则拒绝：${perm.reason}`;
            ok = false;
            this.history.push({
              role: "tool",
              tool_call_id: call.id,
              name,
              content: result,
            });
            if (!this.quiet) {
              yield { type: "tool_denied", name, reason: perm.reason };
              yield { type: "tool_end", name, ok, result };
            }
            continue;
          }

          if (perm.decision === "ask") {
            let allow = false;
            if (this.onConfirm) {
              allow = await this.onConfirm(
                `允许执行工具 ${name}?\n参数: ${rawArgs}`
              );
            }
            if (!allow) {
              result = `用户拒绝了工具 ${name} 的执行。`;
              ok = false;
              this.history.push({
                role: "tool",
                tool_call_id: call.id,
                name,
                content: result,
              });
              if (!this.quiet) {
                yield { type: "tool_denied", name, reason: "用户拒绝" };
                yield { type: "tool_end", name, ok, result };
              }
              continue;
            }
            this.extraAllow.add(name);
          }

          result = await this.runToolSafe(tool, parsed, toolContext, name);
        } catch (err) {
          ok = false;
          result = `错误: ${err instanceof Error ? err.message : String(err)}`;
        }

        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: result,
        });
        if (!this.quiet) {
          yield {
            type: "tool_end",
            name,
            ok,
            result: result.slice(0, 2000),
          };
        }
      }
    }

    if (!this.quiet) {
      yield {
        type: "error",
        message: `已达到最大工具调用轮数 (${this.config.maxSteps})，已停止。`,
      };
    }
    await this.save();
    this.recordTurnUsage(activeProvider, turnStart, turnOutput, turnSteps, turnToolCalls, baseLen);
    yield { type: "done" };
  }

  /** 记录本轮的 token 用量（用于统计与 trace） */
  private recordTurnUsage(
    provider: Provider,
    startMs: number,
    output: string,
    steps: number,
    toolCalls: number,
    baseLen: number
  ): void {
    if (this.quiet) return;
    try {
      const model = (provider as { model?: string }).model ?? this.config.model;
      void import("./observability.js").then((obs) => {
        obs.recordUsage({
          model,
          messages: this.history.slice(baseLen - 1),
          outputText: output,
          durationMs: Date.now() - startMs,
          steps,
          toolCalls,
        });
      });
    } catch {
      /* 统计失败不影响主流程 */
    }
  }

  /** 执行工具，带超时与错误捕获 */
  private async runToolSafe(
    tool: { run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string> },
    parsed: Record<string, unknown>,
    ctx: ToolContext,
    name: string
  ): Promise<string> {
    const timeout = this.config.toolTimeoutMs ?? 120_000;
    if (!timeout) return tool.run(parsed, ctx);
    let timer: NodeJS.Timeout;
    const guard = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`错误: 工具 ${name} 执行超时 (${timeout}ms)`), timeout);
    });
    try {
      return await Promise.race([tool.run(parsed, ctx), guard]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private buildSystem(ragContext: string, memoryContext = ""): string {
    const memoryBlock = memoryContext
      ? `\n\n以下是本项目的约定与记忆，请务必遵循：\n\n${memoryContext}`
      : "";
    if (this.systemPromptOverride) {
      return this.systemPromptOverride
        .replace("{WORKDIR}", this.config.workdir)
        .replace("{OS}", process.platform)
        .replace("{RAG_CONTEXT}", ragContext + memoryBlock);
    }
    return SYSTEM_PROMPT.replace("{WORKDIR}", this.config.workdir)
      .replace("{OS}", process.platform)
      .replace(
        "{RAG_CONTEXT}",
        (ragContext
          ? `以下是代码库检索到的相关片段，可作为参考：\n\n${ragContext}`
          : "") + memoryBlock
      );
  }
}
