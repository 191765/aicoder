import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { setLocale, getLocale, t, SUPPORTED_LOCALES } from "../src/i18n.js";
import { currentVersion, checkUpgrade } from "../src/upgrade.js";
import { initTelemetry, telemetryEnabled, telemetrySample } from "../src/telemetry.js";
import { loadConfig } from "../src/config.js";

let pass = 0, fail = 0;
function ok(c, l) { if (c) pass++; else { fail++; console.error("FAIL:", l); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-p11-"));

// ---- i18n 多语言 ----
ok(SUPPORTED_LOCALES.length >= 5, "5 locales supported");
setLocale("ja");
ok(getLocale() === "ja", "set ja");
ok(t("web.send") === "送信", "ja translation");
setLocale("ko");
ok(t("web.stop") === "중지", "ko translation");
setLocale("es");
ok(getLocale() === "es", "set es");
setLocale("en-US");
ok(getLocale() === "en", "region fallback");
setLocale("zh");
ok(t("app.ready") === "就绪", "zh translation");
setLocale(undefined);

// ---- 版本 ----
const ver = currentVersion();
ok(/^\d+\.\d+\.\d+/.test(ver), "current version format: " + ver);
const up = await checkUpgrade();
ok(typeof up.current === "string", "upgrade check current");
ok(up.latest === null || typeof up.latest === "string", "upgrade check latest");

// ---- 遥测（默认关闭） ----
const cfg = loadConfig({ workdir: tmp });
await initTelemetry(cfg);
ok(telemetryEnabled() === false, "telemetry off by default");
const sample = telemetrySample();
ok(!("path" in sample) && !("code" in sample), "telemetry sample has no sensitive fields");
await initTelemetry(loadConfig({ workdir: tmp, telemetry: { enabled: true, endpoint: "http://localhost:1/tele" } }));
ok(telemetryEnabled() === true, "telemetry enabled via config");

// ---- 治理文件 ----
const root = process.cwd();
for (const f of ["LICENSE", "CODE_OF_CONDUCT.md", "ROADMAP.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"]) {
  ok(fs.existsSync(path.join(root, f)), `governance file ${f}`);
}
for (const f of [
  ".github/ISSUE_TEMPLATE/bug_report.md",
  ".github/ISSUE_TEMPLATE/feature_request.md",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/PULL_REQUEST_TEMPLATE.md",
]) {
  ok(fs.existsSync(path.join(root, f)), `github template ${f}`);
}

// ---- 文档站点生成 ----
const r = spawnSync(process.execPath, ["scripts/build-site.mjs"], { cwd: root, encoding: "utf8" });
ok(r.status === 0, "build-site runs");
const siteIndex = path.join(root, "site", "index.html");
ok(fs.existsSync(siteIndex), "site index generated");
if (fs.existsSync(siteIndex)) {
  const html = fs.readFileSync(siteIndex, "utf8");
  ok(html.includes("<html") && html.includes("AICoder"), "site html valid");
}

// ---- 安装脚本存在 ----
ok(fs.existsSync(path.join(root, "scripts", "install.sh")), "install.sh exists");
ok(fs.existsSync(path.join(root, "scripts", "install.ps1")), "install.ps1 exists");

// 清理
fs.rmSync(path.join(root, "site"), { recursive: true, force: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
