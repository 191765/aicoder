# AICoder · 开源 AI 编程助手

一个开源的 AI 编程助手，同时提供 **终端 (CLI)** 与 **网页 (Web)** 两种运行形态。
接入任意 OpenAI 兼容的 LLM（OpenAI / DeepSeek / Moonshot / 通义 / 本地 Ollama 等），
具备读取与修改文件、执行命令、代码库检索（RAG）等 Agent 能力。

## 特性

- 🖥️ **双形态**：终端交互式 CLI + 浏览器 Web UI（SSE 流式输出）
- 🔌 **任意模型**：任何兼容 `/chat/completions` 的服务都可接入
- 🛠️ **工具调用 Agent**：读文件、写文件、精准编辑、列目录、glob、正则搜索、执行命令
- 🔎 **代码库检索 (RAG)**：内置中英文 BM25 关键词检索，无需外部向量数据库
- 🔐 **安全可控**：路径沙箱限制在工作目录内；写操作默认需确认；Web 端可用令牌保护
- 📦 **零重型依赖**：核心仅依赖 `openai`、`dotenv`

## 目录结构

```
src/
  cli.ts       终端界面
  server.ts    网页服务 (HTTP + SSE)
  agent.ts     Agent 核心循环（多轮工具调用）
  provider.ts  LLM Provider（OpenAI 兼容，流式）
  tools.ts     工具系统（文件/命令/搜索）
  rag.ts       代码库检索索引
  config.ts    配置加载
  types.ts     类型定义
web/           网页前端
```

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

## CLI 使用

```bash
npm run dev              # 交互式对话
npm run dev -- --rag     # 启动时构建代码库索引
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
