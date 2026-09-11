import type { Config } from "./config.js";

/**
 * 本地模型体验
 *
 * 自动探测本地 Ollama / LM Studio 等服务，列出可用模型，
 * 并在未检测到时给出安装与拉取指引。
 */

export interface LocalEndpoint {
  name: string;
  baseURL: string;
}

export interface LocalModelInfo {
  endpoint: string;
  models: string[];
  reachable: boolean;
  error?: string;
}

const DEFAULT_ENDPOINTS: LocalEndpoint[] = [
  { name: "Ollama", baseURL: "http://localhost:11434/v1" },
  { name: "LM Studio", baseURL: "http://localhost:1234/v1" },
];

async function fetchJson(url: string, timeoutMs = 2000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverLocalModels(
  endpoints: LocalEndpoint[] = DEFAULT_ENDPOINTS
): Promise<LocalModelInfo[]> {
  const out: LocalModelInfo[] = [];
  for (const ep of endpoints) {
    try {
      // OpenAI 兼容的 /models，以及 Ollama 原生的 /api/tags
      let models: string[] = [];
      try {
        const data = (await fetchJson(`${ep.baseURL}/models`)) as {
          data?: Array<{ id?: string }>;
        };
        models = (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
      } catch {
        // 尝试 Ollama 原生接口
        const native = (await fetchJson(ep.baseURL.replace(/\/v1$/, "") + "/api/tags")) as {
          models?: Array<{ name?: string }>;
        };
        models = (native.models ?? []).map((m) => m.name ?? "").filter(Boolean);
      }
      out.push({ endpoint: ep.name, models, reachable: true });
    } catch (err) {
      out.push({
        endpoint: ep.name,
        models: [],
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** 判断当前配置是否指向本地服务 */
export function isLocalConfig(config: Config): boolean {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(config.baseURL);
}

/** 生成本地模型使用指引 */
export function localModelHint(): string {
  return [
    "未检测到本地模型服务。可任选其一：",
    "",
    "Ollama（推荐）:",
    "  1. 安装: https://ollama.com/download",
    "  2. 拉取模型: ollama pull qwen2.5-coder",
    "  3. 在 .env 中配置:",
    "     AICODER_BASE_URL=http://localhost:11434/v1",
    "     AICODER_API_KEY=ollama",
    "     AICODER_MODEL=qwen2.5-coder",
    "",
    "LM Studio:",
    "  1. 下载: https://lmstudio.ai/",
    "  2. 在 LM Studio 中启动本地服务器（默认 http://localhost:1234/v1）",
    "  3. AICODER_BASE_URL=http://localhost:1234/v1",
  ].join("\n");
}

export const localEndpoints = DEFAULT_ENDPOINTS;
