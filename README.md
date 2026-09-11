# AICoder · 开源 AI 编程助手

一个开源的 AI 编程助手，同时提供 **终端 (CLI)** 与 **网页 (Web)** 两种运行形态。
接入任意 OpenAI 兼容的 LLM（OpenAI / DeepSeek / Moonshot / 通义 / 本地 Ollama 等），
具备读取与修改文件、执行命令、代码库检索（RAG）等 Agent 能力。

## 特性

- 🖥️ **双形态**：终端交互式 CLI + 浏览器 Web UI（SSE 流式输出）
- 🔌 **任意模型**：任何兼容 `/chat/completions` 的服务都可接入
- 🛠️ **工具调用 Agent**：读文件、写文件、精准编辑、列目录、glob、正则搜索、执行命令
- 🔎 **代码库检索 (RAG)**：内置中英文 BM25 关键词检索，无需外部向量数据库
- 🔐 **安全可控**：路径沙箱 + 细粒度权限规则（allow/ask/deny）；Web 端强制令牌
- 🧠 **上下文管理**：超预算自动裁剪历史、超长工具结果摘要，长对话不溢出
- 🤖 **子代理**：派发独立子任务，隔离上下文，只回传结论
- 🌿 **Git 集成**：status / diff / log / show / commit
- 🔗 **MCP 支持**：接入任意 Model Context Protocol 服务器，扩展外部工具
- 🧭 **LSP 集成**：跳转定义、查找引用、悬停信息、诊断
- 📦 **零重型依赖**：核心仅依赖 `openai`、`dotenv`

## 目录结构

```
src/
  cli.ts         终端界面
  server.ts      网页服务 (HTTP + SSE)
  agent.ts       Agent 核心循环（多轮工具调用）
  provider.ts    LLM Provider（OpenAI 兼容，流式）
  tools.ts       工具系统（文件/命令/搜索）
  rag.ts         代码库检索索引
  permissions.ts 权限规则（allow/ask/deny）
  context.ts     上下文压缩与 token 预算
  subagent.ts    子代理（task 工具）
  git.ts         Git 集成工具
  mcp.ts         MCP 客户端
  lsp.ts         LSP 客户端
  runtime.ts     扩展初始化
  config.ts      配置加载
  types.ts       类型定义
web/             网页前端
```

## 内置工具一览

| 工具 | 说明 |
| --- | --- |
| `read_file` / `write_file` / `edit_file` | 读取、写入、精准编辑文件 |
| `list_dir` / `glob` / `search` | 目录浏览、通配查找、正则搜索 |
| `run_command` | 执行 shell 命令 |
| `task` | 派发子代理执行独立任务 |
| `git_status` / `git_diff` / `git_log` / `git_show` / `git_commit` | Git 集成 |
| `lsp_definition` / `lsp_references` / `lsp_hover` / `lsp_diagnostics` | 语言服务 |
| `mcp__<server>__<tool>` | 来自 MCP 服务器的动态工具 |

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（复制后填写 API Key）
cp .env.example .env      # Windows: copy .env.example .env

# 3. 运行终端版
npm run dev

# 或运行网页版（浏览器打开 http://localhost:8787）
npm run dev:web
```

### 通过 npx 直接运行（发布到 npm 后）

```bash
npx @191765/aicoder               # 终端对话
npx @191765/aicoder web           # 网页版
npx @191765/aicoder --help        # 查看帮助
```

## 配置

在 `.env` 中配置（见 `.env.example`）：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `AICODER_API_KEY` | API Key | - |
| `AICODER_BASE_URL` | 接口地址 | `https://api.openai.com/v1` |
| `AICODER_MODEL` | 模型名 | `gpt-4o-mini` |
| `AICODER_TEMPERATURE` | 采样温度 | `0.2` |
| `AICODER_MAX_TOKENS` | 单次最大输出 | `4096` |
| `AICODER_MAX_STEPS` | 最大工具调用轮数 | `25` |
| `AICODER_WORKDIR` | 工作目录 | 当前目录 |
| `AICODER_PORT` | 网页端口 | `8787` |
| `AICODER_TOKEN` | 网页访问令牌 | 自动生成 |
| `AICODER_AUTO_APPROVE` | 自动批准写操作 | `false` |
| `AICODER_PERMISSIONS` | 权限规则（见下） | 只读放行 / 写询问 |
| `AICODER_MAX_CONTEXT_TOKENS` | 上下文窗口预算 | `32768` |
| `AICODER_RESERVE_TOKENS` | 为输出预留 token | `4096` |
| `AICODER_KEEP_RECENT` | 至少保留最近消息数 | `8` |
| `AICODER_TOOL_RESULT_MAX_CHARS` | 工具结果摘要阈值 | `4000` |

### 权限规则

规则格式：`动作:工具名(参数正则)`

- 动作：`allow`（放行）/ `ask`（询问）/ `deny`（拒绝）
- 工具名支持 `*` 通配
- 括号内为可选的参数匹配（对 `run_command` 匹配命令、对文件工具匹配路径）
- 优先级：`deny` > `ask` > `allow`；未命中时只读工具放行，写操作询问
- 多条用 `;` 或换行分隔

```dotenv
AICODER_PERMISSIONS="deny:run_command(rm -rf|format |del /f);allow:read_file;ask:write_file"
```

也可在项目根目录放 `.aicoder.json` 做更结构化的配置（会与 `.env` 合并，`.env` 优先）：

```json
{
  "model": "deepseek-chat",
  "permissions": {
    "allow": ["read_file", "list_dir", "glob", "search"],
    "ask": ["write_file", "edit_file"],
    "deny": ["run_command(rm -rf|format )"]
  },
  "context": {
    "maxContextTokens": 65536,
    "keepRecentMessages": 10
  }
}
```

### 上下文管理

长对话超出预算时，AICoder 会自动裁剪较早的历史，只保留 `system` 提示与最近若干条消息，
并对超长的工具结果做首尾摘要。裁剪发生时终端 / 网页会给出提示。这避免了长会话因
上下文超限而报错。

常见模型配置示例：

```dotenv
# DeepSeek
AICODER_BASE_URL=https://api.deepseek.com/v1
AICODER_MODEL=deepseek-chat

# 本地 Ollama
AICODER_BASE_URL=http://localhost:11434/v1
AICODER_API_KEY=ollama
AICODER_MODEL=qwen2.5-coder
```

## 子代理

主 Agent 通过 `task` 工具把独立任务派发给**子代理**。子代理拥有自己的上下文与工具集，
独立完成后只回传简洁结论——这样探索过程的噪声不会污染主对话。

适合派发的任务：探索代码库、定位问题、独立调研/实现、批量分析。子代理禁止再次派发 `task`。

可在 `.aicoder.json` 里调整子代理的最大轮数（通过 `task` 工具参数 `max_steps`）。

## Git 集成

内置 `git_status`、`git_diff`、`git_log`、`git_show`、`git_commit` 五个工具。
只读查询默认放行；`git_commit` 属于写操作，默认需确认。`git_diff` 支持 `staged=true`
查看已暂存改动，`git_commit` 支持 `stage_all=true` 自动暂存。

## MCP 支持

在项目根目录 `.aicoder.json` 中配置 MCP 服务器，启动时自动连接并注册其工具：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    }
  }
}
```

MCP 工具以 `mcp__<服务器>__<工具名>` 注册，并按写操作处理（默认需确认）。

## LSP 集成

配置语言服务器后，可获得「跳转定义 / 查找引用 / 悬停 / 诊断」能力：

```json
{
  "lspServers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"]
    }
  }
}
```

安装 TypeScript 语言服务器：

```bash
npm install -g typescript-language-server typescript
```

未安装时相关工具会返回明确的安装提示，不会导致崩溃。LSP 服务器在首次使用对应
文件类型时才会启动。

## 层级配置

配置按优先级从低到高合并，高层覆盖低层：

1. **全局** `~/.config/aicoder/aicoder.json`（Windows: `%APPDATA%/aicoder/aicoder.json`）
2. **项目** `<工作目录>/.aicoder.json`
3. **环境变量 / 运行时覆盖**

合并规则：对象深合并，数组（如 `permissions`）按层拼接。这样团队可以把项目级
约定提交到仓库，个人偏好放全局。`aicoder` 启动时会打印命中的配置来源。

## 会话持久化

会话自动保存到 `~/.config/aicoder/sessions/`（可用 `AICODER_HOME` 覆盖）：

```bash
aicoder --resume            # 恢复最近会话
aicoder --resume=<id>       # 恢复指定会话
aicoder --session=<id>      # 使用指定 id
aicoder --no-save           # 不持久化
aicoder sessions            # 列出已保存会话
```

交互命令：`/save` 保存、`/sessions` 列表、`/delete <id>` 删除、`/new` 新建。

## 多模型路由

在 `.aicoder.json` 中配置 `models`，按任务 / 工具 / 输入正则路由到不同模型：

```json
{
  "model": "gpt-4o-mini",
  "models": [
    { "match": { "task": "chat", "input": "重构|架构|设计" }, "model": "gpt-4o" },
    { "match": { "task": "explore" }, "model": "gpt-4o-mini" },
    { "model": "gpt-4o" }
  ]
}
```

规则按数组顺序匹配，第一条命中生效；无 `match` 的规则作为默认。可为路由单独指定
`baseURL` / `apiKey`。

## 向量 RAG

默认使用 BM25 关键词检索。启用 embeddings 后升级为 **BM25 + 向量混合检索**：

```dotenv
AICODER_EMBEDDINGS=true
AICODER_EMBEDDING_MODEL=text-embedding-3-small
AICODER_EMBEDDING_WEIGHT=0.5
```

或在 `.aicoder.json` 中：

```json
{ "embeddings": { "enabled": true, "model": "text-embedding-3-small", "weight": 0.5 } }
```

向量失败时自动回退到纯 BM25。索引文件会缓存向量，缺少向量时增量补齐。

## 富交互 TUI

使用 `--tui` 或配置 `ui.rich: true` 启用：

```bash
aicoder --tui
```

```json
{ "ui": { "rich": true, "theme": "dark" } }
```

特性：多行编辑（`Ctrl+J` 换行）、输入历史（`↑`/`↓`）、行内编辑（`←`/`→`/`Home`/`End`）、
流式输出、状态行、主题（`dark` / `light` / `plain`，用 `AICODER_THEME` 或 `ui.theme` 设置）。

## 插件系统

插件是本地 JS/MJS/CJS 文件或 npm 包，默认导出工具与命令。在 `.aicoder.json` 中配置：

```json
{ "plugins": ["./plugins/my-plugin.mjs", "@scope/aicoder-plugin-x"] }
```

插件写法：

```js
export default {
  name: "demo",
  tools: [
    {
      name: "hello",
      description: "打招呼",
      mutating: false,
      async run(args, ctx) { return "hello " + (args.who ?? "world"); }
    }
  ],
  commands: [
    { name: "greet", description: "问候", run(ctx) { ctx.print("hi!"); } }
  ],
  async setup(config) { /* 可选：初始化 */ }
};
```

插件工具注册为 `plugin__<插件名>__<工具名>`，默认按写操作参与权限确认；
插件命令可在对话中输入 `/命令名` 调用。

## 多代理编排

除了单个 `task` 子代理，还提供编排工具：

- `parallel`：并发运行多个子代理，汇总各自结论。适合可并行的调研/分析。
- `pipeline`：串行流水线，前一步结论作为后一步输入（用 `{{input}}` 引用）。适合「调研→设计→实现」。

## 安全强化

- **危险命令阻断**：`run_command` 执行前做硬性黑名单检查（`rm -rf /`、`mkfs`、fork 炸弹等），
  即使权限 `allow` 也会拦截。可在 `.aicoder.json` 的 `security.blockedCommands` 追加自定义正则。
- **密钥防泄露**：写入文件前扫描 OpenAI/AWS/GitHub/Google 等密钥特征，命中默认拒绝；
  设置 `security.redactSecrets: true` 改为脱敏。
- **审计日志**：配置 `security.auditLog` 后，所有写操作与命令执行以 JSONL 记录。

```json
{
  "security": {
    "secretScan": true,
    "redactSecrets": false,
    "blockedCommands": ["\\bgit\\s+push\\s+--force"],
    "auditLog": ".aicoder-audit.log"
  }
}
```

## 用量与调试

启用后可查看 token 用量与费用估算（内置常见模型价格表，可覆盖）：

```json
{
  "observability": {
    "enabled": true,
    "logFile": ".aicoder-trace.log",
    "pricing": { "my-model": { "input": 0.001, "output": 0.002 } }
  }
}
```

- 网页端左下角显示累计用量，`GET /api/usage` 提供 JSON。
- trace 以 JSONL 追加写入，`AICODER_TRACE=1` 时同时打印到 stderr。

## Web 界面

网页端支持多会话管理：左侧「历史会话」可查看、切换、删除；对话自动保存并可恢复。
代码块中的 diff 会高亮显示（`+` 绿 / `-` 红 / `@@` 紫）。界面语言会根据浏览器自动选择中/英。

## 项目记忆

自动读取项目约定并注入系统提示，让助手遵循你的项目规范：

- `AGENTS.md` / `CLAUDE.md`（根目录约定）
- `.aicoder/memory.md`（沉淀记忆）
- `.aicoder/notes/*.md`（分主题笔记）

助手可通过 `remember` 工具把结论写入 `.aicoder/memory.md`，跨会话保留。

## 代码智能（符号索引）

内置轻量符号索引（无需语言服务器），支持跨文件查找：

- `find_symbol`：查找函数/类/接口/变量等定义位置（支持子串匹配）
- `find_references`：查找符号在所有文件中的引用

与 LSP 工具互补：无语言服务器时用符号索引，配置了 LSP 时可用更精确的语义能力。

## GitHub 工作流

配置 `github.owner` / `github.repo` 与 `GITHUB_TOKEN`（或安装并登录 `gh` CLI）后可用：

- `github_pr_view`：查看 PR 信息与 diff，辅助代码审查
- `github_issue_view`：查看 Issue 详情
- `github_ci_logs`：拉取 CI 失败日志，便于定位并修复

## 性能与稳定性

- **自动重试**：对 429/5xx 与网络错误按指数退避重试（`AICODER_MAX_RETRIES`、`AICODER_RETRY_DELAY_MS`）。
- **工具超时**：单个工具执行超时保护（`AICODER_TOOL_TIMEOUT_MS`）。
- **并发编排**：`parallel` 工具并发运行子代理，缩短长任务耗时。

## 国际化

通过 `AICODER_LANG`（`zh` / `en`）或 `.aicoder.json` 的 `ui.locale` 设置语言。
网页端根据浏览器语言自动切换。

## Docker 部署

```bash
docker build -t aicoder .
docker run -it --rm \
  -p 8787:8787 \
  -e AICODER_API_KEY=sk-xxx \
  -e AICODER_BASE_URL=https://api.openai.com/v1 \
  -v "$PWD:/workspace" \
  -v aicoder-data:/data \
  aicoder
```

默认启动网页版，工作目录为 `/workspace`，会话/配置存放在 `/data`。

## 发布流程

```bash
npm run release           # 校验 + 构建 + 测试 + 打包预览
npm run release:publish   # 正式发布到 npm
```

打 tag `v*` 时 GitHub Actions 会自动发布（需配置 `NPM_TOKEN` secret）。

## 监控仪表盘

网页端右上角「📊 监控仪表盘」或访问 `/dashboard`：展示调用次数、token、费用、
按模型明细、最近调用，以及预算进度条。数据来自 `GET /api/metrics`。

配置费用预算，超出时终端会告警：

```json
{ "observability": { "enabled": true, "budgetUsd": 5 } }
```

## 多用户 / 团队

在 `.aicoder.json` 中配置用户的令牌、配额与工具白名单：

```json
{
  "users": [
    { "name": "alice", "token": "tok-alice", "quotaUsd": 5, "allowedTools": ["read_file", "search", "find_symbol"] },
    { "name": "bob", "token": "tok-bob", "quotaUsd": 20, "allowWrite": false }
  ]
}
```

网页端通过 `Authorization: Bearer <token>` 识别用户：

- **配额**：累计费用超出 `quotaUsd` 后拒绝新请求
- **工具白名单**：`allowedTools` 支持 `*` 通配（如 `git_*`）
- **写权限**：`allowWrite: false` 时该用户无法执行写操作
- **会话隔离**：每个用户的会话自动隔离，互不可见/删除

未配置用户时，`AICODER_TOKEN` 作为管理员令牌。

## 工具并发

一次回复中的多个只读工具调用会并发执行（上限 `AICODER_CONCURRENCY`，默认 4），
写操作与需确认的工具仍串行，结果按原始顺序返回，兼顾速度与正确性。

## VS Code 扩展

`vscode-extension/` 提供基础扩展：提问、解释选中代码、修复选中代码、打开终端、启动网页版。

```bash
cd vscode-extension
npm install
npm run compile
# 在 VS Code 中按 F5 启动扩展开发宿主
```

## 文档

开发文档见 [`docs/`](docs/README.md)：快速开始、配置参考、插件开发、架构说明。
示例见 [`examples/`](examples/)（插件与配置）。配置 JSON Schema 见 [`aicoder.schema.json`](aicoder.schema.json)
（在 `.aicoder.json` 中写 `"$schema": "./aicoder.schema.json"` 可获得编辑器提示）。

## 项目摘要与记忆

启动时自动生成仓库摘要（文件数、语言分布、关键文件、npm 脚本、依赖）并缓存到
`.aicoder/summary.md`，注入系统提示，帮助助手快速理解大仓库。可用 `AICODER_SUMMARY=false` 关闭。

## 编辑引擎

除逐个 `edit_file` 外，提供 `multi_edit` 工具对同一文件**原子性**应用多组替换：
任一处冲突（未找到或不唯一）则整体不改动，并报告冲突，避免"改一半"。

## 多模态输入

网页端支持粘贴/上传图片，随消息一起发送给支持视觉的模型。终端可通过内容块 API：

```ts
await agent.chat([
  { type: "text", text: "这张图里的报错是什么？" },
  { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
]);
```

## Web 实时交互

网页端优先使用 **WebSocket**（`/ws`）双向通道，不可用时回退 SSE：

- 工具需要授权时实时弹窗确认，无需重发请求
- 可随时点击「停止」中断当前生成
- 支持图片附件

## 配置校验与迁移

加载配置时会自动校验类型并报告问题（未知项告警、类型错误报错），并对旧版本配置
自动迁移（如顶层安全项 → `security`，`traceFile` → `observability.logFile`）。
问题与迁移信息会在终端启动时打印。

## 初始化向导

```bash
npx @191765/aicoder init
```

交互式引导生成 `.aicoder.json` 与 `.env`（模型、权限、主题、插件、LSP 等）。

## 可编程 API

网页服务提供多种调用方式，方便集成到其它系统：

```bash
# 一次性执行，返回最终文本与统计（不流式、不建会话）
curl -X POST http://localhost:8787/api/run \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"统计 src 下的文件数"}'

# 流式对话（SSE）
curl -N -X POST http://localhost:8787/api/chat \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"解释 src/agent.ts"}'

# WebSocket 实时通道（工具确认、中断）
# ws://localhost:8787/ws?token=$TOKEN
```

作为库使用：

```ts
import { loadConfig, Agent } from "@191765/aicoder";
const agent = new Agent({ config: loadConfig() });
for await (const ev of agent.chat("你好")) if (ev.type === "text") process.stdout.write(ev.delta);
```

## 日志与追踪

- 结构化日志：`AICODER_LOG_LEVEL`（debug/info/warn/error）、`AICODER_LOG_FORMAT`（text/json）
- 轻量 span 追踪：`llm.generate` 与工具执行会记录耗时，写入 trace JSONL

## 代码质量与安全

- `npm run lint`（ESLint）+ `npm run format`（Prettier）+ pre-commit（lint-staged）
- `npm run coverage`（c8，带覆盖率阈值）
- `npm run audit`（依赖漏洞扫描）+ `npm run sbom`（生成 CycloneDX SBOM）
- 安全模型与报告方式见 [SECURITY.md](SECURITY.md)

## 性能

CLI 启动做了惰性加载优化（如 `--help` 约 0.8s，较优化前约 4 倍提升）；
项目摘要与 RAG 结果带缓存，避免重复计算。

## 工作流与配方

预置常用任务，一键执行（也可在 `.aicoder/workflows/*.md` 自定义）：

```bash
aicoder workflows              # 列出
aicoder run review             # 审查改动
aicoder run test src/agent.ts  # 为文件写测试
aicoder run refactor "提取函数"
aicoder run bugfix "登录偶发失败"
aicoder run docs / explain
```

## 本地模型

```bash
aicoder doctor    # 自检：依赖、模型配置、本地服务探测
```

自动探测 Ollama（`localhost:11434`）与 LM Studio（`localhost:1234`），
未检测到时给出安装与拉取指引。

## 编辑快照与回滚

写操作前会自动保存受影响文件的快照到 `.aicoder/snapshots/`：

```bash
aicoder snapshots        # 列出快照
aicoder rollback <id>    # 回滚
```

对话中也可用 `list_snapshots` / `restore_snapshot` 工具。

## 增量索引

RAG 与符号索引支持单文件增量更新（`updateFile`/`removeFile`）与 `watch()` 监听变更，
无需每次全量重建。

## 上下文增强

检索结果会经过重排（rerank：词密度 + 文件名 + 新鲜度，并限制每文件块数），
提供代码切片与 import 依赖图 API，提升大仓库的相关性。

## 多语言 SDK

见 [`sdk/`](sdk/README.md)：Python、Go、JavaScript 零依赖客户端，调用 `/api/run` 等端点。

## 成本与延迟

- **响应缓存**：对确定性请求（相同 messages+tools+model+温度）复用结果，节省成本。
  启用 `AICODER_CACHE=true`；可选磁盘持久化（`cache.persistent`）。
- **模型降级链**：主模型不可用时按 `fallbackModels` 依次切换（未产生输出前才降级）。

```json
{
  "cache": { "enabled": true, "ttlMs": 3600000, "persistent": true },
  "fallbackModels": [{ "model": "gpt-4o-mini" }]
}
```

## 执行沙箱

```json
{
  "sandbox": { "enabled": true, "noNetwork": false, "maxOutputBytes": 20000 }
}
```

启用后，子进程只继承白名单环境变量（自动清除含 `KEY/TOKEN/SECRET` 的变量），
限制输出大小；Linux 下 `noNetwork: true` 会尝试用 `unshare -n` 断网。
生产环境仍建议整体运行在容器中（见 Dockerfile）。

## 插件市场

```bash
aicoder plugin search retrieval   # 搜索
aicoder plugin install <包名>      # 安装并写入配置
aicoder plugin list               # 已配置
aicoder plugin uninstall <包名>    # 卸载
```

约定插件包含关键字 `aicoder-plugin`。

## 评估基准

```bash
aicoder eval                 # 运行基准并检测回归
aicoder eval --baseline      # 保存当前结果为基线
```

任务可在 `.aicoder/evals/*.json` 自定义（文件断言 / 正则），自动评分并与基线对比。

## 反馈与微调

对话中可用 `submit_feedback` 工具记录赞/踩；导出训练数据：

```bash
aicoder feedback                       # 统计
aicoder feedback export sft            # 导出 SFT 数据
aicoder feedback export dpo            # 导出偏好对
```

## 多渠道接入

`POST /api/webhook` 支持 Slack / 飞书 / 钉钉 / 通用 JSON，自动识别渠道并回复。
可用 `AICODER_WEBHOOK_TOKEN` 保护。

## 安装与升级

```bash
# 一行安装（macOS / Linux）
curl -fsSL https://raw.githubusercontent.com/191765/aicoder/main/scripts/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/191765/aicoder/main/scripts/install.ps1 | iex

# 或直接
npm install -g @191765/aicoder
npx @191765/aicoder

# 检查并升级
aicoder upgrade
aicoder --version
```

## 版本发布

```bash
npm run bump patch --tag --release   # 升版本 + 打标签 + GitHub Release
npm run release:publish              # 发布到 npm
```

版本遵循语义化版本；变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 开源治理

- [LICENSE](LICENSE)（MIT）、[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)、[ROADMAP.md](ROADMAP.md)、[SECURITY.md](SECURITY.md)
- Issue / PR 模板见 `.github/`

## 匿名遥测

默认**关闭**。开启后仅发送版本、操作系统、Node 主版本、命令名、是否成功等匿名信息，
**绝不发送**代码、路径、对话内容或密钥：

```bash
aicoder telemetry          # 查看状态与将发送的数据示例
AICODER_TELEMETRY=true     # 开启
```

## 文档站点

```bash
npm run site    # 生成静态站点到 site/
```

推送到 `main` 后由 GitHub Actions 自动部署到 GitHub Pages。

## CLI 使用

```bash
npm run dev              # 交互式对话
npm run dev -- --rag     # 启动时构建代码库索引
npm run dev -- --tui     # 富交互 TUI
npm run dev -- --prompt="解释 src/agent.ts 的核心逻辑"
```

交互命令：`/exit` 退出，`/reset` 清空上下文，`/rag` 重建索引。

## Web 使用

```bash
npm run dev:web
# 浏览器访问 http://localhost:8787
```

界面左侧可开启「代码库检索 (RAG)」。出于安全考虑，**写操作（修改文件、执行命令）
默认被拦截**，需要手动勾选左侧的「允许写操作」后才会执行。

网页端**强制启用访问令牌**：若未在 `.env` 设置 `AICODER_TOKEN`，服务启动时会自动
生成一个临时令牌并打印在控制台。打开方式：

```
http://localhost:8787/?token=你的令牌
```

也可在界面左下角填入令牌（保存在浏览器 localStorage）。

## 作为库使用

```ts
import { loadConfig, Agent } from "@191765/aicoder";

const agent = new Agent({ config: loadConfig(), useRag: true });
await agent.prepareRag();

for await (const ev of agent.chat("这个项目是做什么的？")) {
  if (ev.type === "text") process.stdout.write(ev.delta);
}
```

## 生产构建

```bash
npm run build      # 输出到 dist/
npm start          # 运行 CLI
npm run start:web  # 运行 Web
```

## 发布到 npm（npx 运行）

```bash
npm login
npm publish --access public
```

发布后即可 `npx @191765/aicoder`。`prepublishOnly` 会自动清理并重新构建。

## 安全说明

- 所有文件工具都被限制在 `AICODER_WORKDIR` 之内，越界访问会被拒绝。
- `run_command` 会以当前用户权限执行任意命令，请审查后再批准。
- 建议在容器 / 虚拟机 / 专用目录中运行，不要直接指向敏感目录。
- 请勿将 `.env` 提交到版本库（已在 `.gitignore` 中忽略）。

## License

MIT
