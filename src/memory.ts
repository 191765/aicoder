import fs from "node:fs/promises";
import path from "node:path";
import { registerTool, type ToolDef } from "./tools.js";
import type { Config } from "./config.js";

/**
 * 项目记忆
 *
 * 1. 约定文件：自动读取工作目录中的 AGENTS.md / .aicoder/memory.md /
 *    .aicoder/notes/*.md，注入系统提示，让助手遵循项目约定。
 * 2. 知识沉淀：提供 remember 工具，把结论追加写入 .aicoder/memory.md，
 *    跨会话保留。
 */

const CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md", ".aicoder/memory.md"];

const NOTES_DIR = ".aicoder/notes";
const MEMORY_FILE = ".aicoder/memory.md";

export interface ProjectMemory {
  /** 拼接后的约定内容 */
  conventions: string;
  /** 命中的文件 */
  sources: string[];
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return null;
    const text = await fs.readFile(p, "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

export async function loadProjectMemory(config: Config): Promise<ProjectMemory> {
  const root = config.workdir;
  const parts: string[] = [];
  const sources: string[] = [];

  for (const rel of CONVENTION_FILES) {
    const content = await readIfExists(path.join(root, rel));
    if (content) {
      parts.push(`### ${rel}\n${content}`);
      sources.push(rel);
    }
  }

  // notes 目录
  try {
    const notesDir = path.join(root, NOTES_DIR);
    const entries = await fs.readdir(notesDir);
    for (const f of entries.sort()) {
      if (!f.endsWith(".md")) continue;
      const content = await readIfExists(path.join(notesDir, f));
      if (content) {
        parts.push(`### ${NOTES_DIR}/${f}\n${content}`);
        sources.push(`${NOTES_DIR}/${f}`);
      }
    }
  } catch {
    /* 无 notes 目录 */
  }

  return { conventions: parts.join("\n\n"), sources };
}

let installed = false;

const rememberTool: ToolDef = {
  name: "remember",
  description:
    "将一条重要结论/约定/偏好写入项目记忆 (.aicoder/memory.md)，供后续会话参考。适合记录架构决策、项目约定、易错点。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "要记住的内容（简洁、自包含的一条）",
      },
    },
    required: ["content"],
  },
  async run(args, ctx) {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) throw new Error("缺少 content");
    const file = path.join(ctx.workdir, MEMORY_FILE);
    await fs.mkdir(path.dirname(file), { recursive: true });

    let header = "";
    try {
      await fs.access(file);
    } catch {
      header = "# 项目记忆\n\n由 AICoder 自动沉淀，供后续会话参考。\n";
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const entry = `- (${stamp}) ${content.replace(/\n+/g, " ")}\n`;
    const existing = header ? header : await fs.readFile(file, "utf8").catch(() => "");
    await fs.writeFile(file, existing + entry, "utf8");

    // 同步写入结构化记忆存储（供语义检索）
    try {
      const { getMemoryStore } = await import("./memory-store.js");
      const store = await getMemoryStore(ctx.config);
      await store.add(content, { source: "remember" });
    } catch {
      /* 忽略 */
    }

    return `已记录到 ${MEMORY_FILE}`;
  },
};

export function installMemoryTool(): void {
  if (installed) return;
  installed = true;
  registerTool(rememberTool);
}
