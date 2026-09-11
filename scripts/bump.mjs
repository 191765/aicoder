#!/usr/bin/env node
/**
 * 版本发布脚本
 *
 * 用法：
 *   node scripts/bump.mjs patch|minor|major [--tag] [--release]
 *
 * 行为：
 *   1. 计算并写入新版本到 package.json
 *   2. 在 CHANGELOG.md 的 [Unreleased] 下插入新版本小节
 *   3. --tag      ：git commit + tag v<version>
 *   4. --release  ：在 --tag 基础上用 gh 创建 GitHub Release
 */
import fs from "node:fs";
import { execSync } from "node:child_process";

const args = process.argv.slice(2);
const level = args.find((a) => ["patch", "minor", "major"].includes(a));
const doTag = args.includes("--tag");
const doRelease = args.includes("--release");

if (!level) {
  console.error("用法: node scripts/bump.mjs patch|minor|major [--tag] [--release]");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const [major, minor, patch] = pkg.version.split(".").map(Number);
let next;
if (level === "major") next = `${major + 1}.0.0`;
else if (level === "minor") next = `${major}.${minor + 1}.0`;
else next = `${major}.${minor}.${patch + 1}`;

console.log(`版本: ${pkg.version} -> ${next}`);
pkg.version = next;
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n", "utf8");

// 更新 CHANGELOG
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
const date = new Date().toISOString().slice(0, 10);
const marker = "## [Unreleased]";
const idx = changelog.indexOf(marker);
if (idx >= 0) {
  const insertAt = idx + marker.length;
  const section = `\n\n## [${next}] - ${date}\n\n### 变更\n\n- 详见提交历史\n`;
  const updated = changelog.slice(0, insertAt) + section + changelog.slice(insertAt);
  fs.writeFileSync("CHANGELOG.md", updated, "utf8");
  console.log("已更新 CHANGELOG.md");
} else {
  console.warn("未找到 [Unreleased] 段，跳过 CHANGELOG 更新");
}

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

if (doTag) {
  run("npm run typecheck");
  run("npm run build");
  run("npm test");
  run(`git add package.json CHANGELOG.md`);
  run(`git commit -m "chore(release): v${next}"`);
  run(`git tag v${next}`);
  console.log(`已创建标签 v${next}（尚未推送）`);
}

if (doRelease) {
  run(`git push && git push origin v${next}`);
  run(`gh release create v${next} --title "v${next}" --notes-from-tag`);
  console.log(`已创建 GitHub Release v${next}`);
}

if (!doTag && !doRelease) {
  console.log("未加 --tag，仅修改了版本号与 CHANGELOG。");
}
