import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { ChatMessage } from "./types.js";

/**
 * 会话持久化
 *
 * 默认存储目录：
 *   Windows: %APPDATA%/aicoder/sessions
 *   其它:    $XDG_CONFIG_HOME/aicoder/sessions  或  ~/.config/aicoder/sessions
 * 可用环境变量 AICODER_HOME 覆盖根目录。
 */

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  workdir: string;
  model: string;
  messageCount: number;
}

export interface StoredSession extends SessionMeta {
  messages: ChatMessage[];
}

export function sessionsDir(): string {
  const home = os.homedir();
  const base =
    process.env.AICODER_HOME ??
    (process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? path.join(home, ".config")));
  return path.join(base, "aicoder", "sessions");
}

export function newSessionId(): string {
  return (
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") +
    "-" +
    crypto.randomBytes(3).toString("hex")
  );
}

function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

export async function saveSession(session: StoredSession): Promise<void> {
  const dir = sessionsDir();
  await fs.mkdir(dir, { recursive: true });
  session.updatedAt = Date.now();
  const tmp = sessionPath(session.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(session, null, 2), "utf8");
  await fs.rename(tmp, sessionPath(session.id));
}

export async function loadSession(id: string): Promise<StoredSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(id), "utf8");
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function listSessions(): Promise<SessionMeta[]> {
  const dir = sessionsDir();
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const metas: SessionMeta[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, f), "utf8");
      const s = JSON.parse(raw) as StoredSession;
      metas.push({
        id: s.id,
        title: s.title,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        workdir: s.workdir,
        model: s.model,
        messageCount: s.messages?.length ?? 0,
      });
    } catch {
      /* 忽略损坏文件 */
    }
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return metas;
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await fs.unlink(sessionPath(id));
    return true;
  } catch {
    return false;
  }
}

/** 从消息历史生成会话标题（取首条用户消息） */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user" && m.content);
  if (!first?.content) return "(空会话)";
  const text =
    typeof first.content === "string"
      ? first.content
      : first.content.map((p) => (p.type === "text" ? p.text : "[图片]")).join(" ");
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 40 ? t.slice(0, 40) + "…" : t;
}

/** 根据消息历史构造/更新会话对象 */
export function buildSession(
  id: string,
  workdir: string,
  model: string,
  messages: ChatMessage[],
  createdAt?: number
): StoredSession {
  const now = Date.now();
  return {
    id,
    title: deriveTitle(messages),
    createdAt: createdAt ?? now,
    updatedAt: now,
    workdir,
    model,
    messageCount: messages.length,
    messages,
  };
}
