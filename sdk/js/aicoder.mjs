/**
 * AICoder JavaScript/TypeScript SDK（零依赖，Node 18+ / 浏览器）
 *
 * 用法:
 *   import { AICoder } from "./sdk/js/aicoder.mjs";
 *   const client = new AICoder("http://localhost:8787", "your-token");
 *   const result = await client.run("统计 src 下的文件数");
 */

export class AICoder {
  constructor(baseURL = "http://localhost:8787", token = "") {
    this.baseURL = baseURL.replace(/\/$/, "");
    this.token = token;
  }

  headers() {
    const h = { "Content-Type": "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async health() {
    const res = await fetch(`${this.baseURL}/api/health`, { headers: this.headers() });
    return res.json();
  }

  async run(message, { useRag = false, allowWrite = false } = {}) {
    const res = await fetch(`${this.baseURL}/api/run`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ message, useRag, allowWrite }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }

  /**
   * 流式对话（SSE）。onEvent 回调接收服务端事件对象。
   * 返回一个可调用以中断的函数。
   */
  async chat(message, onEvent, { sessionId, useRag = false, allowWrite = false } = {}) {
    const controller = new AbortController();
    const res = await fetch(`${this.baseURL}/api/chat`, {
      method: "POST",
      headers: this.headers(),
      signal: controller.signal,
      body: JSON.stringify({ message, sessionId, useRag, allowWrite }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith("data:")) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()));
        } catch {
          /* 忽略 */
        }
      }
    }
    return () => controller.abort();
  }
}
