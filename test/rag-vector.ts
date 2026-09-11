import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../src/config.js";
import { CodeIndex } from "../src/rag.js";
import { cosineSimilarity } from "../src/embeddings.js";

// mock /embeddings：用简单词袋向量，保证 apple 与 apple 相似
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { input } = JSON.parse(body);
    const texts = Array.isArray(input) ? input : [input];
    const data = texts.map((t, i) => ({
      object: "embedding",
      index: i,
      embedding: vecFor(t),
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data, model: "mock-embed" }));
  });
});
function vecFor(text) {
  const v = [0, 0, 0, 0];
  const words = ["apple", "banana", "函数", "文件"];
  for (const w of words) if (text.includes(w)) v[words.indexOf(w)] = 1;
  if (!v.some((x) => x)) v[3] = 0.01;
  return v;
}

await new Promise((r) => mock.listen(9914, () => r()));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aicoder-rag-"));
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(tmp, "src", "a.ts"), "export const apple = () => 1;\n".repeat(20));
fs.writeFileSync(path.join(tmp, "src", "b.ts"), "export const banana = () => 2;\n".repeat(20));
fs.writeFileSync(path.join(tmp, "src", "c.ts"), "export const cherry = () => 3;\n".repeat(20));

const cfg = loadConfig({
  workdir: tmp,
  apiKey: "t",
  baseURL: "http://localhost:9914/v1",
  embeddings: { enabled: true, model: "mock-embed", weight: 0.5 },
});

const idx = new CodeIndex(cfg);
console.log("vectorEnabled:", idx.vectorEnabled);
const n = await idx.build();
console.log("chunks:", n);

const hits = await idx.searchAsync("apple", 3);
console.log("hits:", hits.map((h) => `${h.file}:${h.via}`).join(", "));
const ctx = await idx.formatContextAsync("apple", 3);
console.log("context has a.ts:", ctx.includes("a.ts"));
console.log("top hit:", hits[0]?.file);

// cosine 自检
console.log("cosine identical:", cosineSimilarity([1,0],[1,0]).toFixed(2));
console.log("cosine orthogonal:", cosineSimilarity([1,0],[0,1]).toFixed(2));

mock.close();
fs.rmSync(tmp, { recursive: true, force: true });

if (hits[0]?.file !== "src/a.ts") process.exit(1);
