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
  aicoder web                启动网页版 (http://localhost:8787)
  aicoder rag                仅构建代码索引

交互命令:
  /exit  退出          /reset  清空上下文
  /rag   重建索引

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

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const wantRag = args.includes("--rag") || args.includes("-r");
  const once = args.find((a) => a.startsWith("--prompt="))?.slice("--prompt=".length);
  const config = loadConfig();

  if (!config.apiKey && !config.baseURL.includes("localhost")) {
    console.error(
      `${C.yellow}提示：未检测到 AICODER_API_KEY。若使用本地 Ollama 可忽略。${C.reset}`
    );
  }

  console.log(`${C.bold}${C.cyan}AICoder${C.reset} ${C.dim}开源 AI 编程助手${C.reset}`);
  console.log(`${C.dim}模型: ${config.model}  工作目录: ${config.workdir}${C.reset}`);

  const agent = new Agent({
    config,
    useRag: wantRag,
    onConfirm: confirmPrompt,
  });

  if (wantRag) {
    process.stdout.write(`${C.dim}正在构建代码索引...${C.reset}`);
    const n = await agent.prepareRag();
    console.log(`\r${C.dim}代码索引就绪：${n} 个片段${C.reset}   `);
  }

  console.log(`${C.dim}输入内容开始对话。命令: /exit 退出, /reset 清空上下文, /rag 重建索引${C.reset}\n`);

  if (once) {
    await runTurn(agent, once);
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
      await runTurn(agent, text);
      console.log();
      prompt();
    });
  };
  prompt();

  rl.on("close", () => {
    console.log(`\n${C.dim}再见${C.reset}`);
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
