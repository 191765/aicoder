import type { Config } from "./config.js";
import { installMcpServers, closeMcpServers } from "./mcp.js";
import { installLspTools, setLspServers, closeLspClients } from "./lsp.js";
import { installGitTools } from "./git.js";

export interface ExtensionReport {
  lsp: number;
  mcp: { server: string; tools: number; error?: string }[];
}

/**
 * 初始化扩展能力：Git 工具常驻，LSP 按需启动，MCP 服务器立即连接并注册工具。
 */
export async function initExtensions(config: Config): Promise<ExtensionReport> {
  installGitTools();
  installLspTools();

  let lsp = 0;
  if (config.lspServers && Object.keys(config.lspServers).length) {
    setLspServers(config.lspServers);
    lsp = Object.keys(config.lspServers).length;
  }

  let mcp: ExtensionReport["mcp"] = [];
  if (config.mcpServers && Object.keys(config.mcpServers).length) {
    mcp = await installMcpServers(config.mcpServers);
  }

  return { lsp, mcp };
}

export function shutdownExtensions(): void {
  closeMcpServers();
  closeLspClients();
}
