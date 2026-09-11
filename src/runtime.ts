import type { Config } from "./config.js";
import { installMcpServers, closeMcpServers } from "./mcp.js";
import { installLspTools, setLspServers, closeLspClients } from "./lsp.js";
import { installGitTools } from "./git.js";
import { loadPlugins, type LoadedPlugin } from "./plugins.js";
import {
  initObservability,
  shutdownObservability,
} from "./observability.js";
import { initSecurity } from "./security.js";
import { installGithubTools, initGithub } from "./github.js";
import { setLocale } from "./i18n.js";

export interface ExtensionReport {
  lsp: number;
  mcp: { server: string; tools: number; error?: string }[];
  plugins: LoadedPlugin[];
}

/**
 * 初始化扩展能力：Git 工具常驻，LSP 按需启动，MCP 服务器与插件按配置加载。
 */
export async function initExtensions(config: Config): Promise<ExtensionReport> {
  installGitTools();
  installLspTools();
  installGithubTools();
  initGithub(config);
  setLocale(config.ui?.locale);
  initObservability(config);
  initSecurity(config);

  let lsp = 0;
  if (config.lspServers && Object.keys(config.lspServers).length) {
    setLspServers(config.lspServers);
    lsp = Object.keys(config.lspServers).length;
  }

  let mcp: ExtensionReport["mcp"] = [];
  if (config.mcpServers && Object.keys(config.mcpServers).length) {
    mcp = await installMcpServers(config.mcpServers);
  }

  let plugins: LoadedPlugin[] = [];
  if (config.plugins && config.plugins.length) {
    plugins = await loadPlugins(config);
  }

  return { lsp, mcp, plugins };
}

export function shutdownExtensions(): void {
  closeMcpServers();
  closeLspClients();
  shutdownObservability();
}
