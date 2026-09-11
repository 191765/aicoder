# 快速开始

## 安装

```bash
# 从 npm（发布后）
npx @191765/aicoder

# 或从源码
git clone https://github.com/191765/aicoder.git
cd aicoder
npm install
npm run build
```

## 配置模型

复制 `.env.example` 为 `.env`，填入任意 OpenAI 兼容接口：

```dotenv
AICODER_API_KEY=sk-xxxx
AICODER_BASE_URL=https://api.openai.com/v1
AICODER_MODEL=gpt-4o-mini
```

常见服务：

| 服务 | BASE_URL | MODEL |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 通义 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5-coder` |

## 三种运行形态

```bash
# 1. 终端对话
npx @191765/aicoder

# 2. 富交互 TUI
npx @191765/aicoder --tui

# 3. 网页版
npx @191765/aicoder web
# 打开 http://localhost:8787/?token=控制台打印的令牌
```

## 常用命令

```bash
aicoder --rag               # 启动时构建代码索引
aicoder --resume            # 恢复最近会话
aicoder sessions            # 列出会话
aicoder rag                 # 仅构建索引
aicoder web                 # 网页版
```

对话中的斜杠命令：`/exit`、`/reset`、`/new`、`/rag`、`/save`、`/sessions`、`/delete <id>`。
