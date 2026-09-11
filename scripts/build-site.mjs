#!/usr/bin/env node
/**
 * 生成文档站点到 site/ 目录（供 GitHub Pages 部署）。
 * 轻量：把 docs/*.md 与根目录 README/CHANGELOG 渲染为带导航的 HTML。
 */
import fs from "node:fs";
import path from "node:path";

const OUT = "site";

const pages = [
  { src: "README.md", out: "index.html", title: "首页" },
  { src: "docs/getting-started.md", out: "getting-started.html", title: "快速开始" },
  { src: "docs/configuration.md", out: "configuration.html", title: "配置参考" },
  { src: "docs/plugins.md", out: "plugins.html", title: "插件开发" },
  { src: "docs/architecture.md", out: "architecture.html", title: "架构说明" },
  { src: "ROADMAP.md", out: "roadmap.html", title: "路线图" },
  { src: "CHANGELOG.md", out: "changelog.html", title: "更新日志" },
  { src: "CONTRIBUTING.md", out: "contributing.html", title: "贡献指南" },
  { src: "SECURITY.md", out: "security.html", title: "安全策略" },
];

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 极简 Markdown -> HTML（标题/列表/代码/链接/粗体/段落） */
function renderMarkdown(md) {
  const blocks = [];
  let text = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre><code data-lang="${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000BLOCK${i}\u0000`;
  });
  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  text = text.replace(/^###### (.*)$/gm, "<h6>$1</h6>")
    .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, href) => {
    const h = href.endsWith(".md") ? href.replace(/^.*\//, "").replace(".md", ".html") : href;
    return `<a href="${h}">${t}</a>`;
  });
  text = text.replace(/^[-*] (.*)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>[\s\S]*?<\/li>)/g, (m) => `<ul>${m}</ul>`);
  text = text.split(/\n{2,}/).map((p) => {
    if (/^<(h\d|ul|pre|blockquote)/.test(p.trim())) return p;
    return p.trim() ? `<p>${p.replace(/\n/g, "<br/>")}</p>` : "";
  }).join("");
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return text;
}

const nav = pages
  .map((p) => `<a href="/${p.out}">${p.title}</a>`)
  .join("\n      ");

function layout(title, body) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} · AICoder</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#2d333b; --text:#e6edf3; --muted:#8b949e; --accent:#2f81f7; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; line-height:1.7; }
  header { background:var(--panel); border-bottom:1px solid var(--border); padding:14px 24px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; position:sticky; top:0; }
  header .brand { font-weight:700; color:var(--accent); font-family:ui-monospace,monospace; }
  header nav a { color:var(--muted); text-decoration:none; font-size:14px; margin-right:12px; }
  header nav a:hover { color:var(--text); }
  main { max-width:820px; margin:0 auto; padding:32px 24px 80px; }
  h1,h2,h3 { line-height:1.3; }
  h1 { border-bottom:1px solid var(--border); padding-bottom:12px; }
  a { color:var(--accent); }
  pre { background:#0b1120; border:1px solid var(--border); padding:14px; border-radius:8px; overflow:auto; }
  code { font-family:ui-monospace,Consolas,monospace; background:#0b1120; padding:2px 5px; border-radius:4px; font-size:13px; }
  pre code { background:none; padding:0; }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th,td { border:1px solid var(--border); padding:8px 10px; text-align:left; }
  th { background:var(--panel); }
  ul { padding-left:22px; }
</style>
</head>
<body>
<header>
  <span class="brand">&lt;/&gt; AICoder</span>
  <nav>
      ${nav}
  </nav>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

fs.mkdirSync(OUT, { recursive: true });
let count = 0;
for (const p of pages) {
  if (!fs.existsSync(p.src)) {
    console.warn(`跳过（不存在）: ${p.src}`);
    continue;
  }
  const md = fs.readFileSync(p.src, "utf8");
  const html = layout(p.title, renderMarkdown(md));
  fs.writeFileSync(path.join(OUT, p.out), html, "utf8");
  count++;
}
console.log(`已生成 ${count} 个页面到 ${OUT}/`);
