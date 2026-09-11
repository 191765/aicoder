import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatMessage } from "./types.js";
import { createSnapshot, restoreSnapshot, listSnapshots, type Snapshot } from "./snapshots.js";

/**
 * 检查点与回放
 *
 * 检查点把「会话历史 + 受影响的文件快照」绑定在一起，形成可回放的时间点。
 * 回放可恢复当时的会话上下文与代码状态，用于从任意点重新出发。
 */

export interface Checkpoint {
  id: string;
  ts: number;
  sessionId?: string;
  label: string;
  snapshotId: string;
  messageCount: number;
}

const CP_DIR = ".aicoder/checkpoints";
const INDEX = ".aicoder/checkpoints/index.json";

async function readIndex(workdir: string): Promise<Checkpoint[]> {
  try {
    const raw = await fs.readFile(path.join(workdir, INDEX), "utf8");
    return JSON.parse(raw) as Checkpoint[];
  } catch {
    return [];
  }
}

async function writeIndex(workdir: string, list: Checkpoint[]): Promise<void> {
  const file = path.join(workdir, INDEX);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(list, null, 2), "utf8");
}

export async function createCheckpoint(
  workdir: string,
  label: string,
  messages: ChatMessage[],
  sessionId?: string,
  files: string[] = []
): Promise<Checkpoint> {
  const snap = await createSnapshot(workdir, files, `checkpoint:${label}`);
  const cp: Checkpoint = {
    id: `cp-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    ts: Date.now(),
    sessionId,
    label,
    snapshotId: snap.id,
    messageCount: messages.length,
  };
  // 保存会话历史副本
  const dir = path.join(workdir, CP_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${cp.id}.messages.json`), JSON.stringify(messages), "utf8");

  const index = await readIndex(workdir);
  index.unshift(cp);
  await writeIndex(workdir, index.slice(0, 50));
  return cp;
}

export async function listCheckpoints(workdir: string): Promise<Checkpoint[]> {
  return readIndex(workdir);
}

export async function loadCheckpointMessages(
  workdir: string,
  id: string
): Promise<ChatMessage[] | null> {
  try {
    const raw = await fs.readFile(path.join(workdir, CP_DIR, `${id}.messages.json`), "utf8");
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return null;
  }
}

export interface ReplayResult {
  restored: number;
  removed: number;
  messages: ChatMessage[];
}

/** 回放：恢复文件到检查点状态并返回当时的会话历史 */
export async function replayCheckpoint(workdir: string, id: string): Promise<ReplayResult> {
  const index = await readIndex(workdir);
  const cp = index.find((c) => c.id === id);
  if (!cp) throw new Error(`检查点不存在: ${id}`);
  const r = await restoreSnapshot(workdir, cp.snapshotId);
  const messages = (await loadCheckpointMessages(workdir, id)) ?? [];
  return { restored: r.restored, removed: r.removed, messages };
}

/** 列出可用于检查点的文件（最近修改的工作区文件） */
export async function recentFiles(workdir: string, limit = 50): Promise<string[]> {
  const files: Array<{ p: string; m: number }> = [];
  const ignore = new Set(["node_modules", ".git", "dist", ".aicoder", "coverage"]);
  const rec = async (dir: string): Promise<void> => {
    if (files.length >= limit * 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || ignore.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) {
        try {
          const st = await fs.stat(full);
          files.push({ p: path.relative(workdir, full).split(path.sep).join("/"), m: st.mtimeMs });
        } catch {
          /* 忽略 */
        }
      }
    }
  };
  await rec(workdir);
  return files
    .sort((a, b) => b.m - a.m)
    .slice(0, limit)
    .map((f) => f.p);
}

export type { Snapshot };
export { listSnapshots };
