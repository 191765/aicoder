import { registerTool, type ToolDef, type ToolContext } from "./tools.js";
import type { Config } from "./config.js";

/**
 * GitHub 工作流工具
 *
 * 优先使用 `gh` CLI（若已安装并登录）；否则回退到 GITHUB_TOKEN + REST API。
 * 提供：PR 审查辅助（读取 PR diff/描述/评论）、Issue 查看/评论、CI 失败日志读取。
 */

let installed = false;
let token: string | undefined;

export function initGithub(config: Config): void {
  token = config.github?.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
}

function repoArgs(ctx: ToolContext): string[] {
  const owner = ctx.config.github?.owner;
  const repo = ctx.config.github?.repo;
  return owner && repo ? ["-R", `${owner}/${repo}`] : [];
}

async function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeout = 30_000
): Promise<{ code: number; out: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GH_TOKEN: token ?? process.env.GH_TOKEN ?? "" },
    });
    let out = "";
    const cap = 60_000;
    const onData = (b: Buffer) => {
      if (out.length < cap) out += b.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, out: out + `\n[超时 ${timeout}ms]` });
    }, timeout);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `命令不可用: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: out.slice(0, cap) });
    });
  });
}

async function hasGh(cwd: string): Promise<boolean> {
  const r = await run("gh", ["--version"], cwd, 8000);
  return r.code === 0;
}

async function rest(
  pathname: string,
  cwd: string
): Promise<{ ok: boolean; body: unknown; status: number }> {
  if (!token) return { ok: false, body: { message: "未配置 GITHUB_TOKEN" }, status: 0 };
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(
      process.platform === "win32" ? "powershell.exe" : "sh",
      process.platform === "win32"
        ? [
            "-NoProfile",
            "-Command",
            `Invoke-RestMethod -Uri 'https://api.github.com${pathname}' -Headers @{ Authorization = 'Bearer ${token}'; 'User-Agent' = 'aicoder' } -Method GET | ConvertTo-Json -Depth 6`,
          ]
        : ["-c", `curl -s -H "Authorization: Bearer ${token}" -H "User-Agent: aicoder" https://api.github.com${pathname}`],
      { cwd }
    );
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", () => resolve({ ok: false, body: { message: "请求失败" }, status: 0 }));
    child.on("close", (code) => {
      try {
        resolve({ ok: code === 0, body: JSON.parse(out), status: code === 0 ? 200 : 0 });
      } catch {
        resolve({ ok: false, body: { message: out.slice(0, 300) }, status: 0 });
      }
    });
  });
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v === "string") return v;
  if (required) throw new Error(`缺少参数 ${key}`);
  return "";
}

const prReviewTool: ToolDef = {
  name: "github_pr_view",
  description:
    "查看某个 Pull Request 的信息与 diff，用于代码审查。需要已安装 gh CLI 或配置 GITHUB_TOKEN。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      number: { type: "string", description: "PR 编号" },
      include_diff: { type: "boolean", description: "是否包含 diff，默认 true" },
    },
    required: ["number"],
  },
  async run(args, ctx) {
    const number = str(args, "number");
    const includeDiff = args.include_diff !== false;
    if (await hasGh(ctx.workdir)) {
      const info = await run("gh", ["pr", "view", number, "--json",
        "title,body,author,baseRefName,headRefName,files,additions,deletions", ...repoArgs(ctx)], ctx.workdir);
      let out = info.out;
      if (includeDiff) {
        const diff = await run("gh", ["pr", "diff", number, ...repoArgs(ctx)], ctx.workdir);
        out += "\n\n--- DIFF ---\n" + diff.out;
      }
      return out;
    }
    // REST 回退
    const owner = ctx.config.github?.owner;
    const repo = ctx.config.github?.repo;
    if (!owner || !repo) return "需要 gh CLI，或在 .aicoder.json 配置 github.owner/repo 与 GITHUB_TOKEN。";
    const info = await rest(`/repos/${owner}/${repo}/pulls/${number}`, ctx.workdir);
    let out = JSON.stringify(info.body, null, 2);
    if (includeDiff) {
      const diff = await rest(`/repos/${owner}/${repo}/pulls/${number}`, ctx.workdir);
      void diff;
      out += "\n（REST 模式暂不拉取 diff，建议安装 gh CLI）";
    }
    return out;
  },
};

const issueViewTool: ToolDef = {
  name: "github_issue_view",
  description: "查看某个 Issue 的标题、正文与评论。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      number: { type: "string", description: "Issue 编号" },
    },
    required: ["number"],
  },
  async run(args, ctx) {
    const number = str(args, "number");
    if (await hasGh(ctx.workdir)) {
      const r = await run("gh", ["issue", "view", number, "--json",
        "title,body,author,state,labels,comments", ...repoArgs(ctx)], ctx.workdir);
      return r.out;
    }
    const owner = ctx.config.github?.owner;
    const repo = ctx.config.github?.repo;
    if (!owner || !repo) return "需要 gh CLI 或配置 github.owner/repo。";
    const r = await rest(`/repos/${owner}/${repo}/issues/${number}`, ctx.workdir);
    return JSON.stringify(r.body, null, 2);
  },
};

const ciLogsTool: ToolDef = {
  name: "github_ci_logs",
  description: "查看最近一次 GitHub Actions 运行日志，用于定位 CI 失败原因。",
  mutating: false,
  parameters: {
    type: "object",
    properties: {
      run_id: { type: "string", description: "运行 ID（可选，默认最近一次失败）" },
    },
    required: [],
  },
  async run(args, ctx) {
    if (!(await hasGh(ctx.workdir))) {
      return "需要 gh CLI（未检测到）。请安装并登录 gh 后重试。";
    }
    const id = str(args, "run_id", false);
    const listArgs = id
      ? ["run", "view", id, "--log-failed", ...repoArgs(ctx)]
      : ["run", "view", "--log-failed", ...repoArgs(ctx)];
    const r = await run("gh", listArgs, ctx.workdir, 60_000);
    return r.out || "(无日志)";
  },
};

export function installGithubTools(): void {
  if (installed) return;
  installed = true;
  registerTool(prReviewTool);
  registerTool(issueViewTool);
  registerTool(ciLogsTool);
}
