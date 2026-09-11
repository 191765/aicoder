import fs from "node:fs/promises";
import path from "node:path";
import { registerTool, type ToolDef } from "./tools.js";

/**
 * 反馈与微调数据
 *
 * - 采集用户反馈（评分、评论）到 .aicoder/feedback.jsonl
 * - 导出偏好数据集（SFT / DPO 风格）供微调
 */

const FEEDBACK_FILE = ".aicoder/feedback.jsonl";
const PREFERENCE_FILE = ".aicoder/preferences.jsonl";

export interface FeedbackEntry {
  ts: number;
  sessionId?: string;
  rating: 1 | 0 | -1;
  comment?: string;
  prompt?: string;
  response?: string;
  model?: string;
}

export async function recordFeedback(workdir: string, entry: FeedbackEntry): Promise<void> {
  const file = path.join(workdir, FEEDBACK_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf8");
}

export async function readFeedback(workdir: string): Promise<FeedbackEntry[]> {
  try {
    const raw = await fs.readFile(path.join(workdir, FEEDBACK_FILE), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FeedbackEntry);
  } catch {
    return [];
  }
}

/**
 * 导出微调数据。
 * - mode=sft：正反馈的 {prompt, response}
 * - mode=dpo：含正负反馈的偏好对 {prompt, chosen, rejected}
 */
export async function exportTrainingData(
  workdir: string,
  mode: "sft" | "dpo"
): Promise<{ count: number; file: string }> {
  const entries = await readFeedback(workdir);
  const out = path.join(workdir, PREFERENCE_FILE);
  await fs.mkdir(path.dirname(out), { recursive: true });

  const lines: string[] = [];
  if (mode === "sft") {
    for (const e of entries) {
      if (e.rating > 0 && e.prompt && e.response) {
        lines.push(JSON.stringify({ prompt: e.prompt, response: e.response }));
      }
    }
  } else {
    // 按 prompt 分组，正反馈为 chosen，负反馈为 rejected
    const byPrompt = new Map<string, { chosen?: string; rejected?: string }>();
    for (const e of entries) {
      if (!e.prompt || !e.response) continue;
      const rec = byPrompt.get(e.prompt) ?? {};
      if (e.rating > 0) rec.chosen = e.response;
      else if (e.rating < 0) rec.rejected = e.response;
      byPrompt.set(e.prompt, rec);
    }
    for (const [prompt, rec] of byPrompt) {
      if (rec.chosen && rec.rejected) {
        lines.push(JSON.stringify({ prompt, chosen: rec.chosen, rejected: rec.rejected }));
      }
    }
  }

  await fs.writeFile(out, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
  return { count: lines.length, file: out };
}

let installed = false;

const feedbackTool: ToolDef = {
  name: "submit_feedback",
  description:
    "记录对上一次回答的反馈（rating: 1 赞 / 0 中 / -1 踩），可选评论。用于改进与微调数据采集。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      rating: { type: "number", description: "1 赞 / 0 中 / -1 踩" },
      comment: { type: "string", description: "可选评论" },
      prompt: { type: "string", description: "对应的用户输入（可选）" },
      response: { type: "string", description: "对应的助手回答（可选）" },
    },
    required: ["rating"],
  },
  async run(args, ctx) {
    const rating = Number(args.rating);
    if (![1, 0, -1].includes(rating)) throw new Error("rating 必须为 1 / 0 / -1");
    await recordFeedback(ctx.workdir, {
      ts: Date.now(),
      rating: rating as 1 | 0 | -1,
      comment: typeof args.comment === "string" ? args.comment : undefined,
      prompt: typeof args.prompt === "string" ? args.prompt : undefined,
      response: typeof args.response === "string" ? args.response : undefined,
      model: ctx.config.model,
    });
    return `已记录反馈 (rating=${rating})`;
  },
};

export function installFeedbackTool(): void {
  if (installed) return;
  installed = true;
  registerTool(feedbackTool);
}
