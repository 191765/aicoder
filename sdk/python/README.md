# AICoder Python SDK

极简的 HTTP 客户端，调用 AICoder 服务的 `/api/run` 与 `/api/health`。

## 用法

```python
from aicoder import AICoder

client = AICoder(base_url="http://localhost:8787", token="your-token")

# 健康检查
print(client.health())

# 一次性执行任务
result = client.run("统计 src 下的 TypeScript 文件数")
print(result.ok, result.text, result.tool_calls, result.steps)
```

## 前置

先启动 AICoder 网页服务：

```bash
aicoder web
```

默认地址 `http://localhost:8787`，令牌见启动时输出或 `AICODER_TOKEN`。
