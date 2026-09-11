/**
 * 轻量国际化
 *
 * 通过 AICODER_LANG 或 ui.locale 选择语言，默认中文。
 * 未翻译的键回退到英文，再回退到键名本身。
 */

export type Locale = "zh" | "en" | "ja" | "ko" | "es";

export const SUPPORTED_LOCALES: Locale[] = ["zh", "en", "ja", "ko", "es"];

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
    "web.stop": "停止",
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
    "web.stop": "Stop",
  },
  ja: {
    "app.name": "AICoder",
    "app.tagline": "オープンソース AI コーディングアシスタント",
    "app.model": "モデル",
    "app.workdir": "作業ディレクトリ",
    "app.session": "セッション",
    "app.ready": "準備完了",
    "cli.hint": "入力して会話を開始",
    "cli.help": "ヘルプ",
    "cli.thinking": "考え中...",
    "cli.contextTrimmed": "コンテキストを圧縮しました",
    "cli.denied": "拒否されました",
    "cli.toolRunning": "ツール実行",
    "cli.modelMissing":
      "注意: AICODER_API_KEY が見つかりません。ローカル Ollama なら無視できます。",
    "web.send": "送信",
    "web.newChat": "新しい会話",
    "web.history": "履歴",
    "web.usage": "使用量",
    "web.stop": "停止",
  },
  ko: {
    "app.name": "AICoder",
    "app.tagline": "오픈소스 AI 코딩 어시스턴트",
    "app.model": "모델",
    "app.workdir": "작업 디렉터리",
    "app.session": "세션",
    "app.ready": "준비됨",
    "cli.hint": "입력하여 대화 시작",
    "cli.help": "도움말",
    "cli.thinking": "생각 중...",
    "cli.contextTrimmed": "컨텍스트 압축됨",
    "cli.denied": "거부됨",
    "cli.toolRunning": "도구 실행",
    "cli.modelMissing": "참고: AICODER_API_KEY가 없습니다. 로컬 Ollama면 무시하세요.",
    "web.send": "보내기",
    "web.newChat": "새 대화",
    "web.history": "기록",
    "web.usage": "사용량",
    "web.stop": "중지",
  },
  es: {
    "app.name": "AICoder",
    "app.tagline": "Asistente de programación con IA de código abierto",
    "app.model": "Modelo",
    "app.workdir": "Directorio",
    "app.session": "Sesión",
    "app.ready": "Listo",
    "cli.hint": "Escribe para empezar",
    "cli.help": "Ayuda",
    "cli.thinking": "Pensando...",
    "cli.contextTrimmed": "Contexto comprimido",
    "cli.denied": "denegado",
    "cli.toolRunning": "Ejecutando herramienta",
    "cli.modelMissing": "Nota: no se encontró AICODER_API_KEY. Ignora si usas Ollama local.",
    "web.send": "Enviar",
    "web.newChat": "Nuevo chat",
    "web.history": "Historial",
    "web.usage": "Uso",
    "web.stop": "Detener",
  },
};

let current: Locale = "zh";

export function setLocale(locale: string | undefined): Locale {
  if (!locale) return current;
  const lower = locale.toLowerCase();
  for (const l of SUPPORTED_LOCALES) {
    if (lower === l || lower.startsWith(l + "-")) {
      current = l;
      return current;
    }
  }
  return current;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: string): string {
  return dict[current][key] ?? dict.en[key] ?? key;
}
