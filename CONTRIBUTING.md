# 贡献指南

感谢你愿意为 AICoder 贡献！以下是开发约定。

## 开发环境

```bash
git clone https://github.com/191765/aicoder.git
cd aicoder
npm install        # 会自动安装 husky pre-commit 钩子
npm run build
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 以 tsx 运行 CLI |
| `npm run build` | 编译到 `dist/` |
| `npm test` | 运行全部测试 |
| `npm run coverage` | 覆盖率报告（含阈值检查） |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` | Prettier |
| `npm run typecheck` | 类型检查 |
| `npm run schema` | 重新生成 aicoder.schema.json |

## 提交规范

- 提交信息用祈使句，简洁描述变更（可用中文或英文）。
- pre-commit 会对暂存的 `src/**/*.ts` 运行 ESLint + Prettier。
- 提交前请确保 `npm run typecheck` 与 `npm test` 通过。

## 代码约定

- TypeScript 严格模式；避免 `any`。
- 新功能请配套测试（`test/` 目录），并接入 `npm test`。
- 新增配置项需在 `src/config-schema.ts` 中登记并更新文档。
- 涉及写操作/执行的工具需正确标记 `mutating`，走权限体系。
- 不要提交密钥；`.env` 已被忽略。

## 分支与 PR

- 从 `main` 拉分支，命名如 `feat/xxx`、`fix/xxx`。
- PR 描述请说明动机、改动点与验证方式。
- CI 需通过 lint、typecheck、build、test、coverage 与 audit。

## 安全问题

请勿在公开 issue 中披露漏洞，参见 [SECURITY.md](../SECURITY.md)。
