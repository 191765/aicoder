# AICoder 安装脚本（Windows PowerShell）
# 用法: irm https://raw.githubusercontent.com/191765/aicoder/main/scripts/install.ps1 | iex
$ErrorActionPreference = "Stop"
$pkg = "@191765/aicoder"

Write-Host "AICoder 安装脚本" -ForegroundColor Cyan

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "错误: 未检测到 Node.js (>=18)。请先安装: https://nodejs.org" -ForegroundColor Red
  exit 1
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) {
  Write-Host "错误: Node.js 版本过低（当前 $(node -v)），需要 >=18。" -ForegroundColor Red
  exit 1
}

if (Get-Command npm -ErrorAction SilentlyContinue) {
  Write-Host "使用 npm 全局安装 $pkg ..."
  npm install -g $pkg
  Write-Host "完成！运行 'aicoder --help' 开始使用。" -ForegroundColor Green
} else {
  Write-Host "使用 npx 运行（无需安装）:"
  Write-Host "  npx $pkg"
}
