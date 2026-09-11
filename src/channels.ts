/**
 * 多渠道接入
 *
 * 提供通用 webhook 解析与回复格式化，支持 Slack / 飞书 / 钉钉 / 通用 JSON。
 */

export type Channel = "slack" | "feishu" | "dingtalk" | "generic";

export interface IncomingMessage {
  channel: Channel;
  text: string;
  user?: string;
  /** 回复回调地址（如 Slack response_url） */
  responseUrl?: string;
}

/** 从请求头/体推断渠道 */
export function detectChannel(
  headers: Record<string, string | string[] | undefined>,
  body: Record<string, unknown>
): Channel {
  const ua = String(headers["user-agent"] ?? "");
  if (ua.includes("Slack") || body.type === "event_callback") return "slack";
  if (ua.includes("Feishu") || body.header) return "feishu";
  if (ua.includes("DingTalk") || body.msgtype) return "dingtalk";
  return "generic";
}

/** 解析各渠道的入站消息 */
export function parseIncoming(
  channel: Channel,
  body: Record<string, unknown>
): IncomingMessage | null {
  switch (channel) {
    case "slack": {
      const event = (body.event ?? {}) as Record<string, unknown>;
      const text = typeof event.text === "string" ? event.text : "";
      if (!text) return null;
      return {
        channel,
        text,
        user: typeof event.user === "string" ? event.user : undefined,
      };
    }
    case "feishu": {
      const event = (body.event ?? {}) as Record<string, unknown>;
      const msg = (event.message ?? {}) as Record<string, unknown>;
      let text = "";
      if (typeof msg.content === "string") {
        try {
          text = (JSON.parse(msg.content) as { text?: string }).text ?? "";
        } catch {
          text = msg.content;
        }
      }
      if (!text) return null;
      return { channel, text };
    }
    case "dingtalk": {
      const textObj = (body.text ?? {}) as Record<string, unknown>;
      const text = typeof textObj.content === "string" ? textObj.content : "";
      if (!text) return null;
      return {
        channel,
        text,
        user: typeof body.senderNick === "string" ? body.senderNick : undefined,
      };
    }
    default: {
      const text =
        typeof body.text === "string"
          ? body.text
          : typeof body.message === "string"
            ? body.message
            : "";
      if (!text) return null;
      return {
        channel: "generic",
        text,
        user: typeof body.user === "string" ? body.user : undefined,
      };
    }
  }
}

/** 将回复格式化为各渠道响应体 */
export function formatReply(channel: Channel, text: string): Record<string, unknown> {
  switch (channel) {
    case "slack":
      return { response_type: "in_channel", text };
    case "feishu":
      return { msg_type: "text", content: JSON.stringify({ text }) };
    case "dingtalk":
      return { msgtype: "text", text: { content: text } };
    default:
      return { text };
  }
}
