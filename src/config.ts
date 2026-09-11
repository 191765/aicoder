import "dotenv/config";
import path from "node:path";

function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

export interface Config {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  workdir: string;
  port: number;
  token: string;
  tokenGenerated?: boolean;
  autoApprove: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    apiKey: process.env.AICODER_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
    baseURL:
      process.env.AICODER_BASE_URL ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1",
    model: process.env.AICODER_MODEL ?? "gpt-4o-mini",
    temperature: num(process.env.AICODER_TEMPERATURE, 0.2),
    maxTokens: num(process.env.AICODER_MAX_TOKENS, 4096),
    maxSteps: num(process.env.AICODER_MAX_STEPS, 25),
    workdir: path.resolve(process.env.AICODER_WORKDIR ?? process.cwd()),
    port: num(process.env.AICODER_PORT, 8787),
    token: process.env.AICODER_TOKEN ?? "",
    autoApprove: bool(process.env.AICODER_AUTO_APPROVE, false),
    ...overrides,
  };
  return cfg;
}
