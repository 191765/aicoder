import { loadConfig } from "../src/config.js";
import { Agent } from "../src/agent.js";
import { Tui } from "../src/tui.js";
import { getTheme } from "../src/theme.js";

// 主题
console.log("themes:", Object.keys((await import("../src/theme.js")).THEMES).join(","));
console.log("dark accent:", JSON.stringify(getTheme("dark").accent));
console.log("plain accent:", JSON.stringify(getTheme("plain").accent));
console.log("unknown falls back:", getTheme("nope").name);

// TUI 构造（不 start，避免 raw mode / 阻塞）
const cfg = loadConfig({ apiKey: "t", baseURL: "http://localhost:1/v1", model: "m", workdir: process.cwd() });
const agent = new Agent({ config: cfg });
const tui = new Tui(agent, { theme: "dark", model: "m", workdir: process.cwd(), sessionId: "demo" });
console.log("Tui constructed:", tui instanceof Tui);
console.log("OK");
