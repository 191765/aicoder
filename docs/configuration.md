# 配置参考

配置按优先级从低到高合并：

1. 全局 `~/.config/aicoder/aicoder.json`（Windows: `%APPDATA%/aicoder/aicoder.json`）
2. 项目 `<工作目录>/.aicoder.json`
3. 环境变量 / 运行时覆盖

合并规则：对象深合并，数组拼接（如 `permissions`）。

## 完整示例

```json
{
  "model": "deepseek-chat",
  "baseURL": "https://api.deepseek.com/v1",
  "temperature": 0.2,
  "maxTokens": 4096,
  "maxSteps": 25,
  "autoApprove": false,

  "permissions": {
    "allow": ["read_file", "list_dir", "glob", "search"],
    "ask": ["write_file", "edit_file", "run_command"],
    "deny": ["run_command(rm -rf|format )"]
  },

  "context": {
    "maxContextTokens": 65536,
    "reserveForOutput": 4096,
    "keepRecentMessages": 10,
    "toolResultMaxChars": 4000
  },

  "models": [
    { "match": { "input": "重构|架构" }, "model": "gpt-4o" },
    { "model": "deepseek-chat" }
  ],

  "embeddings": { "enabled": true, "model": "text-embedding-3-small", "weight": 0.5 },

  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
  },

  "lspServers": {
    "typescript": { "command": "typescript-language-server", "args": ["--stdio"] }
  },

  "plugins": ["./plugins/my-plugin.mjs"],

  "security": {
    "secretScan": true,
    "redactSecrets": false,
    "blockedCommands": ["\\bgit\\s+push\\s+--force"],
    "auditLog": ".aicoder-audit.log"
  },

  "observability": {
    "enabled": true,
    "logFile": ".aicoder-trace.log",
    "budgetUsd": 5,
    "pricing": { "my-model": { "input": 0.001, "output": 0.002 } }
  },

  "retry": { "maxRetries": 3, "baseDelayMs": 500 },

  "ui": { "theme": "dark", "rich": true, "locale": "zh" },

  "github": { "owner": "191765", "repo": "aicoder" }
}
```

## 环境变量速查

| 变量 | 说明 |
| --- | --- |
| `AICODER_API_KEY` / `AICODER_BASE_URL` / `AICODER_MODEL` | 模型接入 |
| `AICODER_WORKDIR` | 工作目录 |
| `AICODER_AUTO_APPROVE` | 自动批准写操作 |
| `AICODER_PERMISSIONS` | 权限规则（`;` 分隔） |
| `AICODER_MAX_CONTEXT_TOKENS` / `AICODER_KEEP_RECENT` | 上下文预算 |
| `AICODER_EMBEDDINGS` / `AICODER_EMBEDDING_MODEL` | 向量检索 |
| `AICODER_PLUGINS` | 插件列表 |
| `AICODER_SECRET_SCAN` / `AICODER_AUDIT_LOG` | 安全 |
| `AICODER_USAGE` / `AICODER_TRACE_FILE` | 观测 |
| `AICODER_MAX_RETRIES` / `AICODER_RETRY_DELAY_MS` / `AICODER_TOOL_TIMEOUT_MS` | 稳定性 |
| `AICODER_CONCURRENCY` | 只读工具并发上限 |
| `AICODER_LANG` | 语言 `zh` / `en` |
| `AICODER_TOKEN` | 网页访问令牌 |
| `GITHUB_TOKEN` / `AICODER_GITHUB_OWNER` / `AICODER_GITHUB_REPO` | GitHub 集成 |
