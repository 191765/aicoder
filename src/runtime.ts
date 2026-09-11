import type { Config } from "./config.js";
import { installMcpServers, closeMcpServers } from "./mcp.js";
import { installLspTools, setLspServers, closeLspClients } from "./lsp.js";
import { installGitTools } from "./git.js";
import { installSubagentTool } from "./subagent.js";
import { installOrchestratorTools } from "./orchestrator.js";
import { installSymbolTools } from "./symbols.js";
import { installEditEngine } from "./editer.js";
import { installSnapshotTools } from "./snapshots.js";
import { installFeedbackTool } from "./feedback.js";
import { installMemoryTool } from "./memory.js";
import { loadPlugins, type LoadedPlugin } from "./plugins.js";
import { initObservability, shutdownObservability } from "./observability.js";
import { initSecurity } from "./security.js";
import { initSandbox } from "./sandbox.js";
import { installGithubTools, initGithub } from "./github.js";
import { setLocale } from "./i18n.js";
import { initLogger } from "./logger.js";

export interface ExtensionReport {
  lsp: number;
  mcp: { server: string; tools: number; error?: string }[];
  plugins: LoadedPlugin[];
}

/**
 * 初始化扩展能力：Git 工具常驻，LSP 按需启动，MCP 服务器与插件按配置加载。
 */
export async function initExtensions(config: Config): Promise<ExtensionReport> {
  initLogger();
  installGitTools();
  installLspTools();
  installGithubTools();
  installSubagentTool();
  installOrchestratorTools();
  installSymbolTools();
  installEditEngine();
  installSnapshotTools();
  installFeedbackTool();
  installMemoryTool();
  initGithub(config);
  setLocale(config.ui?.locale);
  initObservability(config);
  initSecurity(config);
  initSandbox(config);

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
