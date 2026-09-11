import type { Config } from "./config.js";
import type { ChatMessage, ToolCall } from "./types.js";
import { createProvider, type Provider } from "./provider.js";
import { findTool, toolSchemas, type ToolContext } from "./tools.js";
import { CodeIndex } from "./rag.js";
import { decide, type PermissionContext } from "./permissions.js";
import { buildContext, historyTokens } from "./context.js";
import { installSubagentTool } from "./subagent.js";
import { installGitTools } from "./git.js";
import { installLspTools } from "./lsp.js";
import { installOrchestratorTools } from "./orchestrator.js";
import { installMemoryTool } from "./memory.js";
import { installSymbolTools } from "./symbols.js";
import { installEditEngine } from "./editer.js";
import { ModelRouter } from "./router.js";
import { log } from "./logger.js";
import { startSpan } from "./tracing.js";

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
  private summaryText?: string;

  constructor(opts: AgentOptions) {
    installSubagentTool();
    installGitTools();
    installLspTools();
    installOrchestratorTools();
    installMemoryTool();
    installSymbolTools();
    installEditEngine();
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

  async *chat(
    userInput: string | import("./types.js").ContentPart[],
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    const inputText =
      typeof userInput === "string"
        ? userInput
        : userInput
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join(" ");
    this.history.push({ role: "user", content: userInput });

    const activeProvider = this.providerFor(inputText);
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
      ragContext = await this.index.formatContextAsync(inputText, 6, 6000);
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
      if (this.config.autoSummary && !this.summaryText) {
        try {
          const { getProjectSummary } = await import("./summary.js");
          this.summaryText = await getProjectSummary(this.config);
        } catch {
          /* 忽略摘要失败 */
        }
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

      const llmSpan = this.quiet
        ? null
        : startSpan("llm.generate", {
            model: (activeProvider as { model?: string }).model ?? this.config.model,
            step: step + 1,
            messages: ctx.messages.length,
          });

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

      if (llmSpan) {
        llmSpan.setAttribute("outputChars", assistantText.length);
        llmSpan.setAttribute("toolCalls", toolCalls.length);
        llmSpan.end();
      }

      if (errored) return;

      if (toolCalls.length === 0) {
        this.history.push({ role: "assistant", content: assistantText });
        await this.save();
        this.recordTurnUsage(
          activeProvider,
          turnStart,
          turnOutput,
          turnSteps,
          turnToolCalls,
          baseLen
        );
        yield { type: "done" };
        return;
      }

      this.history.push({
        role: "assistant",
        content: assistantText || null,
        tool_calls: toolCalls,
      });

      // ---- 计划阶段：解析参数、查找工具、做权限决策 ----
      interface Planned {
        call: ToolCall;
        name: string;
        rawArgs: string;
        tool?: import("./tools.js").ToolDef;
        parsed?: Record<string, unknown>;
        // 已决定的结果（拒绝/错误）；若为空则待执行
        decided?: { result: string; ok: boolean };
        denyReason?: string;
        needConfirm: boolean;
        concurrent: boolean;
      }

      const planned: Planned[] = [];
      for (const call of toolCalls) {
        turnToolCalls++;
        const name = call.function.name;
        const rawArgs = call.function.arguments || "{}";
        const p: Planned = {
          call,
          name,
          rawArgs,
          needConfirm: false,
          concurrent: false,
        };
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
          p.tool = tool;
          p.parsed = parsed;

          const perm = decide(this.permissionContext(), name, parsed);
          if (!perm.rule) {
            perm.decision = tool.mutating ? (this.config.autoApprove ? "allow" : "ask") : "allow";
          }
          if (this.extraAllow.has(name) && perm.decision !== "deny") {
            perm.decision = "allow";
          }

          if (perm.decision === "deny") {
            p.decided = {
              result: `该工具被权限规则拒绝：${perm.reason}`,
              ok: false,
            };
            p.denyReason = perm.reason;
          } else if (perm.decision === "ask") {
            p.needConfirm = true;
          } else {
            // 只读且已授权 -> 可并发
            p.concurrent = !tool.mutating;
          }
        } catch (err) {
          p.decided = {
            result: `错误: ${err instanceof Error ? err.message : String(err)}`,
            ok: false,
          };
        }
        planned.push(p);
      }

      // ---- 逐个处理 needConfirm（用户交互不可并发） ----
      for (const p of planned) {
        if (!p.needConfirm) continue;
        let allow = false;
        if (this.onConfirm) {
          allow = await this.onConfirm(`允许执行工具 ${p.name}?\n参数: ${p.rawArgs}`);
        }
        if (allow) {
          this.extraAllow.add(p.name);
          // 确认后按写操作处理，仍串行执行
          p.concurrent = false;
        } else {
          p.decided = {
            result: `用户拒绝了工具 ${p.name} 的执行。`,
            ok: false,
          };
          p.denyReason = "用户拒绝";
        }
      }

      // ---- 执行阶段：只读已授权工具按并发池执行，其余串行 ----
      const maxConc = Math.max(1, this.config.concurrency ?? 4);
      const runnable = planned.filter((p) => !p.decided);
      const results = new Map<Planned, { result: string; ok: boolean }>();
      const emitOrder: Array<{ p: Planned; result: string; ok: boolean }> = [];

      // 串行队列（写操作、需要确认的）与并发队列（只读）
      const concurrentQueue = runnable.filter((p) => p.concurrent);
      const serialQueue = runnable.filter((p) => !p.concurrent);

      // 并发执行只读工具（限制并发数）
      const runOne = async (p: Planned): Promise<{ result: string; ok: boolean }> => {
        const t0 = Date.now();
        try {
          const result = await this.runToolSafe(p.tool!, p.parsed!, toolContext, p.name);
          log.info("tool.executed", { tool: p.name, ok: true, ms: Date.now() - t0 });
          return { result, ok: true };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn("tool.failed", { tool: p.name, error: msg, ms: Date.now() - t0 });
          return { result: `错误: ${msg}`, ok: false };
        }
      };

      const concResults = new Map<Planned, { result: string; ok: boolean }>();
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(maxConc, concurrentQueue.length) },
        async () => {
          while (cursor < concurrentQueue.length) {
            const idx = cursor++;
            const p = concurrentQueue[idx]!;
            concResults.set(p, await runOne(p));
          }
        }
      );
      await Promise.all(workers);

      for (const p of concurrentQueue) {
        const r = concResults.get(p)!;
        results.set(p, r);
        emitOrder.push({ p, result: r.result, ok: r.ok });
      }
      for (const p of serialQueue) {
        const r = await runOne(p);
        results.set(p, r);
        emitOrder.push({ p, result: r.result, ok: r.ok });
      }

      // ---- 按原始顺序写回历史与事件 ----
      for (const p of planned) {
        if (!this.quiet) yield { type: "tool_start", name: p.name, args: p.rawArgs };

        if (p.decided) {
          this.history.push({
            role: "tool",
            tool_call_id: p.call.id,
            name: p.name,
            content: p.decided.result,
          });
          if (!this.quiet) {
            if (p.denyReason) {
              yield { type: "tool_denied", name: p.name, reason: p.denyReason };
            }
            yield { type: "tool_end", name: p.name, ok: p.decided.ok, result: p.decided.result };
          }
          continue;
        }

        const r = results.get(p)!;
        this.history.push({
          role: "tool",
          tool_call_id: p.call.id,
          name: p.name,
          content: r.result,
        });
        if (!this.quiet) {
          yield { type: "tool_end", name: p.name, ok: r.ok, result: r.result.slice(0, 2000) };
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
    const summaryBlock = this.summaryText
      ? `\n\n以下是项目摘要，供你快速了解仓库结构：\n\n${this.summaryText}`
      : "";
    if (this.systemPromptOverride) {
      return this.systemPromptOverride
        .replace("{WORKDIR}", this.config.workdir)
        .replace("{OS}", process.platform)
        .replace("{RAG_CONTEXT}", ragContext + memoryBlock + summaryBlock);
    }
    return SYSTEM_PROMPT.replace("{WORKDIR}", this.config.workdir)
      .replace("{OS}", process.platform)
      .replace(
        "{RAG_CONTEXT}",
        (ragContext ? `以下是代码库检索到的相关片段，可作为参考：\n\n${ragContext}` : "") +
          memoryBlock +
          summaryBlock
      );
  }
}
