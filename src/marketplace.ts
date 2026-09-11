import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Config } from "./config.js";

/**
 * 插件市场
 *
 * 通过 npm registry 搜索/安装 AICoder 插件（约定包名含关键字 `aicoder-plugin`
 * 或 tag `aicoder-plugin`），并写入 .aicoder.json 的 plugins 列表。
 */

const REGISTRY = "https://registry.npmjs.org";
const SEARCH_KEYWORD = "aicoder-plugin";

export interface MarketPackage {
  name: string;
  version: string;
  description: string;
  author?: string;
  keywords?: string[];
  homepage?: string;
}

async function fetchJson(url: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "aicoder" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 搜索插件 */
export async function searchPlugins(query = "", limit = 20): Promise<MarketPackage[]> {
  const q = query ? `${query} keywords:${SEARCH_KEYWORD}` : `keywords:${SEARCH_KEYWORD}`;
  const url = `${REGISTRY}/-/v1/search?text=${encodeURIComponent(q)}&size=${limit}`;
  try {
    const data = (await fetchJson(url)) as {
      objects?: Array<{
        package: {
          name: string;
          version: string;
          description?: string;
          author?: { name?: string } | string;
          keywords?: string[];
          links?: { homepage?: string };
        };
      }>;
    };
    return (data.objects ?? []).map((o) => ({
      name: o.package.name,
      version: o.package.version,
      description: o.package.description ?? "",
      author: typeof o.package.author === "string" ? o.package.author : o.package.author?.name,
      keywords: o.package.keywords,
      homepage: o.package.links?.homepage,
    }));
  } catch (err) {
    throw new Error(`搜索失败: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

function runNpm(
  args: string[],
  cwd: string,
  timeout = 180_000
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd,
      shell: process.platform === "win32",
    });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out: out + "\n[超时]" });
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `npm 不可用: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/** 将插件写入 .aicoder.json 的 plugins 数组 */
export async function addPluginToConfig(config: Config, pkg: string): Promise<string> {
  const file = path.join(config.workdir, ".aicoder.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    /* 新建 */
  }
  const plugins = Array.isArray(cfg.plugins) ? (cfg.plugins as string[]) : [];
  if (!plugins.includes(pkg)) plugins.push(pkg);
  cfg.plugins = plugins;
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  return file;
}

/** 安装插件（npm install 并写入配置） */
export async function installPlugin(
  config: Config,
  pkg: string
): Promise<{ ok: boolean; output: string; configPath?: string }> {
  // 校验包名，避免命令注入
  if (!/^(@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i.test(pkg)) {
    return { ok: false, output: `非法包名: ${pkg}` };
  }
  const res = await runNpm(["install", "--save", pkg], config.workdir);
  if (res.code !== 0) {
    return { ok: false, output: res.out };
  }
  const configPath = await addPluginToConfig(config, pkg);
  return { ok: true, output: res.out, configPath };
}

/** 卸载插件 */
export async function uninstallPlugin(
  config: Config,
  pkg: string
): Promise<{ ok: boolean; output: string }> {
  const res = await runNpm(["uninstall", pkg], config.workdir);
  const file = path.join(config.workdir, ".aicoder.json");
  try {
    const cfg = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    if (Array.isArray(cfg.plugins)) {
      cfg.plugins = (cfg.plugins as string[]).filter((p) => p !== pkg);
      await fs.writeFile(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    }
  } catch {
    /* 忽略 */
  }
  return { ok: res.code === 0, output: res.out };
}
