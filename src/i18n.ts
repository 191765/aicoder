/**
 * 轻量国际化
 *
 * 通过 AICODER_LANG 或 ui.locale 选择语言（zh / en），默认中文。
 * 未翻译的键回退到中文，再回退到键名本身。
 */

export type Locale = "zh" | "en";

const dict: Record<Locale, Record<string, string>> = {
  zh: {
    "app.name": "AICoder",
    "app.tagline": "开源 AI 编程助手",
    "app.model": "模型",
    "app.workdir": "工作目录",
    "app.session": "会话",
    "app.ready": "就绪",
    "cli.hint": "输入内容开始对话",
    "cli.help": "帮助",
    "cli.thinking": "思考中...",
    "cli.contextTrimmed": "上下文已压缩",
    "cli.denied": "被拒绝",
    "cli.toolRunning": "调用工具",
    "cli.modelMissing": "提示：未检测到 AICODER_API_KEY。若使用本地 Ollama 可忽略。",
    "web.send": "发送",
    "web.newChat": "新对话",
    "web.history": "历史会话",
    "web.usage": "用量",
  },
  en: {
    "app.name": "AICoder",
    "app.tagline": "Open-source AI coding assistant",
    "app.model": "Model",
    "app.workdir": "Workdir",
    "app.session": "Session",
    "app.ready": "Ready",
    "cli.hint": "Type to start chatting",
    "cli.help": "Help",
    "cli.thinking": "Thinking...",
    "cli.contextTrimmed": "Context compressed",
    "cli.denied": "denied",
    "cli.toolRunning": "Running tool",
    "cli.modelMissing": "Note: AICODER_API_KEY not found. Ignore if using local Ollama.",
    "web.send": "Send",
    "web.newChat": "New chat",
    "web.history": "History",
    "web.usage": "Usage",
  },
};

let current: Locale = "zh";

export function setLocale(locale: string | undefined): Locale {
  if (locale === "en" || locale === "zh") current = locale;
  else if (locale && locale.toLowerCase().startsWith("en")) current = "en";
  return current;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: string): string {
  return dict[current][key] ?? dict.zh[key] ?? key;
}
