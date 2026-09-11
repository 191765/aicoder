import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { registerTool, type ToolDef, type ToolContext } from "./tools.js";

/**
 * 极简 MCP (Model Context Protocol) 客户端
 *
 * 通过 stdio 运行 MCP server，使用 JSON-RPC 2.0 通信：
 *   initialize -> tools/list -> tools/call
 * 发现的工具会以 `mcp__<server>__<tool>` 名称注册进工具系统。
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

class McpClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (r: JsonRpcResponse) => void>();
  readonly name: string;
  private closed = false;

  constructor(name: string, cfg: McpServerConfig) {
    this.name = name;
    this.child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk.toString("utf8")));
    this.child.stderr.on("data", () => {
      /* 忽略 MCP server 的日志 */
    });
    this.child.on("error", () => {
      this.closed = true;
    });
    this.child.on("close", () => {
      this.closed = true;
      for (const [, resolve] of this.pending) {
        resolve({ jsonrpc: "2.0", id: -1, error: { code: -1, message: "MCP server 已退出" } });
      }
      this.pending.clear();
    });
  }

  private onData(text: string): void {
    this.buffer += text;
    // MCP stdio 使用按行分隔的 JSON（LSP 风格也兼容 Content-Length，这里做两种解析）
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      // 兼容 Content-Length: N\r\n\r\n{json}
      if (line.toLowerCase().startsWith("content-length:")) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const resolve = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
  }

  private request(method: string, params: unknown): Promise<JsonRpcResponse> {
    if (this.closed) {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: -1,
        error: { code: -1, message: "MCP server 不可用" },
      });
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.child.stdin.write(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ jsonrpc: "2.0", id, error: { code: -1, message: "MCP 请求超时" } });
        }
      }, 30_000);
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "aicoder", version: "0.1.0" },
    });
    // 发送 initialized 通知（无 id，不等待响应）
    try {
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
      );
    } catch {
      /* 忽略 */
    }
  }

  async listTools(): Promise<
    Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  > {
    const res = await this.request("tools/list", {});
    if (res.error) throw new Error(res.error.message);
    const result = res.result as { tools?: unknown[] } | undefined;
    return (result?.tools ?? []) as Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res.error) return `MCP 调用错误: ${res.error.message}`;
    const result = res.result as
      | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
      | undefined;
    const parts = (result?.content ?? [])
      .map((c) => c.text ?? (c.type === "image" ? "[图片]" : ""))
      .filter(Boolean);
    return parts.join("\n") || "(无返回内容)";
  }

  close(): void {
    try {
      this.child.kill();
    } catch {
      /* 忽略 */
    }
  }
}

const clients: McpClient[] = [];

export async function installMcpServers(
  servers: Record<string, McpServerConfig>
): Promise<{ server: string; tools: number; error?: string }[]> {
  const report: { server: string; tools: number; error?: string }[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    if (!cfg?.command) {
      report.push({ server: name, tools: 0, error: "缺少 command" });
      continue;
    }
    try {
      const client = new McpClient(name, cfg);
      await client.initialize();
      const list = await client.listTools();
      for (const t of list) {
        const toolName = `mcp__${name}__${t.name}`;
        const def: ToolDef = {
          name: toolName,
          description: t.description ?? `MCP 工具 ${t.name}（来自 ${name}）`,
          mutating: true,
          parameters: (t.inputSchema as Record<string, unknown>) ?? {
            type: "object",
            properties: {},
          },
          async run(args: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
            return client.callTool(t.name, args);
          },
        };
        registerTool(def);
      }
      clients.push(client);
      report.push({ server: name, tools: list.length });
    } catch (err) {
      report.push({
        server: name,
        tools: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return report;
}

export function closeMcpServers(): void {
  for (const c of clients) c.close();
  clients.length = 0;
}
