#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";
import { loadConfig } from "./config.js";
import { Agent } from "./agent.js";

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function printHelp(): void {
  console.log(`AICoder - 开源 AI 编程助手

用法:
  aicoder                    交互式终端对话
  aicoder --rag              启动时构建代码库索引
  aicoder --prompt="..."     单次提问后退出
  aicoder --resume           恢复最近会话
  aicoder --resume=<id>      恢复指定会话
  aicoder --session=<id>     使用指定会话 id
  aicoder --no-save          不持久化本次会话
  aicoder sessions           列出已保存会话
  aicoder web                启动网页版 (http://localhost:8787)
  aicoder rag                仅构建代码索引

交互命令:
  /exit  退出          /reset  清空上下文
  /rag   重建索引      /save   保存会话
  /sessions 会话列表   /new    新建会话
  /delete <id> 删除会话

扩展能力（在 .aicoder.json 中配置）:
  mcpServers  MCP 服务器          lspServers  LSP 语言服务器
内置工具: 文件/搜索/命令、task 子代理、git_*、lsp_*、mcp__*

配置见 .env（AICODER_API_KEY / AICODER_BASE_URL / AICODER_MODEL 等）`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === "web" || args[0] === "server") {
    const { startServer } = await import("./server.js");
    await startServer();
    return;
  }

  if (args[0] === "rag" || args[0] === "index") {
    const config = loadConfig();
    const { CodeIndex } = await import("./rag.js");
    process.stdout.write("正在构建代码索引...");
    const idx = new CodeIndex(config);
    const n = await idx.build();
    console.log(`\r索引完成：${n} 个片段 -> ${idx.indexPath}   `);
    return;
  }

  if (args[0] === "sessions" || args[0] === "list") {
    const { listSessions, sessionsDir } = await import("./session.js");
    const list = await listSessions();
    console.log(`${C.dim}会话目录: ${sessionsDir()}${C.reset}`);
    if (!list.length) {
      console.log("(暂无保存的会话)");
      return;
    }
    for (const s of list) {
      const when = new Date(s.updatedAt).toLocaleString();
      console.log(
        `${C.cyan}${s.id}${C.reset}  ${C.dim}${when}  ${s.messageCount} 条  ${s.model}${C.reset}\n  ${s.title}`
      );
    }
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const wantRag = args.includes("--rag") || args.includes("-r");
  const once = args.find((a) => a.startsWith("--prompt="))?.slice("--prompt=".length);
  const resumeArg = args.find((a) => a.startsWith("--resume"));
  const sessionArg = args.find((a) => a.startsWith("--session="))?.slice("--session=".length);
  const noPersist = args.includes("--no-save");
  const config = loadConfig();

  if (!config.apiKey && !config.baseURL.includes("localhost")) {
    console.error(
      `${C.yellow}提示：未检测到 AICODER_API_KEY。若使用本地 Ollama 可忽略。${C.reset}`
    );
  }

  console.log(`${C.bold}${C.cyan}AICoder${C.reset} ${C.dim}开源 AI 编程助手${C.reset}`);
  console.log(`${C.dim}模型: ${config.model}  工作目录: ${config.workdir}${C.reset}`);

  const { initExtensions, shutdownExtensions } = await import("./runtime.js");
  const ext = await initExtensions(config);
  if (ext.mcp.length) {
    for (const m of ext.mcp) {
      if (m.error) {
        console.log(`${C.yellow}MCP ${m.server}: 连接失败 ${m.error}${C.reset}`);
      } else {
        console.log(`${C.dim}MCP ${m.server}: 已加载 ${m.tools} 个工具${C.reset}`);
      }
    }
  }

  const { newSessionId, loadSession, listSessions, deleteSession } = await import("./session.js");

  let sessionId: string | undefined;
  let restored = false;
  if (sessionArg) {
    sessionId = sessionArg;
  } else if (resumeArg !== undefined) {
    // --resume 或 --resume=<id>
    const explicit = resumeArg.includes("=") ? resumeArg.split("=")[1] : "";
    if (explicit) {
      sessionId = explicit;
    } else {
      const list = await listSessions();
      const candidates = list.filter((s) => s.workdir === config.workdir);
      const pick = candidates[0] ?? list[0];
      if (pick) {
        sessionId = pick.id;
        console.log(`${C.dim}恢复最近会话: ${pick.id}  ${pick.title}${C.reset}`);
      } else {
        console.log(`${C.yellow}未找到可恢复的会话，将新建。${C.reset}`);
      }
    }
  }
  if (!sessionId && !noPersist) sessionId = newSessionId();

  const agent = new Agent({
    config,
    useRag: wantRag,
    onConfirm: confirmPrompt,
    sessionId,
    persist: !noPersist,
  });

  if (sessionId && (sessionArg || resumeArg !== undefined)) {
    const stored = await loadSession(sessionId);
    if (stored && stored.messages.length) {
      agent.loadHistory(stored.messages);
      restored = true;
      console.log(
        `${C.dim}已载入 ${stored.messages.length} 条历史（${stored.title}）${C.reset}`
      );
    }
  }

  if (wantRag) {
    process.stdout.write(`${C.dim}正在构建代码索引...${C.reset}`);
    const n = await agent.prepareRag();
    console.log(`\r${C.dim}代码索引就绪：${n} 个片段${C.reset}   `);
  }

  if (sessionId) {
    console.log(`${C.dim}会话: ${sessionId}${restored ? " (已恢复)" : ""}${C.reset}`);
  }
  console.log(`${C.dim}输入内容开始对话。命令: /exit 退出, /reset 清空上下文, /rag 重建索引, /save 保存, /sessions 列表${C.reset}\n`);

  if (once) {
    await runTurn(agent, once);
    shutdownExtensions();
    return;
  }

  const wantTui =
    args.includes("--tui") ||
    (config.ui?.rich === true && !args.includes("--no-tui"));

  if (wantTui) {
    const { runTui } = await import("./tui.js");
    const handleCommand = async (text: string): Promise<void> => {
      const [cmd, ...rest] = text.split(" ");
      if (cmd === "/rag") {
        const n = await agent.prepareRag();
        console.log(`${C.dim}索引完成：${n} 个片段${C.reset}`);
      } else if (cmd === "/sessions") {
        const list = await listSessions();
        for (const s of list.slice(0, 15)) {
          console.log(`${s.id}  ${s.messageCount} 条  ${s.model}  ${s.title}`);
        }
      } else if (cmd === "/delete") {
        const ok = await deleteSession(rest.join(" ").trim());
        console.log(ok ? "已删除" : "删除失败");
      } else if (cmd === "/new") {
        const id = newSessionId();
        agent.id = id;
        console.log(`已新建会话 ${id}`);
      }
    };
    runTui(agent, {
      theme: config.ui?.theme,
      sessionId: agent.id,
      model: config.model,
      workdir: config.workdir,
      onCommand: handleCommand,
    });
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question(`${C.green}${C.bold}你 >${C.reset} `, async (input) => {
      const text = input.trim();
      if (!text) return prompt();
      if (text === "/exit" || text === "/quit") {
        rl.close();
        return;
      }
      if (text === "/reset") {
        agent.reset();
        console.log(`${C.dim}上下文已清空${C.reset}\n`);
        return prompt();
      }
      if (text === "/rag") {
        process.stdout.write(`${C.dim}重建索引...${C.reset}`);
        const n = await agent.prepareRag();
        console.log(`\r${C.dim}索引完成：${n} 个片段${C.reset}   \n`);
        return prompt();
      }
      if (text === "/save") {
        await agent.save();
        console.log(`${C.dim}已保存会话 ${agent.id ?? "(无)"}${C.reset}\n`);
        return prompt();
      }
      if (text === "/sessions") {
        const list = await listSessions();
        if (!list.length) console.log(`${C.dim}(暂无保存的会话)${C.reset}`);
        for (const s of list.slice(0, 15)) {
          const mark = s.id === agent.id ? `${C.green}*${C.reset}` : " ";
          console.log(
            `${mark} ${C.cyan}${s.id}${C.reset}  ${C.dim}${s.messageCount} 条  ${s.model}${C.reset}  ${s.title}`
          );
        }
        console.log();
        return prompt();
      }
      if (text.startsWith("/delete ")) {
        const id = text.slice("/delete ".length).trim();
        const ok = await deleteSession(id);
        console.log(`${ok ? C.green + "已删除" : C.red + "删除失败"} ${id}${C.reset}\n`);
        return prompt();
      }
      if (text === "/new") {
        agent.reset();
        const id = newSessionId();
        agent.id = id;
        console.log(`${C.green}已新建会话 ${id}${C.reset}\n`);
        return prompt();
      }
      await runTurn(agent, text);
      console.log();
      prompt();
    });
  };
  prompt();

  rl.on("close", () => {
    console.log(`\n${C.dim}再见${C.reset}`);
    shutdownExtensions();
    process.exit(0);
  });
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  const controller = new AbortController();
  const onSig = (): void => controller.abort();
  process.once("SIGINT", onSig);

  let wroteText = false;
  const startAssistant = (): void => {
    if (!wroteText) {
      process.stdout.write(`${C.magenta}${C.bold}AI >${C.reset} `);
      wroteText = true;
    }
  };

  try {
    for await (const ev of agent.chat(text, controller.signal)) {
      switch (ev.type) {
        case "text":
          startAssistant();
          process.stdout.write(ev.delta);
          break;
        case "tool_start":
          if (wroteText) process.stdout.write("\n");
          wroteText = false;
          console.log(`${C.dim}${C.yellow}⚙ 调用工具 ${ev.name}${C.reset}`);
          break;
        case "tool_end":
          console.log(
            `${C.dim}${ev.ok ? C.green : C.red}${ev.ok ? "✓" : "✗"} ${ev.name} 完成${C.reset}`
          );
          wroteText = false;
          break;
        case "tool_denied":
          if (wroteText) process.stdout.write("\n");
          wroteText = false;
          console.log(`${C.red}⛔ ${ev.name} 被拒绝：${ev.reason}${C.reset}`);
          break;
        case "context":
          console.log(
            `${C.dim}… 上下文已压缩（约 ${ev.tokens} tokens，省略 ${ev.dropped} 条）${C.reset}`
          );
          break;
        case "error":
          console.error(`\n${C.red}错误: ${ev.message}${C.reset}`);
          break;
        default:
          break;
      }
    }
  } catch (err) {
    console.error(`\n${C.red}运行失败: ${err instanceof Error ? err.message : err}${C.reset}`);
  }
  process.removeListener("SIGINT", onSig);
  if (wroteText) process.stdout.write("\n");
}

function confirmPrompt(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${C.yellow}${question} [y/N] ${C.reset}`, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
