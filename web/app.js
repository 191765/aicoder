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
};

let sessionId = localStorage.getItem("aicoder.session") || "";
let token = localStorage.getItem("aicoder.token") || "";
let busy = false;

els.tokenInput.value = token;
if (window.location.search.includes("token=")) {
  const t = new URLSearchParams(window.location.search).get("token");
  if (t) { token = t; els.tokenInput.value = t; localStorage.setItem("aicoder.token", t); }
}

function setStatus(text) { els.status.textContent = text; }

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 轻量 Markdown 渲染（代码块/行内代码/粗体/标题/列表/链接） */
function renderMarkdown(src) {
  const blocks = [];
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
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
  addUser(text);
  const asst = addAssistant();
  const toolMap = new Map();
  setStatus("思考中...");

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        message: text,
        sessionId,
        useRag: els.ragToggle.checked,
        allowWrite: els.writeToggle.checked,
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
  } catch (err) {
    asst.content.textContent += `\n[连接错误] ${err.message}`;
  } finally {
    asst.content.classList.remove("cursor");
    busy = false;
    els.send.disabled = false;
    setStatus("就绪");
    els.input.focus();
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
    case "error":
      asst.raw += `\n\n> 错误: ${ev.message}`;
      asst.content.innerHTML = renderMarkdown(asst.raw);
      break;
    case "done":
    case "end":
      setStatus("就绪");
      break;
  }
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

fetch("/api/health").then((r) => r.json()).then((d) => {
  els.modelInfo.textContent = `模型：${d.model}`;
  setStatus("就绪");
}).catch(() => {
  setStatus("无法连接服务器");
});
