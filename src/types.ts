export type Role = "system" | "user" | "assistant" | "tool";

/** 多模态内容块 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatMessage {
  role: Role;
  /** 纯文本，或多模态内容块数组 */
  content: string | ContentPart[] | null;
  /** assistant 消息中发起的工具调用 */
  tool_calls?: ToolCall[];
  /** role=tool 时对应的调用 id */
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  ok: boolean;
}

/** Provider 层流式事件 */
export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; message: string };

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}
