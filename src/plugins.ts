import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { registerTool, type ToolDef, type ToolContext } from "./tools.js";
import type { Config } from "./config.js";

/**
 * 插件系统
 *
 * 插件是本地 JS/MJS/CJS 文件（或 npm 包），默认导出：
 *   export default {
 *     name: "my-plugin",
 *     tools?: PluginTool[],
 *     commands?: PluginCommand[],
 *   }
 *
 * 插件工具会被注册进工具系统（可按 mutating 参与权限确认）；
 * 插件命令可在 CLI/TUI 中通过 `/插件名` 或以插件前缀调用。
 */

export interface PluginTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  mutating?: boolean;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string> | string;
}

export interface PluginCommandContext {
  args: string[];
  workdir: string;
  print(text: string): void;
}

export interface PluginCommand {
  name: string;
  description?: string;
  run(ctx: PluginCommandContext): Promise<void> | void;
}

export interface PluginModule {
  name?: string;
  tools?: PluginTool[];
  commands?: PluginCommand[];
  /** 插件加载时调用，可用于初始化 */
  setup?(config: Config): Promise<void> | void;
}

export interface LoadedPlugin {
  name: string;
  source: string;
  tools: string[];
  commands: string[];
  error?: string;
}

interface RegisteredPlugin {
  name: string;
  module: PluginModule;
  source: string;
}

const loadedPlugins: RegisteredPlugin[] = [];

const TOOL_NAME_PREFIX = "plugin__";

function normalizeTool(pluginName: string, t: PluginTool): ToolDef {
  // 工具名加插件前缀，避免与内置/其它插件冲突
  const name = t.name.startsWith(TOOL_NAME_PREFIX)
    ? t.name
    : `${TOOL_NAME_PREFIX}${pluginName}__${t.name}`;
  return {
    name,
    description: `[插件 ${pluginName}] ${t.description}`,
    mutating: t.mutating ?? true,
    parameters: t.parameters ?? { type: "object", properties: {} },
    async run(args, ctx) {
      return await t.run(args, ctx);
    },
  };
}

async function resolvePluginPath(spec: string, workdir: string): Promise<string> {
  // 相对路径 / 绝对路径
  if (spec.startsWith(".") || path.isAbsolute(spec)) {
    const base = path.isAbsolute(spec) ? spec : path.resolve(workdir, spec);
    return await resolveFile(base);
  }
  // npm 包名：从工作目录的 node_modules 解析
  try {
    const resolved = await import("node:module");
    const require = resolved.createRequire(path.join(workdir, "noop.js"));
    return require.resolve(spec);
  } catch {
    throw new Error(`无法解析插件: ${spec}`);
  }
}

async function resolveFile(base: string): Promise<string> {
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
  ];
  for (const c of candidates) {
    try {
      const st = await fs.stat(c);
      if (st.isFile()) return c;
    } catch {
      /* 继续 */
    }
  }
  throw new Error(`插件文件不存在: ${base}`);
}

export async function loadPlugins(config: Config, specs?: string[]): Promise<LoadedPlugin[]> {
  const list = specs ?? config.plugins ?? [];
  const report: LoadedPlugin[] = [];
  for (const spec of list) {
    try {
      const file = await resolvePluginPath(spec, config.workdir);
      const mod = (await import(pathToFileURL(file).href)) as {
        default?: PluginModule;
      } & Partial<PluginModule>;
      const plugin: PluginModule = mod.default ?? (mod as PluginModule);
      const name = plugin.name ?? path.basename(file, path.extname(file));

      if (plugin.setup) await plugin.setup(config);

      const registeredTools: string[] = [];
      for (const t of plugin.tools ?? []) {
        if (!t?.name || typeof t.run !== "function") continue;
        const def = normalizeTool(name, t);
        registerTool(def);
        registeredTools.push(def.name);
      }

      const commandNames: string[] = [];
      for (const c of plugin.commands ?? []) {
        if (typeof c?.run === "function") commandNames.push(c.name);
      }

      loadedPlugins.push({ name, module: plugin, source: file });
      report.push({
        name,
        source: file,
        tools: registeredTools,
        commands: commandNames,
      });
    } catch (err) {
      report.push({
        name: spec,
        source: spec,
        tools: [],
        commands: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

/** 查找插件命令（支持 `/命令名`） */
export function findPluginCommand(
  commandName: string
): { plugin: string; command: PluginCommand } | null {
  const clean = commandName.replace(/^\//, "");
  for (const p of loadedPlugins) {
    const cmd = (p.module.commands ?? []).find((c) => c.name === clean);
    if (cmd) return { plugin: p.name, command: cmd };
  }
  return null;
}

export function listPluginCommands(): Array<{
  plugin: string;
  name: string;
  description?: string;
}> {
  const out: Array<{ plugin: string; name: string; description?: string }> = [];
  for (const p of loadedPlugins) {
    for (const c of p.module.commands ?? []) {
      out.push({ plugin: p.name, name: c.name, description: c.description });
    }
  }
  return out;
}

export function loadedPluginNames(): string[] {
  return loadedPlugins.map((p) => p.name);
}
