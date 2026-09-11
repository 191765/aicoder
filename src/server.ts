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

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res, config, sessions);
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
}

function checkToken(
  req: http.IncomingMessage,
  url: URL,
  expected: string
): boolean {
  if (!expected) return true;
  const header = req.headers["authorization"] ?? "";
  const bearer = typeof header === "string" && header.startsWith("Bearer ")
    ? header.slice(7)
    : "";
  return bearer === expected || url.searchParams.get("token") === expected;
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ReturnType<typeof loadConfig>,
  sessions: Map<string, Session>
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const { pathname } = url;

  if (pathname === "/api/health") {
    return json(res, 200, { ok: true, model: config.model });
  }

  if (pathname === "/api/chat" && req.method === "POST") {
    if (!checkToken(req, url, config.token)) {
      return json(res, 401, { error: "未授权：无效的 token" });
    }
    return handleChat(req, res, config, sessions);
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
  sessions: Map<string, Session>
): Promise<void> {
  const body = await readBody(req);
  let payload: {
    message?: string;
    sessionId?: string;
    useRag?: boolean;
    allowWrite?: boolean;
    approvedTools?: string[];
  } = {};
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return json(res, 400, { error: "请求体必须为 JSON" });
  }
  const message = (payload.message ?? "").trim();
  if (!message) return json(res, 400, { error: "缺少 message" });

  const approvedTools = new Set(payload.approvedTools ?? []);
  const allowWrite = payload.allowWrite !== false;

  const sessionId = payload.sessionId || Math.random().toString(36).slice(2);

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
          onConfirm: async (question) => {
            const name = question.match(/工具 (\S+)/)?.[1] ?? "";
            if (extraAllow.has(name)) return true;
            send({ type: "confirm", name, question });
            return false;
          },
        });
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
        for await (const ev of session.agent.chat(message)) {
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
