import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { registerTool, type ToolDef } from "./tools.js";

/**
 * 容错与恢复：编辑快照
 *
 * 写操作前自动保存受影响文件的快照到 .aicoder/snapshots/<id>/，
 * 支持按 id 回滚。用于从误改或崩溃中恢复。
 */

const SNAP_DIR = ".aicoder/snapshots";
const INDEX_FILE = ".aicoder/snapshots/index.json";

export interface Snapshot {
  id: string;
  ts: number;
  reason: string;
  files: Array<{ path: string; existed: boolean }>;
}

async function snapRoot(workdir: string): Promise<string> {
  const dir = path.join(workdir, SNAP_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readIndex(workdir: string): Promise<Snapshot[]> {
  try {
    const raw = await fs.readFile(path.join(workdir, INDEX_FILE), "utf8");
    return JSON.parse(raw) as Snapshot[];
  } catch {
    return [];
  }
}

async function writeIndex(workdir: string, list: Snapshot[]): Promise<void> {
  await snapRoot(workdir);
  await fs.writeFile(path.join(workdir, INDEX_FILE), JSON.stringify(list, null, 2), "utf8");
}

/**
 * 在修改前保存指定文件快照。返回快照 id。
 */
export async function createSnapshot(
  workdir: string,
  relPaths: string[],
  reason: string
): Promise<Snapshot> {
  const id = `snap-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const dir = path.join(await snapRoot(workdir), id);
  await fs.mkdir(dir, { recursive: true });

  const files: Snapshot["files"] = [];
  for (const rel of relPaths) {
    const normalized = rel.split(path.sep).join("/");
    const abs = path.resolve(workdir, normalized);
    try {
      const content = await fs.readFile(abs);
      const dest = path.join(dir, normalized);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, content);
      files.push({ path: normalized, existed: true });
    } catch {
      files.push({ path: normalized, existed: false });
    }
  }

  const snapshot: Snapshot = { id, ts: Date.now(), reason, files };
  const index = await readIndex(workdir);
  index.unshift(snapshot);
  // 仅保留最近 20 个
  await writeIndex(workdir, index.slice(0, 20));
  return snapshot;
}

export async function listSnapshots(workdir: string): Promise<Snapshot[]> {
  return readIndex(workdir);
}

/** 回滚：恢复指定快照中的文件内容 */
export async function restoreSnapshot(
  workdir: string,
  id: string
): Promise<{ restored: number; removed: number }> {
  const index = await readIndex(workdir);
  const snap = index.find((s) => s.id === id);
  if (!snap) throw new Error(`快照不存在: ${id}`);

  const dir = path.join(workdir, SNAP_DIR, id);
  let restored = 0;
  let removed = 0;
  for (const f of snap.files) {
    const abs = path.resolve(workdir, f.path);
    if (f.existed) {
      try {
        const content = await fs.readFile(path.join(dir, f.path));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
        restored++;
      } catch {
        /* 忽略 */
      }
    } else {
      // 快照时不存在 -> 回滚应删除
      try {
        await fs.unlink(abs);
        removed++;
      } catch {
        /* 不存在则忽略 */
      }
    }
  }
  return { restored, removed };
}

/** 崩溃恢复：找出最后一个未完成标记的快照（返回最近快照供提示） */
export async function lastSnapshot(workdir: string): Promise<Snapshot | null> {
  const index = await readIndex(workdir);
  return index[0] ?? null;
}

let installed = false;

const listSnapshotsTool: ToolDef = {
  name: "list_snapshots",
  description: "列出最近的编辑快照（写操作前自动创建），可用于回滚。",
  mutating: false,
  parameters: { type: "object", properties: {}, required: [] },
  async run(_args, ctx) {
    const list = await listSnapshots(ctx.workdir);
    if (!list.length) return "(暂无快照)";
    return list
      .map(
        (s) =>
          `${s.id}  ${new Date(s.ts).toLocaleString()}  ${s.reason}  文件: ${s.files
            .map((f) => f.path)
            .join(", ")}`
      )
      .join("\n");
  },
};

const restoreSnapshotTool: ToolDef = {
  name: "restore_snapshot",
  description: "回滚到指定快照：恢复其中的文件内容（快照时不存在的新文件会被删除）。",
  mutating: true,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "快照 id（来自 list_snapshots）" },
    },
    required: ["id"],
  },
  async run(args, ctx) {
    const id = typeof args.id === "string" ? args.id : "";
    if (!id) throw new Error("缺少 id");
    const r = await restoreSnapshot(ctx.workdir, id);
    return `已回滚 ${id}：恢复 ${r.restored} 个文件，删除 ${r.removed} 个文件`;
  },
};

export function installSnapshotTools(): void {
  if (installed) return;
  installed = true;
  registerTool(listSnapshotsTool);
  registerTool(restoreSnapshotTool);
}
