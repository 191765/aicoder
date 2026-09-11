import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * 评估基准
 *
 * 定义一组任务与期望结果（文件内容断言、正则、文件存在性），
 * 运行 Agent 后自动评分，并可与基线对比检测回归。
 */

export interface EvalCheck {
  /** 检查类型 */
  type: "file_contains" | "file_exists" | "file_absent" | "regex";
  /** 目标文件（相对工作目录）或文本 */
  target: string;
  /** 期望值（file_contains / regex 使用） */
  expect?: string;
}

export interface EvalTask {
  name: string;
  prompt: string;
  /** 允许写操作 */
  allowWrite?: boolean;
  checks: EvalCheck[];
}

export interface EvalTaskResult {
  name: string;
  passed: boolean;
  score: number;
  details: Array<{ check: EvalCheck; ok: boolean; message: string }>;
  durationMs: number;
  text: string;
}

export interface EvalReport {
  total: number;
  passed: number;
  score: number;
  results: EvalTaskResult[];
  ts: number;
}

const EVAL_DIR = ".aicoder/evals";
const BASELINE_FILE = ".aicoder/eval-baseline.json";

/** 预置基准任务（幂等、可重复运行） */
export function builtinEvals(): EvalTask[] {
  return [
    {
      name: "create-file",
      prompt: "在工作目录下创建文件 aicoder_eval_hello.txt，内容为一行：HELLO_EVAL。只做这一件事。",
      allowWrite: true,
      checks: [
        { type: "file_exists", target: "aicoder_eval_hello.txt" },
        { type: "file_contains", target: "aicoder_eval_hello.txt", expect: "HELLO_EVAL" },
      ],
    },
    {
      name: "explain-no-write",
      prompt: "用一句话说明 README.md 的用途，不要修改任何文件。",
      allowWrite: false,
      checks: [{ type: "regex", target: "", expect: "." }],
    },
  ];
}

export async function loadEvalTasks(config: Config): Promise<EvalTask[]> {
  const tasks = builtinEvals();
  const dir = path.join(config.workdir, EVAL_DIR);
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), "utf8");
        const parsed = JSON.parse(raw) as EvalTask | EvalTask[];
        if (Array.isArray(parsed)) tasks.push(...parsed);
        else tasks.push(parsed);
      } catch {
        /* 忽略单个文件 */
      }
    }
  } catch {
    /* 无自定义目录 */
  }
  return tasks;
}

async function runCheck(
  check: EvalCheck,
  config: Config,
  agentText: string
): Promise<{ ok: boolean; message: string }> {
  const abs = check.target ? path.resolve(config.workdir, check.target) : "";
  switch (check.type) {
    case "file_exists": {
      try {
        await fs.access(abs);
        return { ok: true, message: `${check.target} 存在` };
      } catch {
        return { ok: false, message: `${check.target} 不存在` };
      }
    }
    case "file_absent": {
      try {
        await fs.access(abs);
        return { ok: false, message: `${check.target} 不应存在` };
      } catch {
        return { ok: true, message: `${check.target} 已不存在` };
      }
    }
    case "file_contains": {
      try {
        const content = await fs.readFile(abs, "utf8");
        const ok = content.includes(check.expect ?? "");
        return {
          ok,
          message: ok ? `${check.target} 包含期望内容` : `${check.target} 缺少 "${check.expect}"`,
        };
      } catch {
        return { ok: false, message: `${check.target} 不可读` };
      }
    }
    case "regex": {
      try {
        const re = new RegExp(check.expect ?? ".", "i");
        const ok = re.test(agentText);
        return { ok, message: ok ? "输出匹配" : `输出不匹配 /${check.expect}/` };
      } catch {
        return { ok: false, message: "非法正则" };
      }
    }
    default:
      return { ok: false, message: `未知检查类型` };
  }
}

/** 运行所有评估任务 */
export async function runEvals(
  config: Config,
  onProgress?: (name: string, index: number, total: number) => void
): Promise<EvalReport> {
  const tasks = await loadEvalTasks(config);
  const { Agent } = await import("./agent.js");
  const results: EvalTaskResult[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]!;
    onProgress?.(task.name, i + 1, tasks.length);
    const start = Date.now();
    const agent = new Agent({
      config: { ...config, autoApprove: task.allowWrite === true },
      persist: false,
      quiet: true,
    });
    let text = "";
    try {
      for await (const ev of agent.chat(task.prompt)) {
        if (ev.type === "text") text += ev.delta;
      }
    } catch (err) {
      text += `\n[错误] ${err instanceof Error ? err.message : String(err)}`;
    }

    const details = [];
    for (const check of task.checks) {
      const r = await runCheck(check, config, text);
      details.push({ check, ok: r.ok, message: r.message });
    }
    const passed = details.every((d) => d.ok);
    results.push({
      name: task.name,
      passed,
      score: details.length ? details.filter((d) => d.ok).length / details.length : 0,
      details,
      durationMs: Date.now() - start,
      text: text.slice(0, 500),
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const score = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
  return { total: results.length, passed, score, results, ts: Date.now() };
}

/** 保存基线 */
export async function saveBaseline(config: Config, report: EvalReport): Promise<void> {
  const file = path.join(config.workdir, BASELINE_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(report, null, 2), "utf8");
}

/** 加载基线 */
export async function loadBaseline(config: Config): Promise<EvalReport | null> {
  try {
    const raw = await fs.readFile(path.join(config.workdir, BASELINE_FILE), "utf8");
    return JSON.parse(raw) as EvalReport;
  } catch {
    return null;
  }
}

export interface RegressionResult {
  regressions: string[];
  improvements: string[];
}

/** 与基线对比，检测回归 */
export function compareWithBaseline(current: EvalReport, baseline: EvalReport): RegressionResult {
  const baseMap = new Map(baseline.results.map((r) => [r.name, r.score]));
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const r of current.results) {
    const base = baseMap.get(r.name);
    if (base === undefined) continue;
    if (r.score < base) regressions.push(`${r.name}: ${base.toFixed(2)} → ${r.score.toFixed(2)}`);
    else if (r.score > base)
      improvements.push(`${r.name}: ${base.toFixed(2)} → ${r.score.toFixed(2)}`);
  }
  return { regressions, improvements };
}
