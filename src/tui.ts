import readline from "node:readline";
import process from "node:process";
import type { Agent, AgentEvent } from "./agent.js";
import { getTheme, type Theme } from "./theme.js";

/**
 * 富交互 TUI
 *
 * 特性：多行编辑、输入历史（↑/↓）、行内编辑（←/→/Home/End）、
 * 软换行、主题、状态行、流式输出、斜杠命令提示。
 *
 * 使用 readline 的 keypress 事件手动管理编辑缓冲，无需额外依赖。
 */

export interface TuiOptions {
  theme?: string;
  /** 会话 id（用于状态行展示） */
  sessionId?: string;
  model?: string;
  workdir?: string;
  onCommand?: (cmd: string) => Promise<void> | void;
  commands?: string[];
}

const COMMANDS = [
  "/exit",
  "/quit",
  "/reset",
  "/new",
  "/rag",
  "/save",
  "/sessions",
  "/delete",
  "/help",
];

export class Tui {
  private rl: readline.Interface;
  private theme: Theme;
  private buffer = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private draft = "";
  private busy = false;
  private statusText = "就绪";
  private opts: TuiOptions;
  private agent: Agent;
  private closed = false;

  constructor(agent: Agent, opts: TuiOptions = {}) {
    this.agent = agent;
    this.opts = opts;
    this.theme = getTheme(opts.theme);
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (process.stdin.isTTY) {
      readline.emitKeypressEvents(process.stdin, this.rl);
      process.stdin.setRawMode?.(true);
    }
  }

  private t(): Theme {
    return this.theme;
  }

  private write(s: string): void {
    process.stdout.write(s);
  }

  private promptLabel(): string {
    return `${this.t().user}${this.t().bold}›${this.t().reset} `;
  }

  start(): void {
    this.printHeader();
    this.renderPrompt();
    process.stdin.on("keypress", (str: string | undefined, key: readline.Key) => {
      if (this.closed) return;
      this.onKey(str, key);
    });
    this.rl.on("close", () => {
      this.closed = true;
      this.write("\n");
      process.exit(0);
    });
  }

  private printHeader(): void {
    const t = this.t();
    this.write(
      `${t.bold}${t.accent}AICoder${t.reset} ${t.dim}富交互 TUI${t.reset}\n`
    );
    this.write(
      `${t.dim}模型: ${this.opts.model ?? this.agent.model}  工作目录: ${this.opts.workdir ?? ""}${t.reset}\n`
    );
    if (this.opts.sessionId) {
      this.write(`${t.dim}会话: ${this.opts.sessionId}${t.reset}\n`);
    }
    this.write(
      `${t.dim}Enter 发送 · Ctrl+J 换行 · ↑/↓ 历史 · Ctrl+C 退出 · /help 帮助${t.reset}\n\n`
    );
  }

  /** 清空当前行并重绘 */
  private renderPrompt(): void {
    const t = this.t();
    const lines = this.buffer.split("\n");
    // 回到行首并清除到屏尾
    this.write("\r\x1b[J");
    this.write(`${t.dim}${this.statusText}${t.reset}\n`);
    this.write(this.promptLabel());
    this.write(lines.join(`\n${" ".repeat(0)}`));
    // 将光标移到目标位置
    const total = this.buffer;
    const after = total.slice(this.cursor);
    const newlinesAfter = after.split("\n").length - 1;
    if (newlinesAfter > 0) {
      this.write(`\x1b[${newlinesAfter}A`);
      const lastLine = after.split("\n")[after.split("\n").length - 1]!;
      this.write(`\r\x1b[${lastLine.length}C`);
    }
  }

  private onKey(str: string | undefined, key: readline.Key): void {
    const t = this.t();
    if (key.ctrl && key.name === "c") {
      this.write("\n");
      this.rl.close();
      return;
    }
    if (this.busy) return;

    switch (key.name) {
      case "return":
        if (key.ctrl || key.shift || key.meta) {
          this.insert("\n");
        } else {
          void this.submit();
        }
        return;
      case "backspace":
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
        }
        this.renderPrompt();
        return;
      case "delete":
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        }
        this.renderPrompt();
        return;
      case "left":
        if (this.cursor > 0) this.cursor--;
        this.renderPrompt();
        return;
      case "right":
        if (this.cursor < this.buffer.length) this.cursor++;
        this.renderPrompt();
        return;
      case "home":
        this.cursor = this.buffer.lastIndexOf("\n", this.cursor - 1) + 1;
        this.renderPrompt();
        return;
      case "end": {
        const nl = this.buffer.indexOf("\n", this.cursor);
        this.cursor = nl === -1 ? this.buffer.length : nl;
        this.renderPrompt();
        return;
      }
      case "up":
        this.navigateHistory(-1);
        return;
      case "down":
        this.navigateHistory(1);
        return;
      default:
        break;
    }

    if (str && !key.ctrl && !key.meta) {
      this.insert(str);
    }
    void t;
  }

  private insert(s: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
    this.cursor += s.length;
    this.renderPrompt();
  }

  private navigateHistory(dir: number): void {
    if (!this.history.length) return;
    if (this.historyIdx === -1) this.draft = this.buffer;
    let idx = this.historyIdx + dir;
    if (idx < -1) idx = -1;
    if (idx >= this.history.length) idx = this.history.length - 1;
    this.historyIdx = idx;
    this.buffer = idx === -1 ? this.draft : this.history[idx]!;
    this.cursor = this.buffer.length;
    this.renderPrompt();
  }

  private async submit(): Promise<void> {
    const text = this.buffer.trim();
    this.buffer = "";
    this.cursor = 0;
    this.historyIdx = -1;

    if (!text) {
      this.renderPrompt();
      return;
    }
    this.history.push(text);
    this.write("\n");

    if (text.startsWith("/")) {
      const handled = await this.handleLocalCommand(text);
      if (handled) {
        this.statusText = "就绪";
        this.renderPrompt();
        return;
      }
    }

    this.busy = true;
    await this.runTurn(text);
    this.busy = false;
    this.statusText = "就绪";
    this.renderPrompt();
  }

  private async handleLocalCommand(text: string): Promise<boolean> {
    const t = this.t();
    const [cmd, ...rest] = text.split(" ");
    switch (cmd) {
      case "/exit":
      case "/quit":
        this.rl.close();
        return true;
      case "/help":
        this.write(`${t.dim}${COMMANDS.join("  ")}${t.reset}\n`);
        return true;
      case "/reset":
        this.agent.reset();
        this.write(`${t.dim}上下文已清空${t.reset}\n`);
        return true;
      case "/new":
        if (this.opts.onCommand) await this.opts.onCommand(text);
        this.agent.reset();
        return true;
      case "/rag":
        this.statusText = "构建索引...";
        this.renderPrompt();
        await this.opts.onCommand?.(text);
        return true;
      case "/save":
        await this.agent.save();
        this.write(`${t.dim}已保存会话 ${this.agent.id ?? ""}${t.reset}\n`);
        return true;
      default:
        if (cmd && cmd.startsWith("/")) {
          // 交由外部命令处理（/sessions, /delete 等）
          if (this.opts.onCommand) {
            await this.opts.onCommand(text);
            return true;
          }
        }
        return false;
    }
  }

  private async runTurn(text: string): Promise<void> {
    const t = this.t();
    const controller = new AbortController();
    const onSig = (): void => controller.abort();
    process.once("SIGINT", onSig);

    let wroteText = false;
    const startAssistant = (): void => {
      if (!wroteText) {
        this.write(`${t.accent}${t.bold}◂${t.reset} `);
        wroteText = true;
      }
    };

    try {
      for await (const ev of this.agent.chat(text, controller.signal)) {
        this.onAgentEvent(ev, startAssistant);
      }
    } catch (err) {
      this.write(`\n${t.error}运行失败: ${err instanceof Error ? err.message : err}${t.reset}\n`);
    }
    process.removeListener("SIGINT", onSig);
    if (wroteText) this.write("\n");
  }

  private onAgentEvent(ev: AgentEvent, startAssistant: () => void): void {
    const t = this.t();
    switch (ev.type) {
      case "text":
        startAssistant();
        this.write(ev.delta);
        this.statusText = "生成中...";
        break;
      case "tool_start":
        this.write(`\n${t.dim}${t.tool}⚙ ${ev.name}${t.reset}\n`);
        this.statusText = `调用工具 ${ev.name}...`;
        break;
      case "tool_end":
        this.write(`${t.dim}${ev.ok ? t.success + "✓" : t.error + "✗"} ${ev.name}${t.reset}\n`);
        break;
      case "tool_denied":
        this.write(`${t.error}⛔ ${ev.name}: ${ev.reason}${t.reset}\n`);
        break;
      case "context":
        this.write(`${t.dim}… 上下文压缩 (${ev.tokens} tokens, -${ev.dropped})${t.reset}\n`);
        break;
      case "error":
        this.write(`${t.error}错误: ${ev.message}${t.reset}\n`);
        break;
      default:
        break;
    }
  }
}

export function runTui(agent: Agent, opts: TuiOptions): Tui {
  const tui = new Tui(agent, opts);
  tui.start();
  return tui;
}
