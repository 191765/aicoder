#!/usr/bin/env sh
# AICoder 安装脚本（Unix）
# 用法: curl -fsSL https://raw.githubusercontent.com/191765/aicoder/main/scripts/install.sh | sh
set -e

PKG="@191765/aicoder"

echo "AICoder 安装脚本"

if ! command -v node >/dev/null 2>&1; then
  echo "错误: 未检测到 Node.js (>=18)。请先安装: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "错误: Node.js 版本过低（当前 $(node -v)），需要 >=18。" >&2
  exit 1
fi

if command -v npm >/dev/null 2>&1; then
  echo "使用 npm 全局安装 $PKG ..."
  npm install -g "$PKG"
  echo "完成！运行 'aicoder --help' 开始使用。"
else
  echo "使用 npx 运行（无需安装）:"
  echo "  npx $PKG"
fi
