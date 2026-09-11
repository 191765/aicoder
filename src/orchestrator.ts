import { registerTool, type ToolDef, type ToolContext } from "./tools.js";
import type { Config } from "./config.js";
import type { Agent } from "./agent.js";

/**
 * 多代理编排
 *
 * - parallel: 并发运行多个子代理，各自独立上下文，汇总所有结论
 * - pipeline: 串行流水线，前一步的结论作为后一步的输入
 *
 * 子代理禁止再次使用 parallel/pipeline，避免无限递归。
 */

let installed = false;

const SUBAGENT_PROMPT = `你是 AICoder 的编排子代理，负责独立完成一项具体任务。

工作目录：{WORKDIR}
操作系统：{OS}

要求：
1. 聚焦任务，自主使用工具完成目标，不要向用户提问。
2. 完成后只输出简洁的「结论/产出」，不复述过程。
3. 所有路径相对于工作目录。

{RAG_CONTEXT}`;

async function runSubagent(
  ctx: ToolContext,
  prompt: string,
  maxSteps: number
): Promise<string> {
  const { Agent: AgentClass } = await import("./agent.js");
  const cfg: Config = { ...ctx.config, maxSteps };
  const sub: Agent = new AgentClass({
    config: cfg,
    onConfirm: ctx.confirm,
    excludeTools: new Set(["task", "parallel", "pipeline"]),
    systemPrompt: SUBAGENT_PROMPT,
    quiet: true,
  });
  let out = "";
  try {
    for await (const ev of sub.chat(prompt)) {
      if (ev.type === "text") out += ev.delta;
      else if (ev.type === "error") out += `\n[错误] ${ev.message}`;
    }
  } catch (err) {
    out += `\n[异常] ${err instanceof Error ? err.message : String(err)}`;
  }
  return out.trim() || "(无结论)";
}

const parallelTool: ToolDef = {
  name: "parallel",
  description:
    "并发运行多个子代理，每个子代理独立上下文。适合可并行的调研/分析任务。返回各子任务的结论。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "子任务列表",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "子任务标题" },
            prompt: { type: "string", description: "子任务的完整说明" },
          },
          required: ["prompt"],
        },
      },
      max_steps: { type: "number", description: "每个子代理最大轮数，默认 10" },
    },
    required: ["tasks"],
  },
  async run(args, ctx) {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (!tasks.length) throw new Error("缺少 tasks");
    const maxSteps =
      typeof args.max_steps === "number" && args.max_steps > 0
        ? Math.min(30, Math.floor(args.max_steps))
        : 10;

    const results = await Promise.all(
      tasks.map(async (t, i) => {
        const task = t as { description?: string; prompt?: string };
        const prompt = String(task.prompt ?? "");
        const desc = task.description ?? `子任务 ${i + 1}`;
        const conclusion = await runSubagent(ctx, prompt, maxSteps);
        return { desc, conclusion };
      })
    );

    return results
      .map((r, i) => `### [${i + 1}] ${r.desc}\n${r.conclusion}`)
      .join("\n\n");
  },
};

const pipelineTool: ToolDef = {
  name: "pipeline",
  description:
    "串行流水线：按顺序运行多个子代理，前一步的输出作为后一步的上下文。适合「调研→设计→实现」这类分阶段任务。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "按顺序执行的步骤",
        items: {
          type: "object",
          properties: {
            description: { type: "string", description: "步骤标题" },
            prompt: {
              type: "string",
              description:
                "步骤说明。可用 {{input}} 占位符引用上一步的结论。",
            },
          },
          required: ["prompt"],
        },
      },
      max_steps: { type: "number", description: "每个子代理最大轮数，默认 10" },
    },
    required: ["steps"],
  },
  async run(args, ctx) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    if (!steps.length) throw new Error("缺少 steps");
    const maxSteps =
      typeof args.max_steps === "number" && args.max_steps > 0
        ? Math.min(30, Math.floor(args.max_steps))
        : 10;

    let input = "";
    const outputs: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as { description?: string; prompt?: string };
      const desc = step.description ?? `步骤 ${i + 1}`;
      const raw = String(step.prompt ?? "");
      const prompt = raw.replace(/\{\{input\}\}/g, input);
      const conclusion = await runSubagent(ctx, prompt, maxSteps);
      outputs.push(`### [${i + 1}] ${desc}\n${conclusion}`);
      input = conclusion;
    }
    return outputs.join("\n\n");
  },
};

export function installOrchestratorTools(): void {
  if (installed) return;
  installed = true;
  registerTool(parallelTool);
  registerTool(pipelineTool);
}
