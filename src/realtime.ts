import type http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { Config } from "./config.js";
import { Agent, type AgentEvent } from "./agent.js";
import type { ContentPart } from "./types.js";

/**
 * WebSocket 实时交互
 *
 * 相比 SSE，支持双向通信：
 *  - 服务端流式推送对话事件
 *  - 工具需要确认时，服务端请求授权，客户端实时回应
 *  - 客户端可随时中断当前生成
 */

interface ClientState {
  agent?: Agent;
  controller?: AbortController;
  pendingConfirms: Map<string, (allow: boolean) => void>;
  confirmSeq: number;
}

interface IncomingMessage {
  type: string;
  sessionId?: string;
  message?: string;
  useRag?: boolean;
  allowWrite?: boolean;
  images?: Array<{ dataUrl?: string; url?: string }>;
  id?: string;
  allow?: boolean;
}

let wss: WebSocketServer | null = null;

export function attachRealtime(
  server: http.Server,
  config: Config,
  adminToken: string | undefined,
  authorize: (token: string | undefined) => boolean
): WebSocketServer {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/ws", `http://${req.headers.host}`);
    const token =
      url.searchParams.get("token") ??
      (req.headers.authorization?.toString().startsWith("Bearer ")
        ? req.headers.authorization.toString().slice(7)
        : undefined);
    void adminToken;
    if (!authorize(token ?? undefined)) {
      ws.send(JSON.stringify({ type: "error", message: "未授权" }));
      ws.close();
      return;
    }

    const state: ClientState = {
      pendingConfirms: new Map(),
      confirmSeq: 0,
    };

    ws.on("message", (data) => {
      let msg: IncomingMessage;
      try {
        msg = JSON.parse(data.toString()) as IncomingMessage;
      } catch {
        return;
      }
      handleMessage(ws, state, msg, config);
    });

    ws.on("close", () => {
      state.controller?.abort();
      for (const resolve of state.pendingConfirms.values()) resolve(false);
      state.pendingConfirms.clear();
    });
  });

  return wss;
}

function handleMessage(
  ws: WebSocket,
  state: ClientState,
  msg: IncomingMessage,
  config: Config
): void {
  if (msg.type === "confirm_result") {
    const resolve = msg.id ? state.pendingConfirms.get(msg.id) : undefined;
    if (resolve && msg.id) {
      state.pendingConfirms.delete(msg.id);
      resolve(Boolean(msg.allow));
    }
    return;
  }

  if (msg.type === "abort") {
    state.controller?.abort();
    ws.send(JSON.stringify({ type: "aborted" }));
    return;
  }

  if (msg.type === "chat") {
    void runChat(ws, state, msg, config);
    return;
  }
}

async function runChat(
  ws: WebSocket,
  state: ClientState,
  msg: IncomingMessage,
  config: Config
): Promise<void> {
  if (state.controller) state.controller.abort();
  const controller = new AbortController();
  state.controller = controller;

  const send = (obj: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  const sessionId = msg.sessionId || Math.random().toString(36).slice(2);
  send({ type: "session", sessionId });

  if (!state.agent) {
    state.agent = new Agent({
      config: { ...config, autoApprove: msg.allowWrite === true },
      useRag: Boolean(msg.useRag),
      sessionId,
      persist: true,
      onConfirm: (question) => {
        const name = question.match(/工具 (\S+)/)?.[1] ?? "";
        const id = `cf_${++state.confirmSeq}`;
        return new Promise<boolean>((resolve) => {
          state.pendingConfirms.set(id, resolve);
          send({ type: "confirm", id, name, question });
          // 超时自动拒绝
          setTimeout(() => {
            if (state.pendingConfirms.has(id)) {
              state.pendingConfirms.delete(id);
              resolve(false);
            }
          }, 120_000);
        });
      },
    });
  }

  const content = buildContent(msg.message ?? "", msg.images ?? []);

  try {
    for await (const ev of state.agent.chat(content, controller.signal)) {
      send(ev as AgentEvent);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    send({ type: "end" });
  }
}

function buildContent(
  message: string,
  images: Array<{ dataUrl?: string; url?: string }>
): string | ContentPart[] {
  const valid = images
    .map((i) => i.dataUrl || i.url || "")
    .filter((u) => u.startsWith("data:image") || u.startsWith("http"));
  if (!valid.length) return message;
  return [
    { type: "text", text: message },
    ...valid.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

export function closeRealtime(): void {
  wss?.close();
  wss = null;
}
