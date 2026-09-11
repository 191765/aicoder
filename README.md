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
代码块中的 diff 会高亮显示（`+` 绿 / `-` 红 / `@@` 紫）。

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
