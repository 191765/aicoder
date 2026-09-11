# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### 计划
- JetBrains 集成
- 跨仓库引用与调用图
- 团队共享会话与知识库

## [0.1.0] - 2026-09-12

首个公开版本，包含以下能力：

### 核心
- 终端 (CLI) 与网页 (Web) 双形态；富交互 TUI
- 接入任意 OpenAI 兼容 LLM，支持多模型路由、降级链与响应缓存
- Agent 多轮工具调用循环，只读工具并发执行

### 工具与集成
- 文件读写、精准编辑、批量编辑（原子）、目录/glob/正则搜索、命令执行
- Git / MCP / LSP / GitHub 工具
- 子代理（task）与并行/串行编排（parallel/pipeline）
- 插件系统与插件市场

### 智能与上下文
- 代码库检索：BM25 + 向量混合、重排、代码切片、依赖图
- 上下文预算与自动压缩；项目摘要与项目记忆
- 符号索引与跨文件引用；工作流模板

### 安全与治理
- 权限规则（allow/ask/deny）、路径沙箱
- 危险命令阻断、密钥扫描、审计日志、执行沙箱
- 多用户、配额、工具白名单、会话隔离
- 安全策略文档与 SBOM

### 观测与运维
- 结构化日志、span 追踪、用量与费用统计、监控仪表盘
- 本地模型探测与 `doctor` 自检
- 评估基准、反馈采集与微调数据导出

### 接口与生态
- Web：SSE / WebSocket、多会话、多模态、Markdown/diff 渲染
- 可编程 API：`/api/run`、`/api/webhook`（Slack/飞书/钉钉）
- 多语言 SDK：Python / Go / JavaScript
- VS Code 扩展

### 工程
- TypeScript 严格模式、ESLint/Prettier、husky、CI、Docker、SBOM、覆盖率阈值
- 完整的测试套件（单元/集成/端到端/压力）
