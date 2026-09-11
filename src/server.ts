import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "..", "web");

interface Session {
  agent: Agent;
  extraAllow: Set<string>;
}

async function main(): Promise<void> {
  await startServer();
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  // 网页端强制启用访问令牌：未配置时自动生成一个，保证写操作始终受保护
  if (!config.token) {
    config.token = crypto.randomBytes(16).toString("hex");
    config.tokenGenerated = true;
  }
  const sessions = new Map<string, Session>();
  const { createUserRegistry } = await import("./users.js");
  const users = createUserRegistry(config);

  const { initExtensions } = await import("./runtime.js");
  try {
    const ext = await initExtensions(config);
    for (const m of ext.mcp) {
      if (m.error) console.log(`MCP ${m.server}: 连接失败 ${m.error}`);
      else console.log(`MCP ${m.server}: 已加载 ${m.tools} 个工具`);
    }
  } catch (err) {
    console.error("扩展初始化失败:", err instanceof Error ? err.message : err);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, config, sessions, users);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`服务器错误: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  server.listen(config.port, () => {
    console.log(`AICoder Web 已启动: http://localhost:${config.port}`);
    console.log(`模型: ${config.model}  工作目录: ${config.workdir}`);
    console.log(`访问令牌: ${config.token}`);
    console.log(`打开: http://localhost:${config.port}/?token=${config.token}`);
    if (config.tokenGenerated) {
      console.log("（未设置 AICODER_TOKEN，已自动生成临时令牌；可在 .env 中固定）");
    }
  });

  // WebSocket 实时通道
  try {
    const { attachRealtime } = await import("./realtime.js");
    attachRealtime(
      server,
      config,
      config.token,
      (token) => Boolean(users.identify(token, config.token || undefined)) || !config.token
    );
  } catch (err) {
    console.error("实时通道启动失败:", err instanceof Error ? err.message : err);
  }
}

type UserRegistry = Awaited<ReturnType<typeof import("./users.js").createUserRegistry>>;

function extractToken(req: http.IncomingMessage, url: URL): string {
  const header = req.headers["authorization"] ?? "";
  const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  return bearer || url.searchParams.get("token") || "";
}

/** 将文本与图片组装成多模态内容 */
function buildUserContent(
  message: string,
  images: Array<{ dataUrl?: string; url?: string }>
):
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> {
  const valid = images
    .map((i) => i.dataUrl || i.url || "")
    .filter((u) => u.startsWith("data:image") || u.startsWith("http"));
  if (!valid.length) return message;
  return [
    { type: "text" as const, text: message },
    ...valid.map((url) => ({ type: "image_url" as const, image_url: { url } })),
  ];
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ReturnType<typeof loadConfig>,
  sessions: Map<string, Session>,
  users: UserRegistry
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const { pathname } = url;

  const token = extractToken(req, url);
  const user = users.identify(token, config.token || undefined);
  const authorized = Boolean(user) || !config.token;

  if (pathname === "/api/health") {
    return json(res, 200, { ok: true, model: config.model });
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    if (!authorized) {
      return json(res, 401, { error: "未授权：无效的 token" });
    }
    return handleChat(req, res, config, sessions, user, users);
  }

  // ---- 会话 API ----
  if (pathname === "/api/sessions" && req.method === "GET") {
    if (!authorized) {
      return json(res, 401, { error: "未授权" });
    }
    const { listSessions } = await import("./session.js");
    const all = await listSessions();
    const prefix = user && !user.isAdmin ? `${user.name}__` : "";
    const scoped = user && !user.isAdmin ? all.filter((s) => s.id.startsWith(prefix)) : all;
    return json(res, 200, { sessions: scoped });
  }

  if (pathname === "/api/sessions" && req.method === "DELETE") {
    if (!authorized) {
      return json(res, 401, { error: "未授权" });
    }
    const id = url.searchParams.get("id") ?? "";
    if (user && !user.isAdmin && !id.startsWith(`${user.name}__`)) {
      return json(res, 403, { error: "无权删除该会话" });
    }
    const { deleteSession } = await import("./session.js");
    const ok = id ? await deleteSession(id) : false;
    return json(res, 200, { ok });
  }

  if (pathname.startsWith("/api/sessions/") && req.method === "GET") {
    if (!authorized) {
      return json(res, 401, { error: "未授权" });
    }
    const id = decodeURIComponent(pathname.slice("/api/sessions/".length));
    if (user && !user.isAdmin && !id.startsWith(`${user.name}__`)) {
      return json(res, 403, { error: "无权访问该会话" });
    }
    const { loadSession } = await import("./session.js");
    const s = await loadSession(id);
    if (!s) return json(res, 404, { error: "会话不存在" });
    return json(res, 200, { session: s });
  }

  if (pathname === "/api/usage" && req.method === "GET") {
    if (!authorized) {
      return json(res, 401, { error: "未授权" });
    }
    const obs = await import("./observability.js");
    return json(res, 200, obs.getUsage());
  }

  if (pathname === "/api/metrics" && req.method === "GET") {
    if (!authorized) {
      return json(res, 401, { error: "未授权" });
    }
    const obs = await import("./observability.js");
    const metrics = obs.getMetrics();
    return json(res, 200, { ...metrics, users: user?.isAdmin ? users.listUsers() : undefined });
  }

  if (pathname === "/dashboard" && req.method === "GET") {
    return serveStatic("dashboard.html", res);
  }

  if (pathname === "/api/run" && req.method === "POST") {
    if (!authorized) {
      return json(res, 401, { error: "未授权" });
    }
    if (user?.quotaUsd !== undefined && users.spent(user.name) >= user.quotaUsd) {
      return json(res, 429, { error: "配额已用尽" });
    }
    return handleRun(req, res, config);
  }

  // 静态文件
  if (req.method === "GET") {
    return serveStatic(pathname, res);
  }

  json(res, 404, { error: "Not found" });
}

function json(res: http.ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { "Content-Type": mime(file) });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
  }
}

function mime(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };
  return map[ext] ?? "application/octet-stream";
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ReturnType<typeof loadConfig>,
  sessions: Map<string, Session>,
  user: Awaited<ReturnType<UserRegistry["identify"]>>,
  users: UserRegistry
): Promise<void> {
  const body = await readBody(req);
  let payload: {
    message?: string;
    sessionId?: string;
    useRag?: boolean;
    allowWrite?: boolean;
    approvedTools?: string[];
    images?: Array<{ dataUrl?: string; url?: string }>;
  } = {};
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return json(res, 400, { error: "请求体必须为 JSON" });
  }
  const message = (payload.message ?? "").trim();
  if (!message) return json(res, 400, { error: "缺少 message" });

  // 配额检查
  if (user?.quotaUsd !== undefined && users.spent(user.name) >= user.quotaUsd) {
    return json(res, 429, {
      error: `配额已用尽（$${users.spent(user.name).toFixed(4)} / $${user.quotaUsd}）`,
    });
  }

  const approvedTools = new Set(payload.approvedTools ?? []);
  // 用户是否允许写操作：全局开关 + 用户配置
  const requestAllowWrite = payload.allowWrite !== false;
  const allowWrite = requestAllowWrite && (user?.allowWrite ?? true);

  // 会话按用户隔离
  const rawId = payload.sessionId || Math.random().toString(36).slice(2);
  const sessionId = user && !user.isAdmin ? `${user.name}__${rawId}` : rawId;

  // 工具白名单 -> 排除不在白名单内的工具
  let excludeTools: Set<string> | undefined;
  if (user?.allowedTools && user.allowedTools.length) {
    const { tools: allTools } = await import("./tools.js");
    const allowed = new Set(allTools.map((t) => t.name).filter((n) => users.toolAllowed(user, n)));
    excludeTools = new Set(allTools.map((t) => t.name).filter((n) => !allowed.has(n)));
  }

  return new Promise<void>((resolve) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    send({ type: "session", sessionId });

    void (async () => {
      let session = sessions.get(sessionId);
      if (!session) {
        const extraAllow = new Set<string>(approvedTools);
        const agent = new Agent({
          // allowWrite 表示本会话批准写操作（ask -> allow）；deny 规则始终优先
          config: { ...config, autoApprove: allowWrite },
          useRag: Boolean(payload.useRag),
          extraAllow,
          sessionId,
          persist: true,
          excludeTools,
          onConfirm: async (question) => {
            const name = question.match(/工具 (\S+)/)?.[1] ?? "";
            if (extraAllow.has(name)) return true;
            send({ type: "confirm", name, question });
            return false;
          },
        });
        // 恢复已存会话历史（不计入本次流式输出，避免打断当前回复）
        try {
          const { loadSession } = await import("./session.js");
          const stored = await loadSession(sessionId);
          if (stored?.messages?.length) {
            agent.loadHistory(stored.messages);
          }
        } catch {
          /* 忽略 */
        }
        if (payload.useRag) {
          try {
            await agent.prepareRag();
          } catch (err) {
            send({
              type: "error",
              message: `索引构建失败: ${err instanceof Error ? err.message : err}`,
            });
          }
        }
        session = { agent, extraAllow };
        sessions.set(sessionId, session);
      } else {
        for (const t of approvedTools) {
          session.extraAllow.add(t);
          session.agent.allowTool(t);
        }
      }

      req.on("close", () => {
        // 客户端断开，SSE 结束
      });

      try {
        const content = buildUserContent(message, payload.images ?? []);
        for await (const ev of session.agent.chat(content)) {
          send(ev);
          if (ev.type === "done" || ev.type === "error") {
            if (ev.type === "done") {
              send({ type: "end" });
              break;
            }
          }
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        send({ type: "end" });
        res.end();
        resolve();
      }
    })();
  });
}

/**
 * 可编程 API：一次性执行任务，返回最终文本与统计（不流式、不建会话）。
 * 供其它程序以 HTTP 调用。
 */
async function handleRun(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  let payload: {
    message?: string;
    useRag?: boolean;
    allowWrite?: boolean;
  } = {};
  try {
    payload = JSON.parse(await readBody(req)) as typeof payload;
  } catch {
    return json(res, 400, { error: "请求体必须为 JSON" });
  }
  const message = (payload.message ?? "").trim();
  if (!message) return json(res, 400, { error: "缺少 message" });

  const { Agent } = await import("./agent.js");
  const agent = new Agent({
    config: { ...config, autoApprove: payload.allowWrite === true },
    useRag: Boolean(payload.useRag),
    persist: false,
    quiet: true,
  });

  const toolCalls: string[] = [];
  let text = "";
  let steps = 0;
  try {
    for await (const ev of agent.chat(message)) {
      if (ev.type === "text") text += ev.delta;
      else if (ev.type === "tool_end") toolCalls.push(ev.name);
      else if (ev.type === "step") steps = ev.index;
      else if (ev.type === "error") {
        return json(res, 200, { ok: false, error: ev.message, text, toolCalls, steps });
      }
    }
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  json(res, 200, { ok: true, text, toolCalls, steps });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
