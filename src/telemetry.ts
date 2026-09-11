import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { Config } from "./config.js";

/**
 * 匿名遥测（默认关闭）
 *
 * 隐私优先：
 *  - 仅在显式开启（AICODER_TELEMETRY=1 或配置 telemetry.enabled）时上报
 *  - 只发送：随机安装 id、版本、操作系统种类、Node 主版本、命令名、是否成功
 *  - 绝不发送：代码、路径、对话内容、密钥、用户名
 *  - 可随时用 AICODER_TELEMETRY=0 关闭
 */

interface TelemetryConfig {
  enabled: boolean;
  endpoint?: string;
  installId: string;
}

let cfg: TelemetryConfig = { enabled: false, installId: "" };
let installIdPath: string | null = null;

function generateId(): string {
  return crypto.randomBytes(16).toString("hex");
}

async function loadInstallId(file: string): Promise<string> {
  try {
    const id = (await fs.readFile(file, "utf8")).trim();
    if (id) return id;
  } catch {
    /* 生成 */
  }
  const id = generateId();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, id, "utf8");
  } catch {
    /* 忽略 */
  }
  return id;
}

export async function initTelemetry(config: Config): Promise<void> {
  const enabled =
    process.env.AICODER_TELEMETRY !== undefined
      ? ["1", "true", "yes", "on"].includes(process.env.AICODER_TELEMETRY.toLowerCase())
      : (config.telemetry?.enabled ?? false);

  if (!enabled) {
    cfg = { enabled: false, installId: "" };
    return;
  }

  installIdPath = path.join(config.workdir, ".aicoder", "install-id");
  const installId = await loadInstallId(installIdPath);
  cfg = {
    enabled: true,
    endpoint: config.telemetry?.endpoint,
    installId,
  };
}

export interface TelemetryEvent {
  event: string;
  ok?: boolean;
  command?: string;
  durationMs?: number;
}

/** 发送一个匿名事件（未开启或失败时静默） */
export async function report(event: TelemetryEvent): Promise<void> {
  if (!cfg.enabled || !cfg.endpoint) return;
  const payload = {
    id: cfg.installId,
    version: process.env.npm_package_version,
    os: os.platform(),
    arch: os.arch(),
    node: process.versions.node.split(".")[0],
    ...event,
    ts: Date.now(),
  };
  try {
    await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "aicoder-telemetry" },
      body: JSON.stringify(payload),
    });
  } catch {
    /* 遥测失败不影响主流程 */
  }
}

export function telemetryEnabled(): boolean {
  return cfg.enabled;
}

/** 展示将要发送的数据结构（供文档与 doctor 使用） */
export function telemetrySample(version = "x.y.z"): Record<string, unknown> {
  return {
    id: "<随机安装 ID>",
    version,
    os: os.platform(),
    arch: os.arch(),
    node: process.versions.node.split(".")[0],
    event: "command",
    command: "chat",
    ok: true,
    ts: 0,
  };
}
