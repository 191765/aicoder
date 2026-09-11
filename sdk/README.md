# AICoder SDK

多语言客户端，调用 AICoder 网页服务的 HTTP API。

| 语言 | 目录 | 说明 |
| --- | --- | --- |
| Python | [`python/`](python/) | 零依赖（标准库 urllib） |
| Go | [`go/`](go/) | 零依赖（标准库 net/http） |
| JavaScript | [`js/`](js/) | 零依赖（fetch） |

## 前置

启动服务：

```bash
aicoder web
```

默认 `http://localhost:8787`，访问令牌见启动时输出或 `AICODER_TOKEN`。

## 可用端点

| 端点 | 说明 |
| --- | --- |
| `POST /api/run` | 一次性执行，返回文本与统计 |
| `POST /api/chat` | 流式对话（SSE） |
| `GET /api/health` | 健康检查 |
| `GET /api/metrics` | 用量指标 |
| `GET /api/sessions` | 会话列表 |
| `WS /ws` | WebSocket 实时通道 |
