# AICoder for VS Code

在 VS Code 中使用 [AICoder](https://github.com/191765/aicoder) 开源 AI 编程助手。

## 功能

- **AICoder: 提问** — 输入问题，在终端中调用 AICoder
- **AICoder: 解释选中代码** — 解释编辑器里选中的代码
- **AICoder: 修复选中代码** — 检查并修复选中的代码
- **AICoder: 打开终端对话** — 打开交互式终端
- **AICoder: 启动网页版** — 启动 Web UI

## 要求

- VS Code 1.80+
- 可用的 `aicoder` 命令（`npx @191765/aicoder` 或全局安装）
- 已配置 `.env`（`AICODER_API_KEY` / `AICODER_BASE_URL` / `AICODER_MODEL`）

## 配置

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| `aicoder.command` | 启动命令 | `npx @191765/aicoder` |
| `aicoder.useTui` | 终端对话使用富交互 TUI | `false` |

## 开发

```bash
npm install
npm run compile
# 在 VS Code 中按 F5 启动扩展开发宿主
```
