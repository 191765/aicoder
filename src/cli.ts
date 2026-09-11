#!/usr/bin/env node
import readline from "node:readline";
import process from "node:process";
import { loadConfig } from "./config.js";
import type { Agent } from "./agent.js";

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
  aicoder init               交互式生成配置文件
  aicoder run <name> [args]  运行工作流（review/test/refactor/bugfix/docs/explain）
  aicoder workflows          列出可用工作流
  aicoder snapshots          列出编辑快照
  aicoder rollback <id>      回滚到指定快照
  aicoder doctor             环境自检（模型/依赖/本地服务）
  aicoder plugin search [q]  搜索/安装/卸载插件
  aicoder eval [--baseline]  运行评估基准并检测回归
  aicoder feedback [export]  查看反馈 / 导出微调数据
  aicoder upgrade            检查并升级到最新版本
  aicoder telemetry          查看匿名遥测状态
  aicoder web                启动网页版 (http://localhost:8787)
  aicoder rag                仅构建代码索引

交互命令:
  /exit  退出          /reset  清空上下文
  /rag   重建索引      /save   保存会话
  /sessions 会话列表   /new    新建会话
  /delete <id> 删除会话

扩展能力（在 .aicoder.json 中配置）:
  mcpServers  MCP 服务器          lspServers  LSP 语言服务器
内置工具: 文件/搜索/命令、task 子代理、git_*、lsp_*、symbols、multi_edit、mcp__*
网页 API: POST /api/chat (SSE)、POST /api/run (一次性)、/ws (WebSocket)、/api/metrics

配置见 .env（AICODER_API_KEY / AICODER_BASE_URL / AICODER_MODEL 等）`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    try {
      const pkgPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "package.json"
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      console.log(pkg.version ?? "unknown");
    } catch {
      console.log("unknown");
    }
    return;
  }

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

  if (args[0] === "init") {
    await runInit();
    return;
  }

  if (args[0] === "workflows" || args[0] === "flows") {
    const { loadWorkflows } = await import("./workflows.js");
    const config = loadConfig();
    const list = await loadWorkflows(config);
    console.log(`${C.bold}可用工作流:${C.reset}`);
    for (const w of list) {
      const src = w.source === "user" ? `${C.dim}(自定义)${C.reset}` : "";
      console.log(`  ${C.cyan}${w.name}${C.reset}  ${w.description} ${src}`);
    }
    console.log(`\n${C.dim}用法: aicoder run <name> [args]${C.reset}`);
    return;
  }

  if (args[0] === "doctor") {
    await runDoctor();
    return;
  }

  if (args[0] === "telemetry") {
    const { telemetryEnabled, telemetrySample } = await import("./telemetry.js");
    const config = loadConfig();
    void config;
    console.log(
      `匿名遥测: ${telemetryEnabled() ? C.green + "已开启" : C.dim + "已关闭"}${C.reset}`
    );
    console.log(
      `${C.dim}默认关闭。开启: AICODER_TELEMETRY=1 或配置 telemetry.enabled=true${C.reset}`
    );
    console.log(`${C.dim}将发送的数据示例:${C.reset}`);
    console.log(JSON.stringify(telemetrySample(), null, 2));
    return;
  }

  if (args[0] === "upgrade" || args[0] === "update") {
    const { checkUpgrade, runGlobalInstall } = await import("./upgrade.js");
    const c = await checkUpgrade();
    console.log(`${C.dim}当前版本: ${c.current}${C.reset}`);
    if (c.latest === null) {
      console.log(`${C.yellow}无法查询最新版本（网络或 npm registry 不可达）${C.reset}`);
      return;
    }
    if (!c.updateAvailable) {
      console.log(`${C.green}已是最新版本 (${c.latest})${C.reset}`);
      return;
    }
    console.log(`${C.cyan}发现新版本: ${c.latest}${C.reset}`);
    const r = await runGlobalInstall();
    console.log(
      r.code === 0
        ? `${C.green}升级完成${C.reset}\n${r.out}`
        : `${C.red}升级失败${C.reset}\n${r.out}`
    );
    return;
  }

  if (args[0] === "plugin" || args[0] === "plugins") {
    await runPlugin(args.slice(1));
    return;
  }

  if (args[0] === "eval") {
    await runEval(args.slice(1));
    return;
  }

  if (args[0] === "feedback") {
    await runFeedback(args.slice(1));
    return;
  }

  if (args[0] === "snapshots" || args[0] === "snaps") {
    const { listSnapshots } = await import("./snapshots.js");
    const list = await listSnapshots(process.cwd());
    if (!list.length) {
      console.log("(暂无快照)");
      return;
    }
    for (const s of list) {
      console.log(
        `${C.cyan}${s.id}${C.reset}  ${C.dim}${new Date(s.ts).toLocaleString()}  ${s.reason}${C.reset}`
      );
      console.log(`  ${s.files.map((f) => f.path).join(", ")}`);
    }
    return;
  }

  if (args[0] === "rollback") {
    const { restoreSnapshot } = await import("./snapshots.js");
    const id = args[1];
    if (!id) {
      console.error(`${C.red}用法: aicoder rollback <snapshot-id>${C.reset}`);
      process.exit(1);
    }
    try {
      const r = await restoreSnapshot(process.cwd(), id);
      console.log(
        `${C.green}已回滚 ${id}：恢复 ${r.restored} 个文件，删除 ${r.removed} 个${C.reset}`
      );
    } catch (err) {
      console.error(`${C.red}${err instanceof Error ? err.message : err}${C.reset}`);
      process.exit(1);
    }
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
  let once = args.find((a) => a.startsWith("--prompt="))?.slice("--prompt=".length);
  const resumeArg = args.find((a) => a.startsWith("--resume"));
  const sessionArg = args.find((a) => a.startsWith("--session="))?.slice("--session=".length);
  const noPersist = args.includes("--no-save");
  const config = loadConfig();

  // 工作流：aicoder run <name> [args]
  if (args[0] === "run") {
    const { loadWorkflows, getWorkflow, renderWorkflow } = await import("./workflows.js");
    const name = args[1] ?? "";
    const list = await loadWorkflows(config);
    const wf = getWorkflow(list, name);
    if (!wf) {
      console.error(
        `${C.red}未知工作流: ${name || "(空)"}${C.reset}\n可用: ${list.map((w) => w.name).join(", ")}`
      );
      process.exit(1);
    }
    once = renderWorkflow(wf, args.slice(2).join(" "), config.workdir);
    console.log(`${C.dim}运行工作流 ${wf.name}: ${wf.description}${C.reset}`);
  }

  if (!config.apiKey && !config.baseURL.includes("localhost")) {
    console.error(
      `${C.yellow}提示：未检测到 AICODER_API_KEY。若使用本地 Ollama 可忽略。${C.reset}`
    );
  }

  console.log(`${C.bold}${C.cyan}AICoder${C.reset} ${C.dim}开源 AI 编程助手${C.reset}`);
  console.log(`${C.dim}模型: ${config.model}  工作目录: ${config.workdir}${C.reset}`);
  for (const m of config.configMigrations ?? []) {
    console.log(`${C.yellow}配置迁移: ${m}${C.reset}`);
  }
  for (const issue of config.configIssues ?? []) {
    const color = issue.severity === "error" ? C.red : C.yellow;
    console.log(
      `${color}配置${issue.severity === "error" ? "错误" : "警告"}: ${issue.path} - ${issue.message}${C.reset}`
    );
  }

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
  if (ext.plugins.length) {
    for (const p of ext.plugins) {
      if (p.error) {
        console.log(`${C.yellow}插件 ${p.name}: 加载失败 ${p.error}${C.reset}`);
      } else {
        console.log(
          `${C.dim}插件 ${p.name}: ${p.tools.length} 工具, ${p.commands.length} 命令${C.reset}`
        );
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

  const { Agent: AgentClass } = await import("./agent.js");
  const agent = new AgentClass({
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
      console.log(`${C.dim}已载入 ${stored.messages.length} 条历史（${stored.title}）${C.reset}`);
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
  console.log(
    `${C.dim}输入内容开始对话。命令: /exit 退出, /reset 清空上下文, /rag 重建索引, /save 保存, /sessions 列表${C.reset}\n`
  );

  if (once) {
    await runTurn(agent, once);
    shutdownExtensions();
    return;
  }

  const wantTui =
    args.includes("--tui") || (config.ui?.rich === true && !args.includes("--no-tui"));

  if (wantTui) {
    const { runTui } = await import("./tui.js");
    const handleCommand = async (text: string): Promise<void> => {
      const [cmd = "", ...rest] = text.split(" ");
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
      } else {
        const { findPluginCommand } = await import("./plugins.js");
        const found = findPluginCommand(cmd);
        if (found) {
          await found.command.run({
            args: rest,
            workdir: config.workdir,
            print: (t) => console.log(t),
          });
        }
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
      if (text.startsWith("/")) {
        const { findPluginCommand } = await import("./plugins.js");
        const [cmd = "", ...rest] = text.split(" ");
        const found = findPluginCommand(cmd);
        if (found) {
          await found.command.run({
            args: rest,
            workdir: config.workdir,
            print: (t) => console.log(t),
          });
          console.log();
          return prompt();
        }
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

/** 反馈与微调数据命令 */
async function runFeedback(sub: string[]): Promise<void> {
  const { readFeedback, exportTrainingData } = await import("./feedback.js");
  const config = loadConfig();
  const mode = sub[0];

  if (mode === "export") {
    const format = sub[1] === "dpo" ? "dpo" : "sft";
    const r = await exportTrainingData(config.workdir, format);
    console.log(
      `${C.green}已导出 ${r.count} 条 ${format.toUpperCase()} 数据到 ${r.file}${C.reset}`
    );
    return;
  }

  const entries = await readFeedback(config.workdir);
  const up = entries.filter((e) => e.rating > 0).length;
  const down = entries.filter((e) => e.rating < 0).length;
  const neutral = entries.filter((e) => e.rating === 0).length;
  console.log(
    `${C.bold}反馈统计:${C.reset} 共 ${entries.length} 条  ${C.green}赞 ${up}${C.reset}  ${C.red}踩 ${down}${C.reset}  中 ${neutral}`
  );
  console.log(`${C.dim}导出微调数据: aicoder feedback export [sft|dpo]${C.reset}`);
  for (const e of entries.slice(-5)) {
    const mark = e.rating > 0 ? "👍" : e.rating < 0 ? "👎" : "•";
    console.log(`  ${mark} ${new Date(e.ts).toLocaleString()}  ${e.comment ?? ""}`);
  }
}

/** 评估基准命令 */
async function runEval(sub: string[]): Promise<void> {
  const { runEvals, saveBaseline, loadBaseline, compareWithBaseline } = await import("./eval.js");
  const config = loadConfig();
  const setBaseline = sub.includes("--baseline") || sub.includes("--save-baseline");

  console.log(`${C.bold}${C.cyan}AICoder 评估基准${C.reset}`);
  const report = await runEvals(config, (name, i, total) => {
    process.stdout.write(`\r${C.dim}[${i}/${total}] ${name}...${C.reset}          `);
  });
  process.stdout.write("\r\x1b[J");

  for (const r of report.results) {
    const mark = r.passed ? `${C.green}✓` : `${C.red}✗`;
    console.log(
      `${mark}${C.reset} ${r.name}  ${C.dim}score ${r.score.toFixed(2)}  ${r.durationMs}ms${C.reset}`
    );
    for (const d of r.details) {
      if (!d.ok) console.log(`    ${C.red}${d.message}${C.reset}`);
    }
  }
  console.log(
    `\n${C.bold}通过 ${report.passed}/${report.total}，平均分 ${report.score.toFixed(2)}${C.reset}`
  );

  if (setBaseline) {
    await saveBaseline(config, report);
    console.log(`${C.green}已保存为基线${C.reset}`);
    return;
  }

  const baseline = await loadBaseline(config);
  if (baseline) {
    const cmp = compareWithBaseline(report, baseline);
    if (cmp.regressions.length) {
      console.log(`${C.red}检测到回归:${C.reset}`);
      for (const r of cmp.regressions) console.log(`  ${C.red}↓${C.reset} ${r}`);
    }
    if (cmp.improvements.length) {
      console.log(`${C.green}改进:${C.reset}`);
      for (const r of cmp.improvements) console.log(`  ${C.green}↑${C.reset} ${r}`);
    }
    if (!cmp.regressions.length && !cmp.improvements.length) {
      console.log(`${C.dim}与基线一致${C.reset}`);
    }
  } else {
    console.log(`${C.dim}（用 --baseline 保存当前结果为基线）${C.reset}`);
  }
}

/** 插件市场命令 */
async function runPlugin(sub: string[]): Promise<void> {
  const { searchPlugins, installPlugin, uninstallPlugin } = await import("./marketplace.js");
  const config = loadConfig();
  const cmd = sub[0] ?? "list";

  if (cmd === "search" || cmd === "find") {
    const query = sub.slice(1).join(" ");
    process.stdout.write(`${C.dim}搜索插件: ${query || "(全部)"}...${C.reset}\n`);
    try {
      const results = await searchPlugins(query);
      if (!results.length) {
        console.log("(未找到插件)");
        return;
      }
      for (const p of results) {
        console.log(
          `${C.cyan}${p.name}${C.reset}@${p.version}  ${C.dim}${p.author ?? ""}${C.reset}`
        );
        console.log(`  ${p.description}`);
      }
    } catch (err) {
      console.error(`${C.red}${err instanceof Error ? err.message : err}${C.reset}`);
    }
    return;
  }

  if (cmd === "list" || cmd === "ls") {
    console.log(`${C.bold}已配置插件:${C.reset}`);
    if (!config.plugins.length) {
      console.log("  (无)");
      return;
    }
    for (const p of config.plugins) console.log(`  ${C.cyan}${p}${C.reset}`);
    return;
  }

  if (cmd === "install" || cmd === "add") {
    const pkg = sub[1];
    if (!pkg) {
      console.error(`${C.red}用法: aicoder plugin install <包名>${C.reset}`);
      process.exit(1);
    }
    process.stdout.write(`${C.dim}安装 ${pkg}...${C.reset}\n`);
    const r = await installPlugin(config, pkg);
    if (r.ok) {
      console.log(`${C.green}已安装并写入配置: ${r.configPath}${C.reset}`);
    } else {
      console.error(`${C.red}安装失败:\n${r.output}${C.reset}`);
      process.exit(1);
    }
    return;
  }

  if (cmd === "uninstall" || cmd === "remove" || cmd === "rm") {
    const pkg = sub[1];
    if (!pkg) {
      console.error(`${C.red}用法: aicoder plugin uninstall <包名>${C.reset}`);
      process.exit(1);
    }
    const r = await uninstallPlugin(config, pkg);
    console.log(
      r.ok ? `${C.green}已卸载 ${pkg}${C.reset}` : `${C.red}卸载失败:\n${r.output}${C.reset}`
    );
    return;
  }

  console.error(`${C.yellow}用法: aicoder plugin <search|list|install|uninstall> [包名]${C.reset}`);
}

/** 环境自检 */
async function runDoctor(): Promise<void> {
  const { discoverLocalModels, isLocalConfig, localModelHint } = await import("./local-models.js");
  const config = loadConfig();
  console.log(`${C.bold}${C.cyan}AICoder 环境自检${C.reset}\n`);

  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(
      `${ok ? C.green + "✓" : C.red + "✗"}${C.reset} ${label}  ${C.dim}${detail}${C.reset}`
    );
  };

  check("Node.js", Number(process.versions.node.split(".")[0]) >= 18, process.versions.node);
  check(
    "模型配置",
    Boolean(config.model),
    `${config.model} @ ${config.baseURL}${isLocalConfig(config) ? " (本地)" : ""}`
  );
  check(
    "API Key",
    Boolean(config.apiKey) || isLocalConfig(config),
    config.apiKey ? "已设置" : isLocalConfig(config) ? "本地服务可忽略" : "未设置"
  );
  check("工作目录", true, config.workdir);
  if (config.configSources.length) {
    console.log(`${C.dim}配置来源: ${config.configSources.join(", ")}${C.reset}`);
  }
  if (config.configIssues.length) {
    for (const i of config.configIssues) {
      console.log(
        `${i.severity === "error" ? C.red : C.yellow}  ${i.path}: ${i.message}${C.reset}`
      );
    }
  }

  // git
  const { spawnSync } = await import("node:child_process");
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  check("git", git.status === 0, (git.stdout || "").trim() || "未安装");
  const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
  check("gh CLI", gh.status === 0, (gh.stdout || "").split("\n")[0] || "未安装（GitHub 功能受限）");

  // 本地模型
  console.log(`\n${C.bold}本地模型探测:${C.reset}`);
  const locals = await discoverLocalModels();
  let anyLocal = false;
  for (const l of locals) {
    if (l.reachable) {
      anyLocal = true;
      console.log(
        `  ${C.green}✓${C.reset} ${l.endpoint}: ${l.models.length ? l.models.slice(0, 8).join(", ") : "(无模型)"}`
      );
    } else {
      console.log(`  ${C.dim}✗ ${l.endpoint}: 不可达${C.reset}`);
    }
  }
  if (!anyLocal && !isLocalConfig(config)) {
    console.log(`\n${C.dim}${localModelHint()}${C.reset}`);
  }

  // MCP / LSP / 插件
  console.log(`\n${C.bold}扩展:${C.reset}`);
  console.log(`  MCP 服务器: ${Object.keys(config.mcpServers).length}`);
  console.log(`  LSP 服务器: ${Object.keys(config.lspServers).length}`);
  console.log(`  插件: ${config.plugins.length}`);
  console.log(`  多用户: ${config.users.length}`);
}

/** 交互式初始化向导：生成 .aicoder.json 与 .env */
async function runInit(): Promise<void> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const workdir = process.cwd();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string, def = ""): Promise<string> =>
    new Promise((resolve) =>
      rl.question(`${C.cyan}${q}${def ? ` (${def})` : ""}${C.reset} `, (a) =>
        resolve(a.trim() || def)
      )
    );

  console.log(`${C.bold}${C.cyan}AICoder 初始化向导${C.reset}\n`);

  const baseURL = await ask("API Base URL", "https://api.openai.com/v1");
  const model = await ask("模型名", "gpt-4o-mini");
  const apiKey = await ask("API Key（可留空，稍后写入 .env）");
  const theme = await ask("主题 dark/light/plain", "dark");
  const locale = await ask("语言 zh/en", "zh");
  const autoApprove = (await ask("自动批准写操作? y/N", "N")).toLowerCase().startsWith("y");
  const enabledPlugins = (await ask("启用示例插件? y/N", "N")).toLowerCase().startsWith("y");
  const enableLsp = (await ask("启用 TypeScript LSP? y/N", "N")).toLowerCase().startsWith("y");

  const config: Record<string, unknown> = {
    $schema: "./aicoder.schema.json",
    $version: 1,
    model,
    baseURL,
    autoApprove,
    permissions: {
      allow: ["read_file", "list_dir", "glob", "search", "find_symbol", "find_references"],
      ask: ["write_file", "edit_file", "run_command"],
      deny: ["run_command(rm -rf|format )"],
    },
    context: { maxContextTokens: 65536, keepRecentMessages: 10 },
    observability: { enabled: true },
    ui: { theme, locale },
  };
  if (enabledPlugins) config.plugins = ["./examples/plugins/hello.mjs"];
  if (enableLsp)
    config.lspServers = {
      typescript: { command: "typescript-language-server", args: ["--stdio"] },
    };

  const configPath = path.join(workdir, ".aicoder.json");
  let writeConfig = true;
  try {
    await fs.access(configPath);
    writeConfig = (await ask(".aicoder.json 已存在，覆盖? y/N", "N")).toLowerCase().startsWith("y");
  } catch {
    /* 不存在 */
  }
  if (writeConfig) {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    console.log(`${C.green}已写入 ${configPath}${C.reset}`);
  }

  if (apiKey) {
    const envPath = path.join(workdir, ".env");
    let writeEnv = true;
    try {
      await fs.access(envPath);
      writeEnv = (await ask(".env 已存在，覆盖? y/N", "N")).toLowerCase().startsWith("y");
    } catch {
      /* 不存在 */
    }
    if (writeEnv) {
      const env = `AICODER_API_KEY=${apiKey}\nAICODER_BASE_URL=${baseURL}\nAICODER_MODEL=${model}\n`;
      await fs.writeFile(envPath, env, "utf8");
      console.log(`${C.green}已写入 ${envPath}${C.reset}`);
      console.log(`${C.dim}提示：.env 已被 .gitignore 忽略，不会提交。${C.reset}`);
    }
  }

  rl.close();
  console.log(`\n${C.green}初始化完成！${C.reset} 运行 ${C.bold}aicoder${C.reset} 开始对话。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
