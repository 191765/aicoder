import fs from "node:fs/promises";
import path from "node:path";
import { registerTool, safeResolve, type ToolDef } from "./tools.js";
import { checkContent, audit } from "./security.js";

/**
 * 编辑引擎：批量、原子化的多处编辑
 *
 * 相比逐个 edit_file，multi_edit 在一次操作中对同一文件应用多组替换，
 * 任一处失败则整体回滚，避免出现"改一半"的不一致状态。
 */

export interface EditOp {
  old_string: string;
  new_string: string;
  /** 是否要求 old_string 唯一（默认 true） */
  unique?: boolean;
}

export interface EditResult {
  applied: number;
  errors: string[];
}

/** 在文本上应用一组编辑，返回新文本或错误 */
export function applyEdits(original: string, ops: EditOp[]): { text: string; errors: string[] } {
  let text = original;
  const errors: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    const oldStr = op.old_string;
    const newStr = op.new_string ?? "";
    const unique = op.unique ?? true;

    const count = oldStr === "" ? 0 : text.split(oldStr).length - 1;
    if (count === 0) {
      errors.push(`编辑 #${i + 1}: 未找到匹配文本`);
      continue;
    }
    if (unique && count > 1) {
      errors.push(`编辑 #${i + 1}: 匹配到 ${count} 处，不唯一`);
      continue;
    }
    // 逐一替换（非唯一时全部替换）
    text = unique ? text.replace(oldStr, newStr) : text.split(oldStr).join(newStr);
  }

  return { text, errors };
}

let installed = false;

const multiEditTool: ToolDef = {
  name: "multi_edit",
  description:
    "对同一文件原子性地应用多组替换。任一处失败则不改动文件并报告冲突。适合需要多处协调修改的场景。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对工作目录的文件路径" },
      edits: {
        type: "array",
        description: "编辑列表",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "被替换的原文" },
            new_string: { type: "string", description: "替换后的新文本" },
            unique: {
              type: "boolean",
              description: "是否要求唯一匹配，默认 true；false 时替换全部",
            },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async run(args, ctx) {
    const p = safeResolve(ctx.workdir, String(args.path ?? ""));
    const edits = Array.isArray(args.edits) ? (args.edits as EditOp[]) : [];
    if (!edits.length) throw new Error("缺少 edits");

    // 密钥检查：检查所有 new_string
    for (const e of edits) {
      const sc = checkContent(e.new_string ?? "");
      if (!sc.allowed) {
        audit({
          action: "block_secret_edit",
          tool: "multi_edit",
          target: String(args.path),
          ok: false,
          detail: sc.reason,
        });
        throw new Error(sc.reason);
      }
    }

    const original = await fs.readFile(p, "utf8");
    const { text, errors } = applyEdits(original, edits);

    if (errors.length) {
      audit({
        action: "multi_edit",
        tool: "multi_edit",
        target: String(args.path),
        ok: false,
        detail: errors.join("; "),
      });
      throw new Error(
        `编辑冲突，未做任何改动：\n${errors.join("\n")}\n\n请先用 read_file 确认当前内容后重试。`
      );
    }

    await fs.writeFile(p, text, "utf8");
    audit({
      action: "multi_edit",
      tool: "multi_edit",
      target: path.relative(ctx.workdir, p),
      ok: true,
    });
    return `已对 ${path.relative(ctx.workdir, p)} 应用 ${edits.length} 处编辑`;
  },
};

export function installEditEngine(): void {
  if (installed) return;
  installed = true;
  registerTool(multiEditTool);
}
