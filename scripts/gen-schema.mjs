#!/usr/bin/env node
/** 生成 aicoder.schema.json（从 src/config-schema.ts） */
import fs from "node:fs";
import path from "node:path";
import { configJsonSchema } from "../dist/config-schema.js";

const out = path.resolve("aicoder.schema.json");
fs.writeFileSync(out, JSON.stringify(configJsonSchema(), null, 2) + "\n", "utf8");
console.log(`已写入 ${out}`);
