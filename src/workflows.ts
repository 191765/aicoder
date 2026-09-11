import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * 工作流模板 / 配方
 *
 * 预置常用任务，也可在 .aicoder/workflows/ 下放置 <name>.md 自定义。
 * 每个工作流是一段带占位符的提示，支持 {{args}}、{{workdir}} 等。
 */

export interface Workflow {
  name: string;
  description: string;
  prompt: string;
  source: "builtin" | "user";
}

const BUILTIN: Workflow[] = [
  {
    name: "review",
    description: "审查改动或指定文件，给出问题与改进建议",
    prompt:
      "请审查当前仓库的代码改动（优先使用 git_status 和 git_diff 查看未提交改动）。" +
      "重点检查：正确性、边界情况、安全隐患、可维护性、测试覆盖。给出按严重程度排序的结论。" +
      "额外关注：{{args}}",
    source: "builtin",
  },
  {
    name: "test",
    description: "为指定文件/模块编写测试",
    prompt:
      "请为 {{args}} 编写测试。先用 read_file 阅读源码理解行为，遵循项目已有测试框架与风格，" +
      "然后创建或补充测试文件，并运行测试命令验证通过。",
    source: "builtin",
  },
  {
    name: "refactor",
    description: "重构指定代码，保持行为不变",
    prompt:
      "请重构 {{args}}：在不改变外部行为的前提下提升可读性与结构。" +
      "先用 find_symbol / find_references 评估影响范围，小步修改，最后运行测试验证。",
    source: "builtin",
  },
  {
    name: "bugfix",
    description: "定位并修复 bug",
    prompt:
      "请修复以下问题：{{args}}。先复现或定位根因（search / find_symbol / run_command），" +
      "再做最小修复，并验证修复有效、未引入回归。",
    source: "builtin",
  },
  {
    name: "docs",
    description: "为指定模块补充文档",
    prompt:
      "请为 {{args}} 编写文档：说明用途、公共 API、使用示例与注意事项。" +
      "保持与项目现有文档风格一致。",
    source: "builtin",
  },
  {
    name: "explain",
    description: "解释指定代码或模块的作用",
    prompt:
      "请解释 {{args}} 的作用与关键实现。先阅读相关代码，再给出结构化的说明，" +
      "包括数据流、关键函数与依赖关系。",
    source: "builtin",
  },
];

export async function loadWorkflows(config: Config): Promise<Workflow[]> {
  const list: Workflow[] = [...BUILTIN];
  const dir = path.join(config.workdir, ".aicoder", "workflows");
  try {
    const files = await fs.readdir(dir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const name = path.basename(f, ".md");
      try {
        const content = (await fs.readFile(path.join(dir, f), "utf8")).trim();
        if (!content) continue;
        // 首个非标题行作为描述
        const firstLine =
          content
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l && !l.startsWith("#")) ?? "";
        const existing = list.findIndex((w) => w.name === name);
        const wf: Workflow = {
          name,
          description: firstLine.slice(0, 80),
          prompt: content,
          source: "user",
        };
        if (existing >= 0) list[existing] = wf;
        else list.push(wf);
      } catch {
        /* 忽略单个文件错误 */
      }
    }
  } catch {
    /* 无自定义目录 */
  }
  return list;
}

export function getWorkflow(list: Workflow[], name: string): Workflow | undefined {
  return list.find((w) => w.name === name);
}

/** 将工作流渲染为最终提示 */
export function renderWorkflow(wf: Workflow, args: string, workdir: string): string {
  return wf.prompt
    .replace(/\{\{args\}\}/g, args || "（未指定，请根据仓库当前状态判断）")
    .replace(/\{\{workdir\}\}/g, workdir);
}

export function builtinWorkflows(): Workflow[] {
  return BUILTIN.map((w) => ({ ...w }));
}
