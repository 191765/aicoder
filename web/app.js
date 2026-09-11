const els = {
  messages: document.getElementById("messages"),
  input: document.getElementById("input"),
  composer: document.getElementById("composer"),
  send: document.getElementById("send"),
  newChat: document.getElementById("newChat"),
  ragToggle: document.getElementById("ragToggle"),
  writeToggle: document.getElementById("writeToggle"),
  status: document.getElementById("status"),
  modelInfo: document.getElementById("modelInfo"),
  tokenBox: document.getElementById("tokenBox"),
  tokenInput: document.getElementById("tokenInput"),
  saveToken: document.getElementById("saveToken"),
  sessionList: document.getElementById("sessionList"),
  usage: document.getElementById("usage"),
  stop: document.getElementById("stop"),
  fileInput: document.getElementById("fileInput"),
  attachments: document.getElementById("attachments"),
  langSelect: document.getElementById("langSelect"),
};

/* ---- 图片附件 ---- */
let pendingImages = [];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
let sseAbort = null;

els.fileInput?.addEventListener("change", async () => {
  const files = Array.from(els.fileInput.files || []);
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    if (f.size > MAX_IMAGE_BYTES) {
      setStatus(`图片过大已跳过: ${f.name}`);
      continue;
    }
    const dataUrl = await fileToDataUrl(f);
    pendingImages.push({ name: f.name, dataUrl });
  }
  els.fileInput.value = "";
  renderAttachments();
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderAttachments() {
  if (!els.attachments) return;
  els.attachments.innerHTML = "";
  pendingImages.forEach((img, i) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    const thumb = document.createElement("img");
    thumb.src = img.dataUrl;
    const x = document.createElement("button");
    x.textContent = "×";
    x.addEventListener("click", () => { pendingImages.splice(i, 1); renderAttachments(); });
    chip.appendChild(thumb);
    chip.appendChild(x);
    els.attachments.appendChild(chip);
  });
}

function clearImages() {
  pendingImages = [];
  renderAttachments();
}

/* ---- WebSocket 实时通道（不可用时回退 SSE） ---- */
let ws = null;
let wsReady = null;
let wsTurnResolve = null;
let wsAsst = null;
let wsToolMap = null;
let wsCurrentTool = null;

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function ensureSocket() {
  if (wsReady) return wsReady;
  wsReady = new Promise((resolve) => {
    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const q = token ? `?token=${encodeURIComponent(token)}` : "";
      const socket = new WebSocket(`${proto}//${location.host}/ws${q}`);
      const timer = setTimeout(() => { resolve(false); }, 3000);
      socket.onopen = () => { clearTimeout(timer); ws = socket; resolve(true); };
      socket.onerror = () => { clearTimeout(timer); resolve(false); };
      socket.onclose = () => { ws = null; wsReady = null; };
      socket.onmessage = (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch { return; }
        onWsEvent(ev);
      };
    } catch {
      resolve(false);
    }
  });
  return wsReady;
}

function onWsEvent(ev) {
  if (ev.type === "confirm") {
    const allow = window.confirm(`授权请求：${ev.question}\n\n允许执行吗？`);
    wsSend({ type: "confirm_result", id: ev.id, allow });
    return;
  }
  if (ev.type === "aborted") {
    setStatus("已中断");
    if (wsTurnResolve) { wsTurnResolve(); wsTurnResolve = null; }
    return;
  }
  if (ev.type === "end") {
    if (wsTurnResolve) { wsTurnResolve(); wsTurnResolve = null; }
    refreshSessions();
    refreshUsage();
    return;
  }
  // 转发给当前回合的渲染器
  if (wsAsst) {
    handleEvent(ev, wsAsst, wsToolMap || new Map(),
      () => wsCurrentTool, (d) => { wsCurrentTool = d; });
  }
}

let sessionId = localStorage.getItem("aicoder.session") || "";
let token = localStorage.getItem("aicoder.token") || "";
let busy = false;

/* ---- 轻量 i18n ---- */
const I18N = {
  zh: {
    newChat: "＋ 新对话", rag: "代码库检索 (RAG)", write: "允许写操作（改文件/执行命令）",
    history: "历史会话", send: "发送", ready: "就绪", stop: "停止",
    placeholder: "描述你的需求，例如：帮我修复这个 bug / 解释这段代码 / 写一个测试",
    hint: "Enter 发送 · Shift+Enter 换行 · 写操作默认拦截，需勾选「允许写操作」",
  },
  en: {
    newChat: "＋ New chat", rag: "Codebase search (RAG)", write: "Allow writes (edit files / run commands)",
    history: "History", send: "Send", ready: "Ready", stop: "Stop",
    placeholder: "Describe what you need, e.g. fix this bug / explain this code / write a test",
    hint: "Enter to send · Shift+Enter for newline · writes blocked until allowed",
  },
  ja: {
    newChat: "＋ 新しい会話", rag: "コード検索 (RAG)", write: "書き込みを許可",
    history: "履歴", send: "送信", ready: "準備完了", stop: "停止",
    placeholder: "要望を入力（例: このバグを修正 / コードを説明 / テストを書く）",
    hint: "Enter で送信 · Shift+Enter で改行 · 書き込みは許可が必要",
  },
  ko: {
    newChat: "＋ 새 대화", rag: "코드 검색 (RAG)", write: "쓰기 허용",
    history: "기록", send: "보내기", ready: "준비됨", stop: "중지",
    placeholder: "요청을 입력하세요 (예: 버그 수정 / 코드 설명 / 테스트 작성)",
    hint: "Enter 전송 · Shift+Enter 줄바꿈 · 쓰기는 허용 필요",
  },
  es: {
    newChat: "＋ Nuevo chat", rag: "Búsqueda de código (RAG)", write: "Permitir escritura",
    history: "Historial", send: "Enviar", ready: "Listo", stop: "Detener",
    placeholder: "Describe lo que necesitas, p. ej. corregir este error",
    hint: "Enter para enviar · Shift+Enter para nueva línea · escritura bloqueada",
  },
};
const SUPPORTED_LANGS = ["zh", "en", "ja", "ko", "es"];
function detectLang() {
  const saved = localStorage.getItem("aicoder.lang");
  if (saved && SUPPORTED_LANGS.includes(saved)) return saved;
  const nav = (navigator.language || "zh").toLowerCase();
  for (const l of SUPPORTED_LANGS) if (nav.startsWith(l)) return l;
  return "en";
}
let lang = detectLang();
function applyI18n() {
  const L = I18N[lang] || I18N.en;
  const q = (id) => document.getElementById(id);
  if (q("newChat")) q("newChat").textContent = L.newChat;
  if (q("ragToggle")) q("ragToggle").parentElement.querySelector("span").textContent = L.rag;
  if (q("writeToggle")) q("writeToggle").parentElement.querySelector("span").textContent = L.write;
  document.querySelectorAll(".section-title").forEach((el) => (el.textContent = L.history));
  if (q("send")) q("send").textContent = L.send;
  if (q("stop")) q("stop").textContent = L.stop;
  if (q("input")) q("input").placeholder = L.placeholder;
  const hint = document.querySelector(".hint");
  if (hint) hint.textContent = L.hint;
  if (q("langSelect")) q("langSelect").value = lang;
}

els.tokenInput.value = token;
if (window.location.search.includes("token=")) {
  const t = new URLSearchParams(window.location.search).get("token");
  if (t) { token = t; els.tokenInput.value = t; localStorage.setItem("aicoder.token", t); }
}

function setStatus(text) { els.status.textContent = text; }

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* diff 高亮：+ 绿 / - 红 / @@ 紫 */
function renderDiff(code) {
  return code.split("\n").map((line) => {
    const safe = escapeHtml(line);
    if (line.startsWith("+") && !line.startsWith("+++")) return `<span class="d-add">${safe}</span>`;
    if (line.startsWith("-") && !line.startsWith("---")) return `<span class="d-del">${safe}</span>`;
    if (line.startsWith("@@")) return `<span class="d-hunk">${safe}</span>`;
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index "))
      return `<span class="d-meta">${safe}</span>`;
    return safe;
  }).join("\n");
}

/* 轻量 Markdown 渲染（代码块/行内代码/粗体/标题/列表/链接） */
function renderMarkdown(src) {
  const blocks = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length;
    const cls = `lang-${escapeHtml(lang)}`;
    if ((lang || "").toLowerCase() === "diff") {
      blocks.push(`<pre class="diff">${renderDiff(code.replace(/\n$/, ""))}</pre>`);
    } else {
      blocks.push(`<pre><code class="${cls}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    }
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
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/^[-*] (.*)$/gm, "<li>$1</li>");
  text = text.replace(/(<li>[\s\S]*?<\/li>)/g, (m) => `<ul>${m}</ul>`);
  text = text.split(/\n{2,}/).map((p) => {
    if (/^<(h\d|ul|pre|blockquote)/.test(p.trim())) return p;
    return p.trim() ? `<p>${p.replace(/\n/g, "<br/>")}</p>` : "";
  }).join("");
  text = text.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
  return text;
}

function addUser(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="avatar">你</div><div class="body"><div class="bubble"></div></div>`;
  div.querySelector(".bubble").textContent = text;
  els.messages.appendChild(div);
  scrollDown();
}

function addAssistant() {
  const div = document.createElement("div");
  div.className = "msg assistant";
  div.innerHTML = `<div class="avatar">AI</div><div class="body"><div class="content cursor"></div></div>`;
  els.messages.appendChild(div);
  scrollDown();
  return {
    root: div,
    content: div.querySelector(".content"),
    raw: "",
  };
}

function addTool(root, name, args) {
  const details = document.createElement("details");
  details.className = "tool";
  details.innerHTML = `<summary><span class="dot"></span>调用工具 <b>${escapeHtml(name)}</b></summary><pre>${escapeHtml(args)}</pre>`;
  root.querySelector(".body").appendChild(details);
  scrollDown();
  return details;
}

function finishTool(details, ok, result) {
  details.classList.add(ok ? "ok" : "fail");
  details.querySelector("summary").innerHTML =
    `<span class="dot"></span>${ok ? "✓" : "✗"} 工具 <b>${escapeHtml(details.dataset.name || "")}</b> ${ok ? "完成" : "失败"}`;
  const pre = details.querySelector("pre");
  pre.textContent = pre.textContent + "\n\n--- 结果 ---\n" + result;
}

function scrollDown() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addNotice(root, text) {
  const div = document.createElement("div");
  div.className = "notice";
  div.textContent = text;
  root.querySelector(".body").appendChild(div);
  scrollDown();
}

async function sendMessage(text) {
  if (busy) return;
  busy = true;
  els.send.disabled = true;
  els.stop.style.display = "inline-block";
  addUser(text);
  const asst = addAssistant();
  const toolMap = new Map();
  setStatus("思考中...");

  const useWs = await ensureSocket();
  try {
    if (useWs) {
      wsAsst = asst;
      wsToolMap = toolMap;
      wsSend({
        type: "chat",
        message: text,
        sessionId,
        useRag: els.ragToggle.checked,
        allowWrite: els.writeToggle.checked,
        images: pendingImages.map((i) => ({ dataUrl: i.dataUrl })),
      });
      // 事件由 ws.onmessage 处理；这里等待完成信号
      await new Promise((resolve) => { wsTurnResolve = resolve; });
      wsAsst = null;
      wsToolMap = null;
    } else {
      await sendMessageSse(text, asst, toolMap);
    }
  } catch (err) {
    asst.content.textContent += `\n[连接错误] ${err.message}`;
  } finally {
    clearImages();
    asst.content.classList.remove("cursor");
    busy = false;
    els.send.disabled = false;
    els.stop.style.display = "none";
    setStatus("就绪");
    els.input.focus();
  }
}

async function sendMessageSse(text, asst, toolMap) {
  sseAbort = new AbortController();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: sseAbort.signal,
    body: JSON.stringify({
      message: text,
      sessionId,
      useRag: els.ragToggle.checked,
      allowWrite: els.writeToggle.checked,
      images: pendingImages.map((i) => ({ dataUrl: i.dataUrl })),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    asst.content.textContent = `请求失败: ${err.error || res.status}`;
    asst.content.classList.remove("cursor");
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentTool = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith("data:")) continue;
      let ev;
      try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
      handleEvent(ev, asst, toolMap, () => currentTool, (d) => { currentTool = d; });
    }
  }
}

function handleEvent(ev, asst, toolMap, getTool, setTool) {
  switch (ev.type) {
    case "session":
      sessionId = ev.sessionId;
      localStorage.setItem("aicoder.session", sessionId);
      break;
    case "text":
      asst.raw += ev.delta;
      asst.content.innerHTML = renderMarkdown(asst.raw);
      asst.content.classList.add("cursor");
      scrollDown();
      break;
    case "tool_start": {
      setStatus(`调用工具 ${ev.name}...`);
      const d = addTool(asst.root, ev.name, ev.args);
      d.dataset.name = ev.name;
      setTool(d);
      break;
    }
    case "tool_end": {
      const d = getTool();
      if (d) finishTool(d, ev.ok, ev.result);
      if (!ev.ok && /用户拒绝/.test(ev.result || "")) {
        addNotice(asst.root, "写操作已被拦截：请在左侧勾选「允许写操作」后重试。");
      }
      setStatus("思考中...");
      break;
    }
    case "tool_denied":
      addNotice(asst.root, `工具 ${ev.name} 被权限规则拒绝：${ev.reason}`);
      break;
    case "context":
      addNotice(asst.root, `上下文已压缩：约 ${ev.tokens} tokens，省略 ${ev.dropped} 条历史`);
      break;
    case "confirm":
      setStatus(`等待授权: ${ev.name}`);
      addNotice(asst.root, `工具 ${ev.name} 需要授权，请勾选「允许写操作」后重试。`);
      break;
    case "history":
      renderHistory(ev.messages || []);
      break;
    case "error":
      asst.raw += `\n\n> 错误: ${ev.message}`;
      asst.content.innerHTML = renderMarkdown(asst.raw);
      break;
    case "done":
    case "end":
      setStatus("就绪");
      refreshSessions();
      refreshUsage();
      break;
  }
}

/* ---- 历史渲染 ---- */
function renderHistory(messages) {
  els.messages.innerHTML = "";
  for (const m of messages) {
    if (m.role === "user") {
      addUser(m.content || "");
    } else if (m.role === "assistant" && m.content) {
      const a = addAssistant();
      a.raw = m.content;
      a.content.innerHTML = renderMarkdown(m.content);
      a.content.classList.remove("cursor");
    }
  }
  scrollDown();
}

/* ---- 会话列表 ---- */
async function refreshSessions() {
  try {
    const res = await fetch("/api/sessions", { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    els.sessionList.innerHTML = "";
    for (const s of data.sessions || []) {
      const item = document.createElement("div");
      item.className = "session-item" + (s.id === sessionId ? " active" : "");
      const when = new Date(s.updatedAt).toLocaleString();
      item.innerHTML = `<div class="s-title"></div><div class="s-meta">${s.messageCount} 条 · ${when}</div>`;
      item.querySelector(".s-title").textContent = s.title || s.id;
      item.title = s.id;
      item.addEventListener("click", () => resumeSession(s.id));
      const del = document.createElement("button");
      del.className = "s-del";
      del.textContent = "×";
      del.title = "删除";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await fetch("/api/sessions?id=" + encodeURIComponent(s.id), {
          method: "DELETE",
          headers: authHeaders(),
        });
        if (s.id === sessionId) {
          sessionId = "";
          localStorage.removeItem("aicoder.session");
          els.messages.innerHTML = "";
        }
        refreshSessions();
      });
      item.appendChild(del);
      els.sessionList.appendChild(item);
    }
  } catch {
    /* 忽略 */
  }
}

async function resumeSession(id) {
  if (busy) return;
  sessionId = id;
  localStorage.setItem("aicoder.session", id);
  els.messages.innerHTML = "";
  try {
    const res = await fetch("/api/sessions/" + encodeURIComponent(id), {
      headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      renderHistory(data.session?.messages || []);
    }
  } catch {
    /* 忽略 */
  }
  setStatus("已恢复会话");
  refreshSessions();
}

/* ---- 用量 ---- */
async function refreshUsage() {
  try {
    const res = await fetch("/api/usage", { headers: authHeaders() });
    if (!res.ok) return;
    const u = await res.json();
    if (!u.calls) { els.usage.textContent = ""; return; }
    els.usage.textContent = `用量：${u.calls} 次 · ${u.totalTokens} tokens · $${u.costUsd.toFixed(4)}`;
  } catch {
    /* 忽略 */
  }
}

function authHeaders() {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

els.composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || busy) return;
  els.input.value = "";
  els.input.style.height = "auto";
  sendMessage(text);
});

els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});

els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + "px";
});

els.newChat.addEventListener("click", () => {
  sessionId = "";
  localStorage.removeItem("aicoder.session");
  els.messages.innerHTML = "";
  setStatus("已开始新对话");
});

els.saveToken.addEventListener("click", () => {
  token = els.tokenInput.value.trim();
  localStorage.setItem("aicoder.token", token);
  setStatus("令牌已保存");
});

els.stop?.addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend({ type: "abort" });
  }
  if (sseAbort) sseAbort.abort();
  setStatus("已请求中断");
});

els.langSelect?.addEventListener("change", () => {
  lang = els.langSelect.value;
  localStorage.setItem("aicoder.lang", lang);
  applyI18n();
  setStatus((I18N[lang] || I18N.en).ready);
});

fetch("/api/health").then((r) => r.json()).then((d) => {
  els.modelInfo.textContent = `模型：${d.model}`;
  setStatus("就绪");
  applyI18n();
  refreshSessions();
  refreshUsage();
}).catch(() => {
  setStatus("无法连接服务器");
});
