#!/usr/bin/env node
/**
 * 发布脚本：校验、构建、打包，可选发布到 npm。
 *
 * 用法：
 *   node scripts/release.mjs            # 校验 + 构建 + 打包预览
 *   node scripts/release.mjs --publish  # 校验 + 构建 + 发布到 npm
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", ...opts });
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
console.log(`发布 ${pkg.name}@${pkg.version}`);

const doPublish = process.argv.includes("--publish");

run("npm run typecheck");
run("npm run build");
run("npm test");
run("npm pack --dry-run");

if (doPublish) {
  run("npm publish");
  console.log("\n已发布。");
} else {
  console.log("\n校验通过。使用 --publish 正式发布。");
}
