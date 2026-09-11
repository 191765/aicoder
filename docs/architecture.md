# 架构说明

## 分层

```
CLI/TUI/Web ──► Agent ──► Provider ──► LLM (OpenAI 兼容)
                  │
                  ├── Tools（文件/命令/搜索/git/lsp/mcp/...）
                  ├── Permissions（allow/ask/deny）
                  ├── Context（token 预算与裁剪）
                  ├── RAG（BM25 + 向量）
                  ├── Router（多模型路由）
                  ├── Subagent / Orchestrator
                  ├── Session（持久化）
                  └── Memory（项目约定）
```

## 核心循环

`Agent.chat()`：

1. 载入项目记忆 + RAG 上下文，构建系统提示
2. 按 token 预算裁剪历史（`buildContext`）
3. 调用 LLM 流式生成
4. 若返回工具调用：解析参数 → 权限决策 → 执行（只读并发、写串行）
5. 工具结果写回历史，进入下一轮，直到无工具调用或达到 `maxSteps`
6. 保存会话、记录用量

## 关键模块

| 模块 | 职责 |
| --- | --- |
| `provider.ts` | LLM 接入、流式、重试 |
| `agent.ts` | 主循环、工具调度、并发 |
| `tools.ts` | 工具注册表与内置工具 |
| `permissions.ts` | 权限规则 |
| `context.ts` | 上下文预算 |
| `rag.ts` + `embeddings.ts` | 检索 |
| `router.ts` | 多模型路由 |
| `subagent.ts` / `orchestrator.ts` | 子代理与编排 |
| `session.ts` | 会话持久化 |
| `memory.ts` / `symbols.ts` | 项目记忆与符号索引 |
| `mcp.ts` / `lsp.ts` / `git.ts` / `github.ts` | 外部集成 |
| `plugins.ts` | 插件加载 |
| `security.ts` / `observability.ts` | 安全与观测 |
| `configfile.ts` / `config.ts` | 层级配置 |

## 事件流

`Agent.chat` 产出 `AgentEvent`，UI 据此渲染：

`step` · `text` · `tool_start` · `tool_end` · `tool_denied` · `context` · `error` · `done`

Web 端通过 SSE 转发这些事件。

## 扩展点

- **工具**：`registerTool()`（内置/插件/MCP）
- **插件命令**：`PluginCommand`
- **模型路由**：`models` 配置
- **权限**：`permissions` 配置
- **MCP/LSP**：配置文件声明，启动时加载
