import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";

/**
 * 项目摘要 / 上下文
 *
 * 扫描仓库生成结构化摘要（目录树、语言分布、关键文件、脚本、依赖），
 * 缓存到 .aicoder/summary.md，注入系统提示，帮助助手快速理解大仓库。
 */

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "target",
  ".turbo",
  ".aicoder",
  "out",
  ".idea",
  ".vscode",
]);

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".rb": "Ruby",
  ".php": "PHP",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cs": "C#",
  ".swift": "Swift",
  ".kt": "Kotlin",
  ".scala": "Scala",
  ".sh": "Shell",
  ".md": "Markdown",
  ".html": "HTML",
  ".css": "CSS",
  ".vue": "Vue",
  ".json": "JSON",
};

const SUMMARY_FILE = ".aicoder/summary.md";

export interface RepoSummary {
  text: string;
  fileCount: number;
  languages: Array<{ lang: string; count: number }>;
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function generateSummary(config: Config): Promise<RepoSummary> {
  const root = config.workdir;
  const files: string[] = [];
  const langCount = new Map<string, number>();
  const topDirs = new Set<string>();

  const rec = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".env.example") continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (e.isDirectory()) {
        topDirs.add(rel.split("/")[0]!);
        await rec(full, depth + 1);
      } else if (e.isFile()) {
        files.push(rel);
        const ext = path.extname(e.name).toLowerCase();
        const lang = LANG_BY_EXT[ext];
        if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
      }
    }
  };
  await rec(root, 0);

  const languages = [...langCount.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => b.count - a.count);

  // 关键文件
  const keyFiles = ["README.md", "package.json", "tsconfig.json", "Dockerfile", "AGENTS.md"].filter(
    (f) => files.includes(f)
  );

  // package.json 脚本与依赖
  let scripts = "";
  let deps = "";
  const pkg = await readJson(path.join(root, "package.json"));
  if (pkg) {
    const s = pkg.scripts as Record<string, string> | undefined;
    if (s)
      scripts = Object.entries(s)
        .slice(0, 20)
        .map(([k, v]) => `- ${k}: ${v}`)
        .join("\n");
    const d = pkg.dependencies as Record<string, string> | undefined;
    if (d) deps = Object.keys(d).slice(0, 40).join(", ");
  }

  const topLevelDirs = [...new Set(files.map((f) => f.split("/")[0]!))]
    .filter((d) => !d.includes("."))
    .slice(0, 20);

  const lines: string[] = [];
  lines.push(`# 项目摘要（自动生成）`);
  lines.push(`文件总数: ${files.length}`);
  if (languages.length) {
    lines.push(
      `主要语言: ${languages
        .slice(0, 6)
        .map((l) => `${l.lang}(${l.count})`)
        .join(", ")}`
    );
  }
  if (topLevelDirs.length) lines.push(`顶层目录: ${topLevelDirs.join(", ")}`);
  if (keyFiles.length) lines.push(`关键文件: ${keyFiles.join(", ")}`);
  if (scripts) lines.push(`\n## npm 脚本\n${scripts}`);
  if (deps) lines.push(`\n## 主要依赖\n${deps}`);

  const text = lines.join("\n");

  return { text, fileCount: files.length, languages };
}

export async function saveSummary(config: Config, text: string): Promise<void> {
  const file = path.join(config.workdir, SUMMARY_FILE);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

export async function loadCachedSummary(config: Config): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(config.workdir, SUMMARY_FILE), "utf8");
    return text.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 获取项目摘要：优先内存缓存，其次文件缓存（超过 maxAgeMs 重新生成）。
 */
const summaryCache = new Map<string, { text: string; ts: number }>();

export async function getProjectSummary(
  config: Config,
  maxAgeMs = 24 * 60 * 60 * 1000
): Promise<string> {
  const cached = summaryCache.get(config.workdir);
  if (cached && Date.now() - cached.ts < maxAgeMs) return cached.text;

  const file = path.join(config.workdir, SUMMARY_FILE);
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs < maxAgeMs) {
      const text = await fs.readFile(file, "utf8");
      if (text.trim()) {
        summaryCache.set(config.workdir, { text, ts: Date.now() });
        return text;
      }
    }
  } catch {
    /* 需生成 */
  }
  const summary = await generateSummary(config);
  await saveSummary(config, summary.text);
  summaryCache.set(config.workdir, { text: summary.text, ts: Date.now() });
  return summary.text;
}
