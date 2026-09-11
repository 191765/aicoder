#!/usr/bin/env node
/**
 * 生成 SBOM（软件物料清单），CycloneDX 风格的精简 JSON。
 * 用法：node scripts/sbom.mjs [输出文件]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lockPath = "package-lock.json";
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));

const components = [];
for (const [name, info] of Object.entries(lock.packages || {})) {
  if (!name || name === "") continue; // 根包
  const cleanName = name.replace(/^node_modules\//, "").replace(/^.*node_modules\//, "");
  if (!info?.version) continue;
  components.push({
    type: "library",
    name: cleanName,
    version: info.version,
    purl: `pkg:npm/${cleanName}@${info.version}`,
  });
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${crypto.randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: pkg.name,
      version: pkg.version,
      purl: `pkg:npm/${pkg.name}@${pkg.version}`,
    },
  },
  components,
};

const out = process.argv[2] || "sbom.json";
fs.writeFileSync(out, JSON.stringify(bom, null, 2) + "\n", "utf8");
console.log(`已生成 ${out}（${components.length} 个组件）`);
