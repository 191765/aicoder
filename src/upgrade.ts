import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * 自更新检查
 *
 * 查询 npm registry 上 @191765/aicoder 的最新版本并与当前版本对比，
 * 可选择全局升级。仅做检查与提示，不会静默安装。
 */

const PKG = "@191765/aicoder";

export function currentVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function latestVersion(timeoutMs = 8000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "aicoder" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export interface UpgradeCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export async function checkUpgrade(): Promise<UpgradeCheck> {
  const current = currentVersion();
  const latest = await latestVersion();
  return {
    current,
    latest,
    updateAvailable: latest !== null && cmp(latest, current) > 0,
  };
}

export function runGlobalInstall(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["install", "-g", `${PKG}@latest`],
      { shell: process.platform === "win32" }
    );
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", (e) => resolve({ code: -1, out: `npm 不可用: ${e.message}` }));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}
