import { registerTool, type ToolDef } from "./tools.js";
import type { Config } from "./config.js";
import type { Agent } from "./agent.js";

/**
 * 子代理（subagent）
 *
 * 主 Agent 通过 `task` 工具把一项独立任务派发给子代理。
 * 子代理拥有独立上下文与工具集，运行结束后只把「最终结论」回传给主 Agent，
 * 从而避免中间过程（大量工具输出、探索记录）污染主上下文。
 *
 * 子代理禁止再次派发 `task`，避免无限递归。
 */

let installed = false;

const TASK_TOOL: ToolDef = {
  name: "task",
  description:
    "派发一个独立子任务给子代理执行。适合：探索代码库、搜索定位、编写/运行测试、独立的调研或实现工作。" +
    "子代理拥有独立上下文，只会返回简洁的最终结论。请给出明确、自包含的任务描述。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "任务简短标题（用于日志展示）",
      },
      prompt: {
        type: "string",
        description: "给子代理的完整任务说明，应自包含：目标、范围、期望产出。",
      },
      max_steps: {
        type: "number",
        description: "子代理最多工具调用轮数，默认 12",
      },
    },
    required: ["prompt"],
  },
  async run(args, ctx): Promise<string> {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt.trim()) throw new Error("缺少 prompt");
    const description =
      typeof args.description === "string" && args.description.trim()
        ? args.description.trim()
        : prompt.slice(0, 40);
    const maxSteps =
      typeof args.max_steps === "number" && Number.isFinite(args.max_steps)
        ? Math.max(1, Math.min(30, Math.floor(args.max_steps)))
        : 12;

    const { Agent: AgentClass } = await import("./agent.js");

    const subConfig: Config = {
      ...ctx.config,
      maxSteps,
    };

    const sub: Agent = new AgentClass({
      config: subConfig,
      useRag: false,
      // 子代理继承确认能力；若主流程自动批准，子代理也自动批准
      onConfirm: ctx.confirm,
      extraAllow: new Set(),
      // 禁止递归派发
      excludeTools: new Set(["task"]),
      systemPrompt: SUBAGENT_PROMPT,
      quiet: true,
    });

    let conclusion = "";
    let steps = 0;
    try {
      for await (const ev of sub.chat(prompt)) {
        if (ev.type === "text") conclusion += ev.delta;
        else if (ev.type === "step") steps = ev.index;
        else if (ev.type === "error") {
          conclusion += `\n[子代理错误] ${ev.message}`;
        }
      }
    } catch (err) {
      conclusion += `\n[子代理异常] ${err instanceof Error ? err.message : String(err)}`;
    }

    const body = conclusion.trim() || "(子代理未返回文本结论)";
    return `【子任务：${description}】（工具轮数 ${steps}）\n${body}`;
  },
};

const SUBAGENT_PROMPT = `你是 AICoder 的子代理，负责独立完成主代理派发的一项具体任务。

工作目录：{WORKDIR}
操作系统：{OS}

要求：
1. 聚焦任务本身，自主使用工具（读文件、搜索、执行命令等）完成目标。
2. 不要向用户提问，独立做出合理判断；遇到阻塞时给出你能得到的最佳结论。
3. 完成后只输出简洁的「结论/产出」，不要复述探索过程。
4. 若修改了文件，明确列出改动的文件与要点。
5. 所有路径相对于工作目录。

{RAG_CONTEXT}`;

export function installSubagentTool(): void {
  if (installed) return;
  installed = true;
  registerTool(TASK_TOOL);
}
