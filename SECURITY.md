# 安全策略

## 报告漏洞

如发现安全漏洞，请**不要**公开提交 issue，而是通过以下方式私下报告：

- 发送邮件至维护者（见仓库 commit 历史）
- 或使用 GitHub 的 [Private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)

我们会在收到后尽快确认并修复。

## 安全模型与边界

AICoder 是一个会读写文件、执行命令的 AI Agent，理解其安全边界很重要：

1. **路径沙箱**：所有文件工具被限制在 `AICODER_WORKDIR` 内，越界访问会被拒绝。
2. **权限规则**：`allow` / `ask` / `deny` 三类规则，`deny` 优先级最高且不受自动批准影响。
3. **危险命令阻断**：`run_command` 执行前有硬性黑名单（`rm -rf /`、`mkfs`、fork 炸弹等），
   即使权限放行也会拦截。
4. **密钥防泄露**：写入文件前扫描密钥特征，命中默认拒绝（可配置为脱敏）。
5. **审计日志**：可配置 `security.auditLog`，记录所有写操作与命令。
6. **Web 访问控制**：网页端强制令牌；多用户模式下支持配额、工具白名单与写权限。

## 运行建议

- 在容器 / 虚拟机 / 专用目录中运行，不要直接指向敏感目录。
- 不要把 `.env`、令牌、密钥提交到版本库（已在 `.gitignore` 中忽略）。
- 生产/团队使用时务必设置 `AICODER_TOKEN`，并为每个用户分配独立令牌。
- 对不受信任的模型输出保持警惕：写操作默认需确认，请审查后再批准。
- 使用 `AICODER_AUTO_APPROVE=true` 会跳过所有确认，仅在完全受控环境中使用。

## 供应链

- 依赖数量极少（核心仅 `openai`、`dotenv`；`ws` 用于实时通道）。
- CI 运行 `npm audit`，可生成 SBOM：`node scripts/sbom.mjs`。

## 支持版本

仅对最新发布版本提供安全更新。
