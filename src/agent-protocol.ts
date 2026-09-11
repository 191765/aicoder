import type { Config } from "./config.js";

/**
 * Agent 协议（A2A 风格互操作）
 *
 * 对外暴露：
 *  - GET  /api/agent/card   Agent 能力卡片（名称/版本/技能/端点）
 *  - POST /api/agent/tasks  提交任务，返回结果（同步简化版）
 *
 * 采用简洁的任务/结果结构，便于其它 Agent 或系统集成。
 */

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
}

export interface AgentCard {
  name: string;
  version: string;
  description: string;
  protocol: string;
  capabilities: {
    streaming: boolean;
    tools: number;
    skills: AgentSkill[];
  };
  endpoints: {
    tasks: string;
    chat: string;
    card: string;
  };
}

export interface AgentTask {
  id?: string;
  input: string;
  useRag?: boolean;
  allowWrite?: boolean;
}

export interface AgentTaskResult {
  id: string;
  status: "completed" | "failed";
  output: string;
  toolCalls: string[];
  steps: number;
  error?: string;
}

export function buildAgentCard(config: Config, toolCount: number, version: string): AgentCard {
  return {
    name: "AICoder",
    version,
    description: "开源 AI 编程助手：可读写文件、执行命令、检索代码库",
    protocol: "aicoder-agent/1.0",
    capabilities: {
      streaming: true,
      tools: toolCount,
      skills: [
        { id: "code.read", name: "代码阅读", description: "读取、搜索、理解代码库" },
        { id: "code.write", name: "代码修改", description: "创建与编辑文件（受权限控制）" },
        { id: "command.run", name: "命令执行", description: "运行测试/构建等命令" },
        { id: "rag.search", name: "代码检索", description: "语义与关键词检索" },
        { id: "verify", name: "自验证", description: "运行测试并自检" },
      ],
    },
    endpoints: {
      tasks: "/api/agent/tasks",
      chat: "/api/chat",
      card: "/api/agent/card",
    },
  };
}

export function normalizeTask(body: Record<string, unknown>): AgentTask {
  return {
    id: typeof body.id === "string" ? body.id : undefined,
    input:
      typeof body.input === "string"
        ? body.input
        : typeof body.message === "string"
          ? body.message
          : "",
    useRag: body.useRag === true,
    allowWrite: body.allowWrite === true,
  };
}
