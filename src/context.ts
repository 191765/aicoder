import type { ChatMessage } from "./types.js";

/**
 * 上下文管理：token 估算、历史裁剪、工具结果摘要。
 *
 * 估算方式为无依赖的近似值：
 *  - ASCII 约 4 字符/token
 *  - CJK 约 1 字符/token
 */

export interface ContextBudget {
  /** 上下文窗口总预算（token） */
  maxContextTokens: number;
  /** 为模型输出预留的 token */
  reserveForOutput: number;
  /** 至少保留的最近消息条数（不裁剪） */
  keepRecentMessages: number;
  /** 单个工具结果超过该字符数时进行摘要 */
  toolResultMaxChars: number;
}

export const DEFAULT_BUDGET: ContextBudget = {
  maxContextTokens: 32768,
  reserveForOutput: 4096,
  keepRecentMessages: 8,
  toolResultMaxChars: 4000,
};

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x2e80) cjk++;
    else ascii++;
  }
  return Math.ceil(ascii / 4 + cjk);
}

export function messageTokens(msg: ChatMessage): number {
  let total = 0;
  if (typeof msg.content === "string") {
    total = estimateTokens(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part.type === "text") total += estimateTokens(part.text);
      else if (part.type === "image_url") total += 1000; // 图片粗略估算
    }
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      total += estimateTokens(tc.function.name);
      total += estimateTokens(tc.function.arguments);
    }
  }
  // 每条消息的固定开销
  return total + 4;
}

export function historyTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

/** 对过长的工具结果做压缩摘要，保留首尾关键信息 */
export function summarizeToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  const omitted = content.length - maxChars;
  return (
    content.slice(0, head) +
    `\n\n... [已省略 ${omitted} 字符，完整内容可通过重新读取获取] ...\n\n` +
    content.slice(content.length - tail)
  );
}

export interface TrimResult {
  /** 送入模型的消息（含 system） */
  messages: ChatMessage[];
  /** 被裁剪掉的消息数 */
  dropped: number;
  /** 估算的总 token */
  tokens: number;
  /** 是否实际发生了裁剪 */
  trimmed: boolean;
}

/**
 * 在预算内构建发送给模型的消息列表。
 * 策略：
 *  1. 始终保留 system
 *  2. 从最新往旧保留消息，直到接近预算
 *  3. 至少保留 keepRecentMessages 条
 *  4. 保证 tool 消息与其前置 assistant(tool_calls) 成对，避免协议错误
 *  5. 对超长工具结果做摘要
 */
export function buildContext(
  system: string,
  history: ChatMessage[],
  budget: ContextBudget = DEFAULT_BUDGET
): TrimResult {
  const systemTokens = estimateTokens(system) + 4;
  const available = Math.max(
    256,
    budget.maxContextTokens - budget.reserveForOutput - systemTokens
  );

  // 先对历史中的工具结果做长度压缩（不改变消息数量）
  const normalized = history.map((m) => {
    if (
      m.role === "tool" &&
      typeof m.content === "string" &&
      m.content.length > budget.toolResultMaxChars
    ) {
      return { ...m, content: summarizeToolResult(m.content, budget.toolResultMaxChars) };
    }
    return m;
  });

  const keep = Math.max(0, budget.keepRecentMessages);
  const minKeepStart = Math.max(0, normalized.length - keep);

  const selected: ChatMessage[] = [];
  let used = 0;
  let i = normalized.length - 1;
  let dropped = 0;

  for (; i >= 0; i--) {
    const msg = normalized[i]!;
    const cost = messageTokens(msg);
    const mustKeep = i >= minKeepStart;

    if (!mustKeep && used + cost > available) {
      // 跳过更旧的消息
      dropped++;
      continue;
    }
    selected.push(msg);
    used += cost;
  }

  selected.reverse();

  // 修正头部：若首条是 tool 消息而缺少对应的 assistant(tool_calls)，向后裁剪
  const fixed = dropDanglingTools(selected);

  return {
    messages: [{ role: "system", content: system }, ...fixed],
    dropped: dropped + (selected.length - fixed.length),
    tokens: systemTokens + used,
    trimmed: dropped > 0 || selected.length !== fixed.length,
  };
}

/**
 * 去掉开头没有对应 assistant(tool_calls) 的 tool 消息，
 * 以及其引用缺失的配对，避免 OpenAI 协议报错。
 */
function dropDanglingTools(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === "tool") {
      // 检查前面是否有声明该 tool_call_id 的 assistant 消息
      const hasOwner = out.some(
        (m) =>
          m.role === "assistant" &&
          m.tool_calls?.some((tc) => tc.id === msg.tool_call_id)
      );
      if (!hasOwner) continue;
    }
    out.push(msg);
  }
  return out;
}

/**
 * 生成历史摘要（用于更强的压缩场景）。
 * 采用轻量规则式摘要，不额外调用模型，避免成本与递归。
 */
export function summarizeHistory(messages: ChatMessage[]): string {
  const lines: string[] = [];
  const asText = (c: ChatMessage["content"]): string => {
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c.map((p) => (p.type === "text" ? p.text : "[图片]")).join(" ");
    }
    return "";
  };
  for (const m of messages) {
    if (m.role === "user") {
      const t = asText(m.content).replace(/\s+/g, " ").slice(0, 120);
      if (t) lines.push(`- 用户: ${t}`);
    } else if (m.role === "assistant" && m.content) {
      const t = asText(m.content).replace(/\s+/g, " ").slice(0, 120);
      if (t) lines.push(`- 助手: ${t}`);
    } else if (m.role === "assistant" && m.tool_calls?.length) {
      const names = m.tool_calls.map((tc) => tc.function.name).join(", ");
      lines.push(`- 助手调用了工具: ${names}`);
    }
  }
  return lines.slice(-20).join("\n");
}
