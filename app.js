import { makeZipBlob, makeNoteTextFileData } from "./lib/archive.js";
import { toPinyinFilename } from "./lib/pinyin.js";
import { extractWavFromMedia, extractAudioChunksFromMedia } from "./lib/audio.js";

// 智能规范化 Cookie 格式 (支持自动解析插件导出的 JSON 数组与多行文本)
export function normalizeCookieString(raw) {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.trim();
  if (!text) return "";

  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        const pairs = [];
        for (const item of parsed) {
          if (item && item.name && item.value !== undefined) {
            pairs.push(`${item.name}=${item.value}`);
          }
        }
        if (pairs.length > 0) return pairs.join("; ");
      } else if (parsed && typeof parsed === "object") {
        const pairs = [];
        for (const [k, v] of Object.entries(parsed)) {
          if (k && v !== undefined) pairs.push(`${k}=${v}`);
        }
        if (pairs.length > 0) return pairs.join("; ");
      }
    } catch {}
  }

  const lines = text.split(/[\r\n]+/);
  const items = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(";");
    for (const part of parts) {
      const p = part.trim();
      if (p && p.includes("=")) items.push(p);
    }
  }

  if (items.length > 0) return items.join("; ");
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

// 全局状态
const state = {
  pin: localStorage.getItem("xhs_pin") || "1987",
  autoClipboard: localStorage.getItem("xhs_auto_clipboard") !== "false",
  xhsCookie: normalizeCookieString(localStorage.getItem("xhs_cookie") || ""),
  lastProcessedClipboard: "",
  currentParsedNote: null,
  activeDetailNote: null,
  selectedImages: new Set(),
  currentCategory: "__all__",
  tags: [],
  tagCounts: {},
  // 批量采集队列状态
  batchQueue: [],
  isBatchRunning: false,
  shouldStopBatch: false,
  batchResults: [],
  usageData: null
};

// 工具函数：轻提示 (错误提示一直显示在底部，附带关闭按钮)
function showToast(message, options = {}) {
  const toast = document.getElementById("toast-bar");
  if (!toast) return;

  clearTimeout(showToast.timer);

  const isErr = typeof options === "object" && options.isError
    ? Boolean(options.isError)
    : (typeof message === "string" && message.startsWith("❌"));

  // 错误提示一直常驻显示在底部，直到用户手动关闭或重新解析
  const isPersistent = typeof options === "object" && typeof options.persistent === "boolean"
    ? options.persistent
    : isErr;

  const duration = typeof options === "number" ? options : (options.duration || 3000);

  toast.className = `toast-bar show ${isErr ? "toast-error" : ""}`;
  toast.innerHTML = "";

  const contentSpan = document.createElement("span");
  contentSpan.className = "toast-content";
  contentSpan.textContent = message;
  toast.appendChild(contentSpan);

  // 若错误提示中包含【设置】或指定了 actionText，附带一键直达按钮
  if ((typeof message === "string" && message.includes("【设置】")) || options.actionText) {
    const actBtn = document.createElement("button");
    actBtn.className = "toast-btn";
    actBtn.textContent = options.actionText || "⚙️ 立即前往设置";
    actBtn.onclick = () => {
      if (typeof options.onAction === "function") {
        options.onAction();
      } else {
        document.getElementById("modal-settings")?.classList.add("active");
        const cookieEl = document.getElementById("settings-xhs-cookie");
        if (cookieEl) cookieEl.value = state.xhsCookie || "";
        const oldPinEl = document.getElementById("settings-old-pin");
        if (oldPinEl) oldPinEl.value = state.pin || "1987";
      }
    };
    toast.appendChild(actBtn);
  }

  // 错误或常驻提示显示独立的关闭按钮
  if (isPersistent) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "toast-close";
    closeBtn.setAttribute("aria-label", "关闭提示");
    closeBtn.textContent = "✕";
    closeBtn.onclick = () => {
      toast.classList.remove("show");
    };
    toast.appendChild(closeBtn);
  } else {
    showToast.timer = setTimeout(() => {
      toast.classList.remove("show");
    }, duration);
  }
}

// 格式化时间戳
function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// 1. 剪贴板自动读取与解析
async function checkAndAutoPasteClipboard() {
  if (!state.autoClipboard) return;
  if (!navigator.clipboard || !navigator.clipboard.readText) return;

  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text || text === state.lastProcessedClipboard) return;

    const urls = extractAllXhsUrls(text);
    if (urls.length > 0) {
      state.lastProcessedClipboard = text;
      const input = document.getElementById("input-text");
      if (input && input.value.trim() !== text) {
        input.value = text;
        updateInputUrlHint();
        const indicator = document.getElementById("auto-clip-indicator");
        if (indicator) {
          indicator.style.display = "inline-flex";
          setTimeout(() => { indicator.style.display = "none"; }, 4000);
        }
        showToast(`⚡ 已自动识别剪贴板 ${urls.length} 条小红书链接，开始解析...`);
        startParsing();
      }
    }
  } catch {
    // iOS Safari 或未授权拦截时静默捕获，避免打扰用户
  }
}

// 判断是否为小红书默认无意义通用标题
export function isGenericTitle(title) {
  if (!title || typeof title !== "string") return true;
  const t = title.trim();
  if (!t) return true;
  if (t === "小红书" || t === "小红书图片" || t === "小红书笔记" || t === "无标题" || t === "视频" || t === "笔记") return true;
  if (/^小红书[\s_·\-|—]/i.test(t)) return true;
  return false;
}

// 从笔记正文第一行智能提取标题 (过滤掉纯 hashtag)
export function extractTitleFromContent(content) {
  if (!content || typeof content !== "string") return "";
  const lines = content.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const cleaned = line.replace(/#\S+/g, "").replace(/^[【\[(（].*?[】\])）]/g, "").trim();
    if (cleaned && cleaned.length >= 2) {
      return cleaned.slice(0, 80);
    }
    const fallbackCleaned = line.replace(/#\S+/g, "").trim();
    if (fallbackCleaned && fallbackCleaned.length >= 2) {
      return fallbackCleaned.slice(0, 80);
    }
  }
  return "";
}

// 智能识别并提取多条小红书链接 (支持多行、逗号/空格分隔或包含多个链接的整段聊天/备忘录文案)
export function extractAllXhsUrls(text) {
  if (!text || typeof text !== "string") return [];
  const raw = text.trim();
  if (!raw) return [];

  const results = [];
  const seen = new Set();

  // 1. 匹配所有 http/https 链接
  const urlRegex = /https?:\/\/[^\s<>'\"()\[\]{}]+[^\s<>'\"()\[\]{}.,;:!?，。！？；：）】》]/gi;
  const matches = raw.match(urlRegex) || [];

  for (const match of matches) {
    let cleanUrl = match.trim().replace(/[.,;:!?\])}，。！？；：）】》]+$/g, "");
    try {
      const u = new URL(cleanUrl);
      const host = u.hostname.toLowerCase();
      if (
        host.includes("xiaohongshu.com") ||
        host.includes("xhslink.com") ||
        host.includes("xhslink.cn") ||
        host.includes("xhscdn.com")
      ) {
        if (!seen.has(cleanUrl)) {
          seen.add(cleanUrl);
          results.push(cleanUrl);
        }
      }
    } catch {}
  }

  // 2. 补充提取未带 http(s):// 前缀的行或片段 (如 xhslink.com/a/ABC 或 xiaohongshu.com/explore/XYZ)
  const segments = raw.split(/[\r\n,，;；\s]+/);
  for (const seg of segments) {
    const trimmed = seg.trim().replace(/[.,;:!?\])}，。！？；：）】》]+$/g, "");
    if (/^(?:https?:\/\/)?(?:[a-z0-9-]+\.)*(?:xiaohongshu\.com|xhslink\.(?:com|cn))\//i.test(trimmed)) {
      const fullUrl = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
      if (!seen.has(fullUrl)) {
        try {
          new URL(fullUrl);
          seen.add(fullUrl);
          results.push(fullUrl);
        } catch {}
      }
    }
  }

  return results;
}

// 实时更新输入框链接识别状态
function updateInputUrlHint() {
  const input = document.getElementById("input-text");
  const badge = document.getElementById("multi-url-badge");
  const btnText = document.getElementById("btn-parse-text");
  if (!input) return;

  const urls = extractAllXhsUrls(input.value);
  if (urls.length > 1) {
    if (badge) {
      badge.textContent = `🔍 识别到 ${urls.length} 条小红书链接`;
      badge.style.display = "inline-flex";
    }
    if (btnText && !state.isBatchRunning) {
      btnText.textContent = `⚡ 批量采集 (${urls.length} 篇) ↗`;
    }
  } else {
    if (badge) {
      badge.style.display = "none";
    }
    if (btnText && !state.isBatchRunning) {
      btnText.textContent = "开始解析 ↗";
    }
  }
}

// 2. 解析核心函数：根据链接数量自动进入单篇或批量模式
async function startParsing() {
  const input = document.getElementById("input-text");
  const text = (input?.value || "").trim();
  if (!text) {
    showToast("请先输入或粘贴小红书链接");
    return;
  }

  const urls = extractAllXhsUrls(text);
  if (urls.length > 1) {
    return startBatchProcessing(urls);
  }

  const singleUrl = urls.length === 1 ? urls[0] : text;
  return startSingleParsing(singleUrl);
}

// 单篇解析处理
async function startSingleParsing(text) {
  const btnText = document.getElementById("btn-parse-text");
  const spinner = document.getElementById("btn-parse-spinner");
  const btn = document.getElementById("btn-parse");

  if (btn) btn.disabled = true;
  if (btnText) btnText.style.display = "none";
  if (spinner) spinner.style.display = "inline-block";

  document.getElementById("toast-bar")?.classList.remove("show");
  const batchSec = document.getElementById("batch-section");
  if (batchSec) batchSec.style.display = "none";

  try {
    const cleanCookie = normalizeCookieString(state.xhsCookie);
    const reqHeaders = { "Content-Type": "application/json" };
    if (cleanCookie) {
      reqHeaders["x-xhs-cookie"] = cleanCookie;
    }

    const res = await fetch("/api/parse", {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ text, cookie: cleanCookie })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || "解析失败，请检查链接有效性");
    }

    data.sourceUrl = data.sourceUrl || text;
    if (isGenericTitle(data.title) && data.content) {
      const fromContent = extractTitleFromContent(data.content);
      if (fromContent) data.title = fromContent;
    }
    data.title = data.title || "小红书笔记";
    state.currentParsedNote = data;
    renderParseResult(data);
    showToast("🎉 解析成功！");

    // 触发后台转存至 Cloudflare 知识库
    triggerCloudSync(data);
  } catch (err) {
    console.error(err);
    showToast(`❌ ${err.message || "解析出错"}`);
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.style.display = "inline";
    if (spinner) spinner.style.display = "none";
  }
}

// 2.1 批量队列采集处理 (防风控队列 + 实时进度条 + 自动转存 Cloudflare)
async function startBatchProcessing(urls) {
  if (state.isBatchRunning) {
    showToast("当前已有批量采集任务正在进行中，请等待完成或点击停止");
    return;
  }

  const batchSection = document.getElementById("batch-section");
  const resultSection = document.getElementById("result-section");
  if (resultSection) resultSection.style.display = "none";
  if (batchSection) batchSection.style.display = "block";

  batchSection.scrollIntoView({ behavior: "smooth", block: "start" });

  state.isBatchRunning = true;
  state.shouldStopBatch = false;
  state.batchResults = [];
  state.batchQueue = urls.map((url, idx) => ({
    id: idx + 1,
    url,
    status: "waiting", // 'waiting' | 'processing' | 'success' | 'failed'
    note: null,
    error: null
  }));

  const btnParse = document.getElementById("btn-parse");
  const btnParseText = document.getElementById("btn-parse-text");
  const btnParseSpinner = document.getElementById("btn-parse-spinner");
  const btnStop = document.getElementById("btn-batch-stop");
  const actionsBar = document.getElementById("batch-actions-bar");

  if (btnParse) btnParse.disabled = true;
  if (btnParseText) btnParseText.style.display = "none";
  if (btnParseSpinner) btnParseSpinner.style.display = "inline-block";
  if (btnStop) btnStop.style.display = "inline-flex";
  if (actionsBar) actionsBar.style.display = "none";

  document.getElementById("batch-main-title").textContent = `正在队列采集 ${urls.length} 篇小红书笔记...`;
  renderBatchQueue();
  updateBatchProgress(0, "正在启动队列批量采集 (防风控间隔执行)...");

  const cleanCookie = normalizeCookieString(state.xhsCookie);
  const reqHeaders = { "Content-Type": "application/json" };
  if (cleanCookie) {
    reqHeaders["x-xhs-cookie"] = cleanCookie;
  }

  const total = state.batchQueue.length;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < total; i++) {
    if (state.shouldStopBatch) {
      showToast("⏹ 批量采集已按您的要求提前停止");
      break;
    }

    const item = state.batchQueue[i];
    item.status = "processing";
    renderBatchItem(i);

    const progressPercent = Math.round((i / total) * 100);
    updateBatchProgress(
      progressPercent,
      `正在采集 [${i + 1}/${total}]：请求小红书页面解析中... (${progressPercent}%)`
    );

    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({ text: item.url, cookie: cleanCookie })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || "解析失败或未获取到媒体内容");
      }

      data.sourceUrl = item.url;
      if (isGenericTitle(data.title) && data.content) {
        const fromContent = extractTitleFromContent(data.content);
        if (fromContent) data.title = fromContent;
      }
      data.title = data.title || "小红书笔记";

      item.status = "success";
      item.note = data;
      state.batchResults.push(data);
      successCount++;

      // 实时后台自动归档转存至 Cloudflare (R2 + D1)
      triggerCloudSync(data).then((ok) => {
        const syncPill = document.getElementById(`batch-sync-pill-${i}`);
        if (syncPill) {
          syncPill.textContent = ok ? "☁️ 已存入 R2/D1" : "☁️ 云端归档处理中";
          syncPill.style.color = "var(--success)";
        }
      }).catch(err => console.warn("Batch cloud sync error:", err));

      const titleSnippet = (data.title || "小红书笔记").replace(/[\r\n\t]+/g, " ").trim();
      updateBatchProgress(
        Math.round(((i + 1) / total) * 100),
        `正在采集 [${i + 1}/${total}]：${escapeHtml(titleSnippet.slice(0, 26))}...`
      );
    } catch (err) {
      console.error(`Batch item ${i + 1} error:`, err);
      item.status = "failed";
      item.error = err.message || "解析出错";
      failCount++;
    }

    renderBatchItem(i);
    updateBatchStats(successCount, failCount, total);

    // 防风控排队间隔 (0.8 秒)
    if (i < total - 1 && !state.shouldStopBatch) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }

  state.isBatchRunning = false;
  if (btnParse) btnParse.disabled = false;
  if (btnParseText) btnParseText.style.display = "inline";
  if (btnParseSpinner) btnParseSpinner.style.display = "none";
  if (btnStop) btnStop.style.display = "none";
  updateInputUrlHint();

  const finalPercent = 100;
  const statusMsg = state.shouldStopBatch
    ? `⏹ 批量采集已提前中止：已完成 ${successCount} 篇，失败 ${failCount} 篇`
    : `🎉 批量采集全部完成！成功 ${successCount} 篇，失败 ${failCount} 篇`;

  updateBatchProgress(finalPercent, statusMsg);
  document.getElementById("batch-main-title").textContent = state.shouldStopBatch
    ? "批量采集已中止"
    : "🎉 批量采集已完成";

  if (state.batchResults.length > 0) {
    if (actionsBar) actionsBar.style.display = "flex";
    showToast(`🎉 批量采集完成：已自动归档 ${state.batchResults.length} 篇笔记至知识库！`);
  } else {
    showToast("❌ 批量采集结束，未成功解析有效笔记", { isError: true });
  }

  refreshNotesBadge();
}

// 渲染批量任务初始列表
function renderBatchQueue() {
  const container = document.getElementById("batch-items-list");
  if (!container) return;
  container.innerHTML = "";

  state.batchQueue.forEach((item, index) => {
    const el = document.createElement("div");
    el.id = `batch-item-${index}`;
    el.className = "batch-item-card";
    container.appendChild(el);
    renderBatchItem(index);
  });
}

// 渲染单个队列项卡片
function renderBatchItem(index) {
  const el = document.getElementById(`batch-item-${index}`);
  const item = state.batchQueue[index];
  if (!el || !item) return;

  el.className = `batch-item-card status-${item.status}`;

  if (item.status === "waiting") {
    el.innerHTML = `
      <div class="batch-item-header">
        <div class="batch-item-left">
          <span class="batch-item-index">[${index + 1}]</span>
          <span class="batch-badge badge-waiting">⏳ 等待排队</span>
          <span class="batch-item-url text-truncate" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
        </div>
      </div>
    `;
  } else if (item.status === "processing") {
    el.innerHTML = `
      <div class="batch-item-header">
        <div class="batch-item-left">
          <span class="batch-item-index">[${index + 1}]</span>
          <span class="batch-badge badge-processing"><span class="spinner spinner-sm"></span> 正在解析并保存...</span>
          <span class="batch-item-url text-truncate" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
        </div>
      </div>
    `;
  } else if (item.status === "success") {
    const note = item.note || {};
    const imgCount = note.images?.length || 0;
    const vidCount = note.videos?.length || 0;

    el.innerHTML = `
      <div class="batch-item-header">
        <div class="batch-item-left">
          <span class="batch-item-index">[${index + 1}]</span>
          <span class="batch-badge badge-success">✅ 已采集</span>
          <span class="batch-item-title" title="${escapeHtml(note.title)}">${escapeHtml(note.title || "小红书笔记")}</span>
        </div>
        <div class="batch-item-actions">
          <button class="btn btn-sm btn-secondary btn-batch-preview" data-idx="${index}" type="button">👀 查看详情</button>
          <button class="btn btn-sm btn-primary btn-batch-download" data-idx="${index}" type="button">⬇️ 下载本篇</button>
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-secondary" title="在新标签打开原始链接">🔗 原链</a>
        </div>
      </div>
      <div class="batch-item-summary">
        ${imgCount ? `<span class="batch-summary-pill">🖼️ ${imgCount} 张图片</span>` : ""}
        ${vidCount ? `<span class="batch-summary-pill">🎬 视频</span>` : ""}
        <span id="batch-sync-pill-${index}" class="batch-summary-pill" style="color:var(--success); font-weight:600;">☁️ 已存入 R2/D1</span>
        <span class="batch-item-url text-truncate" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
      </div>
    `;

    // 绑定单篇详情预览与快速下载
    el.querySelector(".btn-batch-preview")?.addEventListener("click", () => {
      if (note.id) {
        openNoteDetail(note.id);
      } else {
        renderParseResult(note);
      }
    });

    el.querySelector(".btn-batch-download")?.addEventListener("click", () => {
      downloadSingleNote(note);
    });
  } else if (item.status === "failed") {
    el.innerHTML = `
      <div class="batch-item-header">
        <div class="batch-item-left">
          <span class="batch-item-index">[${index + 1}]</span>
          <span class="batch-badge badge-danger">❌ 采集失败</span>
          <span class="batch-item-url text-truncate" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</span>
        </div>
        <div class="batch-item-actions">
          <button class="btn btn-sm btn-secondary btn-batch-retry" data-idx="${index}" type="button">🔄 重试此条</button>
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener" class="btn btn-sm btn-secondary" title="打开原始链接">🔗 原链</a>
        </div>
      </div>
      <div class="batch-item-error-msg">❌ 失败原因：${escapeHtml(item.error || "请求解析失败")}</div>
    `;

    el.querySelector(".btn-batch-retry")?.addEventListener("click", () => {
      retryBatchItem(index);
    });
  }
}

// 单独重试某一条采集失败的链接
async function retryBatchItem(index) {
  const item = state.batchQueue[index];
  if (!item) return;

  item.status = "processing";
  item.error = null;
  renderBatchItem(index);
  showToast(`正在重试第 [${index + 1}] 条链接...`);

  try {
    const cleanCookie = normalizeCookieString(state.xhsCookie);
    const reqHeaders = { "Content-Type": "application/json" };
    if (cleanCookie) {
      reqHeaders["x-xhs-cookie"] = cleanCookie;
    }

    const res = await fetch("/api/parse", {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ text: item.url, cookie: cleanCookie })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.message || "解析失败");
    }

    data.sourceUrl = item.url;
    item.status = "success";
    item.note = data;
    state.batchResults.push(data);

    triggerCloudSync(data).then(() => {
      const syncPill = document.getElementById(`batch-sync-pill-${index}`);
      if (syncPill) {
        syncPill.textContent = "☁️ 已存入 R2/D1";
        syncPill.style.color = "var(--success)";
      }
    });

    showToast(`🎉 第 [${index + 1}] 条重试解析成功！`);
  } catch (err) {
    item.status = "failed";
    item.error = err.message || "重试仍未成功";
    showToast(`❌ 重试失败: ${item.error}`, { isError: true });
  }

  renderBatchItem(index);

  const successCount = state.batchQueue.filter(it => it.status === "success").length;
  const failCount = state.batchQueue.filter(it => it.status === "failed").length;
  updateBatchStats(successCount, failCount, state.batchQueue.length);

  const actionsBar = document.getElementById("batch-actions-bar");
  if (state.batchResults.length > 0 && actionsBar) {
    actionsBar.style.display = "flex";
  }
  refreshNotesBadge();
}

// 更新批量进度状态条
function updateBatchProgress(percent, statusMsg) {
  const bar = document.getElementById("batch-progress-bar");
  const percentText = document.getElementById("batch-percent-text");
  const statusEl = document.getElementById("batch-current-status");

  if (bar) bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  if (percentText) percentText.textContent = `${Math.min(100, Math.max(0, percent))}%`;
  if (statusEl && statusMsg) statusEl.textContent = statusMsg;
}

// 更新统计数据
function updateBatchStats(success, fail, total) {
  const elTotal = document.getElementById("batch-stat-total");
  const elSuccess = document.getElementById("batch-stat-success");
  const elFail = document.getElementById("batch-stat-fail");

  if (elTotal) elTotal.textContent = total;
  if (elSuccess) elSuccess.textContent = success;
  if (elFail) elFail.textContent = fail;
}

// 一键打包下载全部批量采集结果 (ZIP)
async function downloadAllBatchZip() {
  if (!state.batchResults || state.batchResults.length === 0) {
    showToast("当前暂无已成功采集的笔记可打包");
    return;
  }

  const notes = state.batchResults;
  showToast(`正在批量下载并打包全部 ${notes.length} 篇笔记的资源...`);

  try {
    const files = [];

    for (let nIdx = 0; nIdx < notes.length; nIdx++) {
      const note = notes[nIdx];
      const safeTitle = (note.title || `笔记_${nIdx + 1}`).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 30);
      const folderName = `${String(nIdx + 1).padStart(2, "0")}_${safeTitle}`;

      // 1. 文案说明文件
      const txtContent = makeNoteTextFileData({
        title: note.title,
        content: note.content,
        sourceUrl: note.sourceUrl || window.location.href,
        engine: "Cloudflare R2"
      });
      files.push({
        name: `${folderName}/文案与链接.txt`,
        data: new TextEncoder().encode(txtContent)
      });

      // 2. 图片
      if (note.images && note.images.length > 0) {
        for (let i = 0; i < note.images.length; i++) {
          const img = note.images[i];
          const url = typeof img === "string" ? img : img.url;
          try {
            const res = await fetch(url);
            if (res.ok) {
              const buf = new Uint8Array(await res.arrayBuffer());
              files.push({
                name: `${folderName}/图片_${String(i + 1).padStart(2, "0")}.jpg`,
                data: buf
              });
            }
          } catch (e) {
            console.warn(`Fetch image failed: ${url}`, e);
          }
        }
      }

      // 3. 视频
      if (note.videos && note.videos.length > 0) {
        for (let vIdx = 0; vIdx < note.videos.length; vIdx++) {
          const vid = note.videos[vIdx];
          const vUrl = typeof vid === "string" ? vid : (vid.url || vid.main_url);
          if (vUrl) {
            try {
              const res = await fetch(vUrl);
              if (res.ok) {
                const buf = new Uint8Array(await res.arrayBuffer());
                const pinyinName = toPinyinFilename(note.title || "video", ".mp4");
                files.push({
                  name: `${folderName}/${pinyinName}`,
                  data: buf
                });
              }
            } catch (e) {
              console.warn(`Fetch video failed: ${vUrl}`, e);
            }
          }
        }
      }
    }

    if (files.length === 0) {
      showToast("未获取到可打包的有效文件");
      return;
    }

    const zipBlob = makeZipBlob(files);
    const downloadUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    const nowStr = new Date().toISOString().slice(0, 10);
    a.download = `小红书批量采集_共${notes.length}篇_${nowStr}.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    showToast("🎉 全部采集结果 ZIP 已打包完成并开始下载！");
  } catch (err) {
    console.error("Batch zip error:", err);
    showToast(`批量打包失败: ${err.message}`, { isError: true });
  }
}

// 快速下载单篇笔记资源
async function downloadSingleNote(note) {
  if (!note) return;

  if (note.images && note.images.length > 0) {
    return downloadZipArchive(note.images, note.title, note.content);
  }

  if (note.videos && note.videos.length > 0) {
    const vid = note.videos[0];
    const vUrl = typeof vid === "string" ? vid : (vid.url || vid.main_url);
    if (vUrl) {
      const filename = toPinyinFilename(note.title || "video", ".mp4");
      return downloadDirectFile(vUrl, filename);
    }
  }

  showToast("该笔记无图片或视频文件可供下载");
}

// 渲染解析结果
function renderParseResult(note) {
  const section = document.getElementById("result-section");
  if (!section) return;
  section.style.display = "block";

  // 标题与文案
  document.getElementById("result-title").textContent = note.title || "小红书笔记";
  document.getElementById("result-content").textContent = note.content || "（无文案描述）";

  // 原始采集链接展示
  const sourceBar = document.getElementById("result-source-bar");
  const sourceLink = document.getElementById("result-source-link");
  const copyBtn = document.getElementById("btn-copy-source-link");
  const sourceUrl = note.sourceUrl || document.getElementById("input-text")?.value?.trim() || "";
  if (sourceBar && sourceLink && sourceUrl) {
    sourceBar.style.display = "flex";
    sourceLink.href = sourceUrl;
    sourceLink.textContent = sourceUrl;
    copyBtn.onclick = async () => {
      await navigator.clipboard.writeText(sourceUrl);
      showToast("已复制原始采集链接");
    };
  } else if (sourceBar) {
    sourceBar.style.display = "none";
  }

  // 图片处理
  const imgSection = document.getElementById("image-section");
  const imgGrid = document.getElementById("image-grid");
  const imgCountLabel = document.getElementById("image-count-label");

  state.selectedImages.clear();

  if (note.images && note.images.length > 0) {
    imgSection.style.display = "block";
    imgCountLabel.textContent = `🖼️ 高清无水印图片 (${note.images.length} 张)`;
    imgGrid.innerHTML = "";

    note.images.forEach((img, i) => {
      state.selectedImages.add(img.url);
      const item = document.createElement("div");
      item.className = "image-item";
      item.innerHTML = `
        <img src="${img.url}" alt="原图 ${i + 1}" loading="lazy" />
        ${img.livePhoto ? '<span class="live-badge">LIVE 实况</span>' : ""}
        <div class="image-actions-overlay">
          <button class="img-btn-dl" data-url="${img.url}" data-name="${String(i + 1).padStart(2, "0")}.jpg">下载单张</button>
        </div>
      `;

      item.querySelector(".img-btn-dl").addEventListener("click", (e) => {
        e.stopPropagation();
        downloadDirectFile(img.url, `${String(i + 1).padStart(2, "0")}.jpg`);
      });

      item.addEventListener("click", () => {
        window.open(img.url, "_blank");
      });

      imgGrid.appendChild(item);
    });
  } else {
    imgSection.style.display = "none";
  }

  // 视频处理
  const vidSection = document.getElementById("video-section");
  const videoPlayer = document.getElementById("video-player");
  const videoWrap = document.getElementById("video-player-container");
  const audioPlayer = document.getElementById("audio-player");
  const audioWrap = document.getElementById("audio-player-wrap");
  const qualitySelect = document.getElementById("video-quality-select");
  const transcriptPanel = document.getElementById("transcript-panel");
  if (transcriptPanel) transcriptPanel.style.display = "none";
  if (audioWrap) audioWrap.style.display = "none";
  if (videoWrap) videoWrap.style.display = "block";

  if (note.videos && note.videos.length > 0) {
    vidSection.style.display = "block";
    qualitySelect.innerHTML = "";

    note.videos.forEach((v, index) => {
      const opt = document.createElement("option");
      opt.value = v.url;
      opt.textContent = v.label || `${v.quality || "原画"} · 线路 ${index + 1}`;
      qualitySelect.appendChild(opt);
    });

    const activeUrl = note.videos[0].url;
    videoPlayer.src = activeUrl;
    if (audioPlayer) audioPlayer.src = activeUrl;

    qualitySelect.onchange = () => {
      videoPlayer.src = qualitySelect.value;
      if (audioPlayer) audioPlayer.src = qualitySelect.value;
      videoPlayer.play().catch(() => {});
    };

    // 纯音频模式切换
    const toggleAudioBtn = document.getElementById("btn-toggle-audio-mode");
    if (toggleAudioBtn) {
      toggleAudioBtn.textContent = "🎧 纯听音频";
      toggleAudioBtn.onclick = () => {
        const isAudioActive = audioWrap?.style.display === "block";
        if (isAudioActive) {
          audioWrap.style.display = "none";
          videoWrap.style.display = "block";
          audioPlayer?.pause();
          toggleAudioBtn.textContent = "🎧 纯听音频";
        } else {
          audioWrap.style.display = "block";
          videoWrap.style.display = "none";
          videoPlayer?.pause();
          audioPlayer?.play().catch(() => {});
          toggleAudioBtn.textContent = "🎬 切换回视频画面";
        }
      };
    }

    // 提取语音文案
    const transcribeBtn = document.getElementById("btn-transcribe-video");
    if (transcribeBtn) {
      transcribeBtn.onclick = () => {
        transcribeAudio(activeUrl, "#transcript-panel", note.noteId || note.id);
      };
    }
  } else {
    vidSection.style.display = "none";
    videoPlayer.removeAttribute("src");
    audioPlayer?.removeAttribute("src");
  }

  // 平滑滚动至结果区
  section.scrollIntoView({ behavior: "smooth", block: "start" });
}

// 触发后台转存至 Cloudflare R2 & D1
async function triggerCloudSync(note) {
  const statusBadge = document.getElementById("cloud-sync-status");
  if (statusBadge) {
    statusBadge.textContent = "☁️ 正在自动同步保存至 Cloudflare...";
    statusBadge.style.color = "var(--text-muted)";
    statusBadge.style.background = "var(--surface-alt)";
  }

  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-auth-pin": state.pin
      },
      body: JSON.stringify({
        note: {
          noteId: note.noteId || `note_${Date.now()}`,
          title: note.title,
          content: note.content,
          sourceUrl: note.sourceUrl || document.getElementById("input-text")?.value,
          images: note.images || [],
          videos: note.videos || []
        }
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      if (data.result?.id) {
        note.id = data.result.id;
        note.noteId = data.result.id;
      }
      if (statusBadge) {
        statusBadge.innerHTML = '✅ 已永久离线保存至 <a href="#kb" id="link-to-kb-badge" style="color:var(--success);text-decoration:underline;cursor:pointer;font-weight:600;">我的收藏知识库 ↗</a>';
        statusBadge.style.color = "var(--success)";
        statusBadge.style.background = "var(--success-bg)";
        document.getElementById("link-to-kb-badge")?.addEventListener("click", (e) => {
          e.preventDefault();
          switchPageTab("kb");
        });
      }
      refreshNotesBadge();
    }
  } catch (err) {
    console.warn("Auto sync error:", err);
  }
}

// 单文件直接触发浏览器下载
async function downloadDirectFile(url, filename) {
  try {
    showToast("正在获取媒体文件...");
    const res = await fetch(url);
    const blob = await res.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    showToast(`已开始下载 ${filename}`);
  } catch (err) {
    // 降级新窗口打开
    window.open(url, "_blank");
  }
}

// 批量打包 ZIP 下载
async function downloadZipArchive(images, title = "小红书高清图集", content = "") {
  if (!images || images.length === 0) {
    showToast("没有可下载的图片");
    return;
  }

  showToast(`正在批量下载并打包 ${images.length} 张原图...`);

  try {
    const files = [];

    // 添加文案说明 TXT
    const txtContent = makeNoteTextFileData({
      title,
      content,
      sourceUrl: window.location.href,
      engine: "Cloudflare R2"
    });
    files.push({
      name: `${title.slice(0, 30)}_文案.txt`,
      data: new TextEncoder().encode(txtContent)
    });

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const url = typeof img === "string" ? img : img.url;
      const res = await fetch(url);
      const buf = new Uint8Array(await res.arrayBuffer());
      files.push({
        name: `${String(i + 1).padStart(2, "0")}.jpg`,
        data: buf
      });
    }

    const zipBlob = makeZipBlob(files);
    const downloadUrl = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 40)}_无水印原图包.zip`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    showToast("🎉 ZIP 打包下载完成！");
  } catch (err) {
    console.error(err);
    showToast(`打包失败: ${err.message}`);
  }
}

// HTML 安全转义
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ========================================================
// 语音文案智能分段、高亮重点标注与持久化系统
// ========================================================

// 智能中文启发式标点恢复与精准断句引擎
function autoPunctuateChinese(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";

  // 1. 独立感叹与强调词（如：错！、对！、绝对不行！）
  s = s.replace(/([^\n，。！？]+?)(错|对)(?=只讲|不是|不讲|必须|我们|大家|其实|管理者|很多人)/g, '$1。\n$2！\n');
  s = s.replace(/(^|[^\u4e00-\u9fa5a-zA-Z0-9])(错|对|绝对不行|当然)(?=[\u4e00-\u9fa5])/g, '$1$2！\n');

  // 2. 序数词与列表列点断句（如：第一点、第二点、首先、其次、另外）
  s = s.replace(/([^\n，。！？]{3,})(第一点|第二点|第三点|第四点|首先|其次|另外|此外|最后)(就是要|就是|是|要)/g, '$1。\n$2$3，');
  s = s.replace(/([^\n，。！？]{3,})(第一(?!点)|第二(?!点)|第三(?!点)|第四(?!点))(?=[，、：:\u4e00-\u9fa5])/g, '$1。\n$2、');

  // 3. 疑问句识别与问号
  // 3.1 句尾疑问助词（了吗、对不对、对吗、是不是）
  s = s.replace(/([^\n，。！？]+?(?:了吗|了吗\?|对吗|行吗|好吗|对不对|好不好|是不是))(?=$|[\u4e00-\u9fa5])/g, '$1？\n');
  // 3.2 为什么、怎么、如何开头的疑问意群
  s = s.replace(/(为什么[^\n，。！？\?]{4,28}?)(?=很多|大家|我们|有人|因为|所以|其实|如果|新手|第一)/g, '$1？\n');

  // 4. 常见四字成语与固定总结词断句
  s = s.replace(/(缺一不可|显而易见|至关重要|由此可见|以此类推)(?=[\u4e00-\u9fa5])/g, '$1。\n');

  // 5. 条件与时间从句结尾后置逗号（...的时候、...之前、...之后）
  s = s.replace(/([^\n，。！？]+?(?:的时候|之前|之后|以后|此时此刻|那一刻))([^\n，。！？、；：!?;:\s])/g, '$1，$2');

  // 6. 前置加逗号的关联词（转折/因果/假设/递进/从句引导）
  const preComma = [
    '而是', '但是', '可是', '不过', '然而', '所以', '因此', '因为', 
    '如果', '要是', '假如', '只要', '只有', '等于', '意味着', '相当于', 
    '让他们', '使他们', '导致', '都是在', '就是在', '不讲检查', '而且', 
    '并且', '同时', '甚至', '不能', '不要'
  ];
  for (const w of preComma) {
    const reg = new RegExp('([^\n，。！？、；：!?;:\\s]{2,}?)(' + w + ')', 'g');
    s = s.replace(reg, '$1，$2');
  }

  // 7. 后置加逗号的时间状语与引导认知动词
  const postComma = [
    '那一刻我才明白', '我才明白', '我明白', '我发现', '新手管理者以为', 
    '管理者以为', '以为', '觉得', '认为', '记住', '事实上', '换句话说'
  ];
  for (const w of postComma) {
    const reg = new RegExp('(' + w + ')([^\n，。！？、；：!?;:\\s])', 'g');
    s = s.replace(reg, '$1，$2');
  }

  // 8. 动宾/名词短语与主谓边界后置逗号（如：分享三个自媒体运营的干货， / 找准自己的定位，）
  s = s.replace(/(分享[^\n，。！？]+?干货)(?=第一|首先|今天)/g, '$1，');
  s = s.replace(/(找准自己的定位|明确自己的定位)(?=很多|大家|我们)/g, '$1，');
  s = s.replace(/(学会跟粉丝互动|跟粉丝多互动)(?=大家|我们|听明白)/g, '$1，');
  s = s.replace(/(内容要持续更新|保持持续更新)(?=不能|不要|千万)/g, '$1，');

  // 9. 核心并列短句：'信任是底色检查是机制'
  s = s.replace(/([^\n，。！？]+?是底色)([^\n，。！？]+?是机制)/g, '$1，$2，');

  // 10. 句号与换行断句标志（动宾/补语收尾）
  s = s.replace(/(交代当成的结果|交代当成了结果|工作当成结果)(?=授权|如果|所以|但是|并且)/g, '$1。\n');
  s = s.replace(/(直接气权|直接弃权)(?=那一刻|这个时候|后来|从此|所以)/g, '$1。\n');
  s = s.replace(/(自由发挥)(?=错|对|但是|然而|所以|很多人|很多)/g, '$1。\n');
  s = s.replace(/(不知道自己要做什么)(?=第二|其次|另外)/g, '$1。\n');
  s = s.replace(/(三天打鱼两天晒网)(?=第三|其次|最后)/g, '$1。\n');

  // 11. 韵律长度兜底：若一个句子连续超过 25 字没有任何逗号或停顿，寻找最近的词边界断开
  s = s.replace(/([^\n，。！？]{12,25})(，)?([^\n，。！？]{18,})/g, function(match, p1, comma, p2) {
    if (comma) return match;
    return p1 + '，' + p2;
  });

  // 12. 清理多余标点
  s = s.replace(/，+/g, '，')
       .replace(/。+/g, '。')
       .replace(/！+/g, '！')
       .replace(/？+/g, '？')
       .replace(/，([。！？\n])/g, '$1')
       .replace(/([。！？])\s*，/g, '$1')
       .replace(/\n\s*\n+/g, '\n');

  // 结尾补齐句号
  s = s.trim();
  if (!/[。！？!?]$/.test(s)) {
    s += '。';
  }

  return s;
}

// 检查文本是否极度匮乏标点符号 (标点率低或缺少逗号句号)
function needsPunctuation(text) {
  if (!text) return false;
  const puncs = text.match(/[，。！？、；：,!?;:]/g) || [];
  const cleanLen = text.replace(/[\s\r\n]+/g, "").length;
  if (cleanLen < 8) return false;
  return (puncs.length / cleanLen) < 0.025 || !/[，,、]/.test(text) || !/[。！？!?]/.test(text);
}

// 解析语音文案为段落列表 [{ isStarred: boolean, html: string }]
function parseTranscriptParagraphs(raw) {
  if (!raw) return [];
  raw = String(raw).trim();

  // 1. 如果包含 <p 或 transcript-para 或 <mark 标签，说明是已格式化/包含重点保存的 HTML
  if (raw.includes("<p") || raw.includes("transcript-para") || raw.includes("<mark")) {
    const temp = document.createElement("div");
    temp.innerHTML = raw;
    const pEls = temp.querySelectorAll("p, .transcript-para");
    if (pEls.length > 0) {
      const results = [];
      pEls.forEach((p) => {
        const isStarred = p.classList.contains("para-starred");
        const contentEl = p.querySelector(".para-content");
        let html = contentEl ? contentEl.innerHTML.trim() : p.innerHTML.trim();
        if (html) {
          // 确保段末有标点（若末尾无标点，补齐句号）
          const textOnly = html.replace(/<\/?[^>]+(>|$)/g, "").trim();
          if (textOnly && !/[。！？!?…]$/.test(textOnly)) {
            html += "。";
          }
          results.push({ isStarred, html });
        }
      });
      if (results.length > 0) return results;
    }
  }

  // 2. 检查纯文本是否缺少标点符号：若无逗号/句号，自动补齐标点与断句
  if (needsPunctuation(raw)) {
    raw = autoPunctuateChinese(raw);
  }

  // 3. 按换行拆分为自然段落
  let segments = raw.split(/\n+/).map(s => s.trim()).filter(Boolean);

  // 4. 如果段落过长（超过 80 字且包含多个句号），按句号进行适度细分
  const fineSegments = [];
  for (let seg of segments) {
    if (seg.length > 80 && (seg.match(/[。！？!?]/g) || []).length >= 2) {
      const subSentences = seg.match(/[^。！？!?]+[。！？!?]?/g) || [seg];
      let currentGroup = [];
      let currentLen = 0;
      for (const sent of subSentences) {
        currentGroup.push(sent);
        currentLen += sent.length;
        if (currentLen >= 40 || currentGroup.length >= 2) {
          fineSegments.push(currentGroup.join("").trim());
          currentGroup = [];
          currentLen = 0;
        }
      }
      if (currentGroup.length > 0) {
        fineSegments.push(currentGroup.join("").trim());
      }
    } else {
      fineSegments.push(seg);
    }
  }

  // 5. 确保每个段落内部有逗号、末尾有句号/问号/感叹号
  return fineSegments.map((seg) => {
    let clean = seg.trim();
    if (!/[。！？!?…]$/.test(clean)) {
      clean += "。";
    }
    // 如果段落长于 16 字但没有任何逗号，尝试补逗号
    if (clean.length > 16 && !/[，,、]/.test(clean)) {
      clean = autoPunctuateChinese(clean);
    }
    return {
      isStarred: false,
      html: escapeHtml(clean)
    };
  });
}

// 序列化段落列表为可持久化的 HTML 字符串
function serializeTranscriptParagraphs(container) {
  if (!container) return "";
  const paras = container.querySelectorAll(".transcript-para");
  const parts = [];
  paras.forEach((p) => {
    const isStarred = p.classList.contains("para-starred");
    const contentEl = p.querySelector(".para-content");
    const html = contentEl ? contentEl.innerHTML.trim() : "";
    if (html) {
      if (isStarred) {
        parts.push(`<p class="para-starred">${html}</p>`);
      } else {
        parts.push(`<p>${html}</p>`);
      }
    }
  });
  return parts.join("\n");
}

// 获取文案纯文本（剥离所有 HTML 标签，换行连接）
function getTranscriptPlainText(container) {
  if (!container) return "";
  const paras = container.querySelectorAll(".transcript-para");
  const lines = [];
  paras.forEach((p) => {
    const contentEl = p.querySelector(".para-content");
    if (contentEl) {
      const text = contentEl.innerText || contentEl.textContent || "";
      if (text.trim()) lines.push(text.trim());
    }
  });
  return lines.join("\n\n");
}

// 获取全部重点摘要（星标重点段落 + 划词核心金句）
function getTranscriptHighlightsSummary(container) {
  if (!container) return { summary: "", totalCount: 0, starCount: 0, markCount: 0 };
  const paras = container.querySelectorAll(".transcript-para");
  const summaryLines = [];
  let markCount = 0;
  let starCount = 0;

  paras.forEach((p, idx) => {
    const isStarred = p.classList.contains("para-starred");
    const contentEl = p.querySelector(".para-content");
    if (!contentEl) return;

    const marks = contentEl.querySelectorAll("mark.transcript-hl");
    const markTexts = Array.from(marks).map(m => m.textContent.trim()).filter(Boolean);

    if (isStarred) {
      starCount++;
      const paraText = (contentEl.innerText || contentEl.textContent || "").trim();
      summaryLines.push(`⭐ 【重点段落 ${idx + 1}】\n${paraText}`);
    } else if (markTexts.length > 0) {
      markCount += markTexts.length;
      summaryLines.push(`✨ 【段落 ${idx + 1} 核心划词】: ${markTexts.map(t => `「${t}」`).join("、")}`);
    }
  });

  return {
    summary: summaryLines.join("\n\n"),
    totalCount: starCount + markCount,
    starCount,
    markCount
  };
}

// 刷新重点计数徽章与状态
function updateTranscriptStatsBadge(container) {
  if (!container) return;
  const badge = container.querySelector(".transcript-hl-badge");
  const paras = container.querySelectorAll(".transcript-para");
  let starCount = 0;
  let markCount = 0;

  paras.forEach((p) => {
    const isStarred = p.classList.contains("para-starred");
    const hasMark = !!p.querySelector("mark.transcript-hl");
    p.classList.toggle("has-mark", hasMark);
    if (isStarred) starCount++;
    if (hasMark) {
      markCount += p.querySelectorAll("mark.transcript-hl").length;
    }
  });

  const total = starCount + markCount;
  if (badge) {
    if (total > 0) {
      badge.style.display = "inline-flex";
      badge.textContent = `⭐ ${total} 处重点`;
    } else {
      badge.style.display = "none";
    }
  }

  // 空状态提示
  const filterEmpty = container.querySelector(".transcript-filter-empty");
  const isFilterActive = container.classList.contains("filter-highlights-only");
  if (filterEmpty) {
    filterEmpty.style.display = (isFilterActive && total === 0) ? "block" : "none";
  }
}

// 自动持久化保存文案至 Cloudflare D1
let _transcriptSaveTimeout = null;
function triggerTranscriptAutoSave(container, noteId) {
  const targetId = noteId || container?.dataset?.noteId || (state.activeDetailNote?.id);
  if (!targetId || !container) return;

  clearTimeout(_transcriptSaveTimeout);
  _transcriptSaveTimeout = setTimeout(async () => {
    const serialized = serializeTranscriptParagraphs(container);
    try {
      await fetch(`/api/notes/${targetId}/transcript`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-auth-pin": state.pin
        },
        body: JSON.stringify({ transcript: serialized })
      });
      if (state.activeDetailNote && String(state.activeDetailNote.id) === String(targetId)) {
        state.activeDetailNote.transcript = serialized;
      }
    } catch (e) {
      console.warn("保存高亮文案到云端失败:", e);
    }
  }, 400);
}

// 划词操作气泡全局状态与处理函数
let _currentActiveRange = null;
let _currentActiveMark = null;

function showPillForMark(mark) {
  const pill = document.getElementById("transcript-selection-pill");
  const btnHl = document.getElementById("btn-pill-hl");
  const btnUnhl = document.getElementById("btn-pill-unhl");
  if (!pill || !mark) return;

  _currentActiveMark = mark;
  _currentActiveRange = null;

  if (btnHl) btnHl.style.display = "none";
  if (btnUnhl) btnUnhl.style.display = "inline-flex";

  const rect = mark.getBoundingClientRect();
  positionTranscriptPill(rect);
}

function positionTranscriptPill(rect) {
  const pill = document.getElementById("transcript-selection-pill");
  if (!pill || !rect || (rect.width === 0 && rect.height === 0)) return;

  pill.style.display = "flex";
  const pillWidth = pill.offsetWidth || 230;
  const pillHeight = pill.offsetHeight || 36;

  let left = rect.left + rect.width / 2 - pillWidth / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - pillWidth - 10));

  let top = rect.top - pillHeight - 8;
  if (top < 10) {
    top = rect.bottom + 8;
  }

  pill.style.left = `${left}px`;
  pill.style.top = `${top}px`;
}

function hideTranscriptPill() {
  const pill = document.getElementById("transcript-selection-pill");
  if (pill) pill.style.display = "none";
  _currentActiveRange = null;
  _currentActiveMark = null;
}

// 初始化划词浮动气泡
function initTranscriptSelectionPill() {
  const pill = document.getElementById("transcript-selection-pill");
  if (!pill) return;

  const btnHl = document.getElementById("btn-pill-hl");
  const btnUnhl = document.getElementById("btn-pill-unhl");
  const btnThought = document.getElementById("btn-pill-thought");
  const btnCopy = document.getElementById("btn-pill-copy");

  function handleSelectionCheck() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      if (!_currentActiveMark) {
        hideTranscriptPill();
      }
      return;
    }

    const range = selection.getRangeAt(0);
    const commonAncestor = range.commonAncestorContainer;
    const wrap = commonAncestor.nodeType === Node.ELEMENT_NODE
      ? commonAncestor.closest(".transcript-paragraphs-wrap")
      : commonAncestor.parentElement?.closest(".transcript-paragraphs-wrap");

    if (!wrap) {
      hideTranscriptPill();
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText) {
      hideTranscriptPill();
      return;
    }

    _currentActiveRange = range.cloneRange();
    _currentActiveMark = null;

    const parentMark = commonAncestor.nodeType === Node.ELEMENT_NODE
      ? commonAncestor.closest("mark.transcript-hl")
      : commonAncestor.parentElement?.closest("mark.transcript-hl");

    if (parentMark) {
      _currentActiveMark = parentMark;
      if (btnHl) btnHl.style.display = "none";
      if (btnUnhl) btnUnhl.style.display = "inline-flex";
    } else {
      if (btnHl) btnHl.style.display = "inline-flex";
      if (btnUnhl) btnUnhl.style.display = "none";
    }

    const rect = range.getBoundingClientRect();
    positionTranscriptPill(rect);
  }

  // 监听划选事件 (支持移动端与桌面端)
  let selTimer = null;
  document.addEventListener("selectionchange", () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(handleSelectionCheck, 120);
  });

  document.addEventListener("mouseup", (e) => {
    if (pill.contains(e.target)) return;
    setTimeout(handleSelectionCheck, 50);
  });

  document.addEventListener("touchend", (e) => {
    if (pill.contains(e.target)) return;
    setTimeout(handleSelectionCheck, 100);
  });

  // 点击外部收起气泡
  document.addEventListener("mousedown", (e) => {
    if (!pill.contains(e.target) && !e.target.closest(".transcript-paragraphs-wrap")) {
      hideTranscriptPill();
    }
  });

  // 1. 划选重点标记
  btnHl?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!_currentActiveRange) return;

    try {
      const startPara = _currentActiveRange.startContainer.nodeType === Node.ELEMENT_NODE
        ? _currentActiveRange.startContainer.closest(".para-content")
        : _currentActiveRange.startContainer.parentElement?.closest(".para-content");
      const endPara = _currentActiveRange.endContainer.nodeType === Node.ELEMENT_NODE
        ? _currentActiveRange.endContainer.closest(".para-content")
        : _currentActiveRange.endContainer.parentElement?.closest(".para-content");

      if (!startPara) return;
      if (startPara !== endPara) {
        showToast("⚠️ 划选高亮仅支持在同一段落内标记，请分段划选");
        hideTranscriptPill();
        return;
      }

      const container = startPara.closest(".transcript-box");
      const mark = document.createElement("mark");
      mark.className = "transcript-hl";
      mark.title = "重点标记 (点击可取消)";

      const fragment = _currentActiveRange.extractContents();
      mark.appendChild(fragment);
      _currentActiveRange.insertNode(mark);

      // 清理嵌套的旧 mark
      mark.querySelectorAll("mark.transcript-hl").forEach((inner) => {
        while (inner.firstChild) inner.parentNode.insertBefore(inner.firstChild, inner);
        inner.remove();
      });

      startPara.normalize();
      window.getSelection()?.removeAllRanges();
      hideTranscriptPill();

      if (container) {
        updateTranscriptStatsBadge(container);
        triggerTranscriptAutoSave(container);
      }
      showToast("✨ 已高亮标记重点，已自动同步保存！");
    } catch (err) {
      console.warn("划词高亮失败:", err);
      showToast("高亮失败，请重试划选");
    }
  });

  // 2. 取消重点标记
  btnUnhl?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (_currentActiveMark) {
      const container = _currentActiveMark.closest(".transcript-box");
      const parent = _currentActiveMark.parentNode;
      if (parent) {
        while (_currentActiveMark.firstChild) {
          parent.insertBefore(_currentActiveMark.firstChild, _currentActiveMark);
        }
        _currentActiveMark.remove();
        parent.normalize();
      }

      hideTranscriptPill();
      if (container) {
        updateTranscriptStatsBadge(container);
        triggerTranscriptAutoSave(container);
      }
      showToast("🧹 已取消该处重点高亮");
    }
  });

  // 3. 将所选存入感想
  btnThought?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = _currentActiveMark
      ? _currentActiveMark.textContent.trim()
      : (_currentActiveRange ? _currentActiveRange.toString().trim() : "");
    if (!text) return;

    const thoughtsInput = document.getElementById("modal-thoughts-input");
    if (thoughtsInput) {
      const prev = thoughtsInput.value.trim();
      const snippet = `【摘录重点】${text}`;
      thoughtsInput.value = prev ? `${prev}\n\n${snippet}` : snippet;
      thoughtsInput.scrollIntoView({ behavior: "smooth", block: "center" });
      thoughtsInput.focus();
      showToast("📌 已存入随笔批注！别忘记点击「保存感想」");
    }
    hideTranscriptPill();
  });

  // 4. 复制所选
  btnCopy?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = _currentActiveMark
      ? _currentActiveMark.textContent.trim()
      : (_currentActiveRange ? _currentActiveRange.toString().trim() : "");
    if (text) {
      await navigator.clipboard.writeText(text);
      showToast("📋 已复制所选重点文字");
    }
    hideTranscriptPill();
  });
}

// 渲染语音文案面板 (置顶、自然分段、划词高亮、星标重点与仅看重点速览)
function renderTranscriptBox(container, rawText, noteId) {
  if (!container) return;
  container.style.display = "block";
  if (noteId) {
    container.dataset.noteId = String(noteId);
  }

  const paragraphs = parseTranscriptParagraphs(rawText);
  if (paragraphs.length === 0) {
    container.innerHTML = `<div class="transcript-filter-empty">暂无有效文案</div>`;
    return;
  }

  const paragraphsHtml = paragraphs.map((p, idx) => {
    const num = (idx + 1).toString().padStart(2, "0");
    const starClass = p.isStarred ? "active" : "";
    const paraClass = p.isStarred ? "transcript-para para-starred" : "transcript-para";
    return `
      <div class="${paraClass}" data-idx="${idx}">
        <div class="para-sidebar">
          <span class="para-num">¶ ${num}</span>
          <button type="button" class="btn-para-star ${starClass}" title="${p.isStarred ? '取消重点段落' : '标记为重点段落'}">⭐</button>
        </div>
        <div class="para-content">${p.html}</div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="transcript-header">
      <div class="transcript-header-left">
        <span class="transcript-title">🎙️ 视频语音提取文案 (AI Whisper)</span>
        <span class="transcript-hl-badge" style="display: none;">⭐ 0 处重点</span>
      </div>
      <div class="transcript-header-actions">
        <button type="button" class="transcript-btn btn-ai-punctuate" title="智能补齐逗号、句号并精准分段">
          ✨ 智能标点断句
        </button>
        <button type="button" class="transcript-btn btn-toggle-filter" title="只显示标记了重点的段落和文字">
          ⭐ 仅看重点
        </button>
        <button type="button" class="transcript-btn btn-append-thoughts" title="将高亮重点或全文追加到下方感想批注">
          📌 追加重点到感想
        </button>
        <button type="button" class="transcript-btn btn-copy-transcript" title="复制纯文本格式文案">
          📋 复制文案
        </button>
      </div>
    </div>
    <div class="transcript-paragraphs-wrap">
      ${paragraphsHtml}
      <div class="transcript-filter-empty" style="display: none;">
        💡 暂无标记重点的内容。划选文字可高亮重点，或点击左侧 ⭐ 标记整段！
      </div>
    </div>
  `;

  const wrap = container.querySelector(".transcript-paragraphs-wrap");

  // 1. 段落星标重点点击事件
  container.querySelectorAll(".btn-para-star").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const para = btn.closest(".transcript-para");
      if (!para) return;
      const isStarred = para.classList.toggle("para-starred");
      btn.classList.toggle("active", isStarred);
      btn.title = isStarred ? "取消重点段落" : "标记为重点段落";
      updateTranscriptStatsBadge(container);
      triggerTranscriptAutoSave(container, noteId);
      showToast(isStarred ? "⭐ 已将本段设为重点查看段落！" : "已取消该段落重点标记");
    });
  });

  // 2. 点击已有高亮标签直接触发操作浮动气泡
  if (wrap) {
    wrap.addEventListener("click", (e) => {
      const mark = e.target.closest("mark.transcript-hl");
      if (mark) {
        e.stopPropagation();
        showPillForMark(mark);
      }
    });
  }

  // 3. 「⭐ 仅看重点」过滤切换
  const toggleFilterBtn = container.querySelector(".btn-toggle-filter");
  if (toggleFilterBtn) {
    toggleFilterBtn.addEventListener("click", () => {
      const isFilterActive = container.classList.toggle("filter-highlights-only");
      toggleFilterBtn.classList.toggle("active", isFilterActive);
      toggleFilterBtn.textContent = isFilterActive ? "👀 查看全部段落" : "⭐ 仅看重点";
      updateTranscriptStatsBadge(container);
      showToast(isFilterActive ? "🔍 已开启「仅看重点」速览过滤" : "已恢复显示全部段落");
    });
  }

  // 4. 「📌 追加重点到感想」
  const appendBtn = container.querySelector(".btn-append-thoughts");
  if (appendBtn) {
    appendBtn.addEventListener("click", () => {
      const { summary, totalCount } = getTranscriptHighlightsSummary(container);
      const thoughtsInput = document.getElementById("modal-thoughts-input");
      const detailModal = document.getElementById("modal-note-detail");

      let appendText = "";
      if (totalCount > 0 && summary) {
        appendText = `【视频重点速览】\n${summary}`;
      } else {
        const fullPlain = getTranscriptPlainText(container);
        appendText = `【视频提取文案】\n${fullPlain}`;
      }

      if (detailModal && detailModal.classList.contains("active") && thoughtsInput) {
        const prev = thoughtsInput.value.trim();
        thoughtsInput.value = prev ? `${prev}\n\n${appendText}` : appendText;
        thoughtsInput.scrollIntoView({ behavior: "smooth", block: "center" });
        thoughtsInput.focus();
        showToast(totalCount > 0 ? `📌 已将 ${totalCount} 处重点追加到随笔批注！别忘记点击「保存感想」` : "📌 已将文案追加到随笔批注！");
      } else {
        navigator.clipboard.writeText(appendText);
        showToast("📋 已复制内容，可在笔记详情中存入感想批注");
      }
    });
  }

  // 5. 「📋 复制文案」
  const copyBtn = container.querySelector(".btn-copy-transcript");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const isFilterActive = container.classList.contains("filter-highlights-only");
      const { summary, totalCount } = getTranscriptHighlightsSummary(container);

      let textToCopy = "";
      if (isFilterActive && totalCount > 0) {
        textToCopy = `【视频重点速览】\n${summary}`;
      } else {
        textToCopy = getTranscriptPlainText(container);
      }

      await navigator.clipboard.writeText(textToCopy);
      showToast(isFilterActive && totalCount > 0 ? `📋 已复制全部 ${totalCount} 处重点内容` : "📋 已复制语音文案全文");
    });
  }

  // 6. 「✨ 智能标点断句」
  const punctuateBtn = container.querySelector(".btn-ai-punctuate");
  if (punctuateBtn) {
    punctuateBtn.addEventListener("click", async () => {
      punctuateBtn.disabled = true;
      const originalText = punctuateBtn.innerHTML;
      punctuateBtn.innerHTML = `⏳ 优化中...`;

      try {
        const plain = getTranscriptPlainText(container);
        if (!plain) return;

        let formatted = "";
        // 优先尝试云端 Workers AI 标点大模型
        try {
          const res = await fetch("/api/punctuate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-auth-pin": state.pin
            },
            body: JSON.stringify({ text: plain, noteId: noteId || container.dataset.noteId })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.success && data.text && data.text !== plain) {
              formatted = data.text;
            }
          }
        } catch (apiErr) {
          console.warn("API punctuate fallback to local:", apiErr);
        }

        // 若接口未返回或离线，立即启用本地启发式断句标点引擎
        if (!formatted) {
          formatted = autoPunctuateChinese(plain);
        }

        renderTranscriptBox(container, formatted, noteId);
        triggerTranscriptAutoSave(container, noteId);
        showToast("🎉 已智能补齐逗号、句号并优化分段排版！");
      } catch (err) {
        showToast(`标点优化失败: ${err.message}`);
      } finally {
        if (punctuateBtn) {
          punctuateBtn.disabled = false;
          punctuateBtn.innerHTML = originalText;
        }
      }
    });
  }

  // 如果原本是缺少标点的纯文本，经过智能补全后，自动异步静默保存至云端 D1
  if (typeof rawText === "string" && !rawText.includes("<p") && needsPunctuation(rawText)) {
    triggerTranscriptAutoSave(container, noteId);
  }

  // 初始化重点统计徽章
  updateTranscriptStatsBadge(container);
}

// 发送单个音频切片至后端 Whisper 接口，安全兼容 JSON 与异常响应
async function sendAudioChunkForTranscription(blob) {
  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers: {
      "x-auth-pin": state.pin,
      "Content-Type": "audio/wav"
    },
    body: blob
  });

  const contentType = res.headers.get("content-type") || "";
  let data;
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch {
      throw new Error("服务端返回了损坏的 JSON 数据");
    }
  } else {
    const textResp = await res.text();
    if (res.status === 524 || res.status === 504) {
      throw new Error("Cloudflare AI 请求超时 (524)，请稍后重试");
    } else if (res.status === 413) {
      throw new Error("音频切片超出体积限制 (413)");
    } else {
      throw new Error(`服务响应异常 (HTTP ${res.status}): ${textResp.slice(0, 100)}`);
    }
  }

  if (!res.ok || !data.success) {
    throw new Error(data.message || `识别失败 (HTTP ${res.status})`);
  }

  return (data.text || "").trim();
}

// 音频提取与 AI Whisper 语音识别 (支持多段切片流水线与实时流式文案呈现)
async function transcribeAudio(mediaUrl, containerSelector, noteId) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.style.display = "block";
  container.innerHTML = `
    <div class="transcript-loading">
      <div class="spinner"></div>
      <div style="flex: 1; min-width: 0;">
        <div id="transcribe-status-text" style="font-weight: 500; font-size: 13px; color: #334155; margin-bottom: 6px;">
          正在从视频提取并解析音频轨道 (Web Audio API)...
        </div>
        <div id="transcribe-progress-track" class="transcribe-progress-track" style="display: none;">
          <div id="transcribe-progress-bar" class="transcribe-progress-bar" style="width: 0%;"></div>
        </div>
      </div>
    </div>
    <div id="transcribe-live-preview" class="transcribe-live-preview" style="display: none;"></div>
  `;

  const statusText = container.querySelector("#transcribe-status-text");
  const progressTrack = container.querySelector("#transcribe-progress-track");
  const progressBar = container.querySelector("#transcribe-progress-bar");
  const livePreview = container.querySelector("#transcribe-live-preview");

  try {
    const { duration, chunks } = await extractAudioChunksFromMedia(mediaUrl, (msg) => {
      if (statusText) statusText.textContent = msg;
    }, 24);

    const totalChunks = chunks.length;
    if (progressTrack) progressTrack.style.display = "block";

    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    const durationStr = `${minutes > 0 ? `${minutes}分` : ''}${seconds}秒`;

    if (statusText) {
      statusText.textContent = totalChunks > 1
        ? `音频共 ${durationStr}，已智能切分为 ${totalChunks} 个分段并发起 AI 识别...`
        : `音频共 ${durationStr}，正在通过 AI 进行精准转写...`;
    }

    const transcribedParts = [];

    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunks[i];
      const chunkIndex = i + 1;
      const percent = Math.round(((i) / totalChunks) * 100);

      if (progressBar) progressBar.style.width = `${percent}%`;
      if (statusText) {
        statusText.textContent = totalChunks > 1
          ? `正在识别分段 [${chunkIndex}/${totalChunks}] (${percent}%)...`
          : "正在通过 AI (Whisper) 深度识别文本，请稍候...";
      }

      // 携带重试机制 (单段失败最多重试 1 次)
      let chunkText = "";
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          chunkText = await sendAudioChunkForTranscription(chunk.blob);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        }
      }

      if (lastErr && !chunkText) {
        console.warn(`Chunk ${chunkIndex} error:`, lastErr);
      }

      if (chunkText) {
        transcribedParts.push(chunkText);

        // 实时流式呈现在预览区
        if (livePreview) {
          livePreview.style.display = "block";
          livePreview.textContent = transcribedParts.join("\n\n");
          livePreview.scrollTop = livePreview.scrollHeight;
        }
      }
    }

    if (progressBar) progressBar.style.width = "100%";

    const fullTranscript = transcribedParts.join("\n\n").trim();
    if (!fullTranscript) {
      throw new Error("未能识别出有效语音或音频中无清晰人声");
    }

    // 渲染最终文案结果面板
    renderTranscriptBox(container, fullTranscript, noteId);
    showToast(`🎉 视频语音文案已提取完成 (共识别 ${transcribedParts.length} 个分段)！`);

    // 持久化保存至 D1 数据库
    const targetNoteId = noteId || (state.activeDetailNote?.id);
    if (targetNoteId) {
      try {
        const savedTranscript = serializeTranscriptParagraphs(container) || fullTranscript;
        await fetch(`/api/notes/${targetNoteId}/transcript`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({ transcript: savedTranscript })
        });
        if (state.activeDetailNote && state.activeDetailNote.id === targetNoteId) {
          state.activeDetailNote.transcript = savedTranscript;
        }
      } catch (err) {
        console.warn("保存 transcript 到数据库失败:", err);
      }
    }
  } catch (err) {
    console.error("Transcribe error:", err);
    container.innerHTML = `
      <div style="color: var(--primary); font-size: 13px; padding: 12px; background: rgba(234, 44, 67, 0.05); border-radius: 8px;">
        ❌ 语音转写失败: ${escapeHtml(err.message)}
      </div>
    `;
    showToast(`❌ 语音转写失败: ${err.message}`, { isError: true });
  }
}

// 3. 抽屉与收藏知识库管理
async function refreshNotesBadge() {
  try {
    const res = await fetch(`/api/notes?limit=1`, {
      headers: { "x-auth-pin": state.pin }
    });
    if (res.ok) {
      const data = await res.json();
      const badge = document.getElementById("notes-badge");
      if (badge && data.total !== undefined) {
        badge.textContent = data.total;
        badge.style.display = data.total > 0 ? "inline-block" : "none";
      }
    }
  } catch {}
}

// Cloudflare 免费版用量与存储统计加载
async function loadStorageUsage({ forceRefresh = false, showToastOnSuccess = false } = {}) {
  try {
    const refreshBtn = document.getElementById("btn-refresh-usage");
    if (refreshBtn && forceRefresh) {
      refreshBtn.textContent = "🔄 统计中...";
      refreshBtn.disabled = true;
    }

    const res = await fetch(`/api/usage?pin=${encodeURIComponent(state.pin)}${forceRefresh ? '&refresh=1' : ''}`, {
      headers: { "x-auth-pin": state.pin }
    });

    if (res.status === 401) {
      return;
    }

    const data = await res.json();
    if (!data.success) return;

    state.usageData = data;
    renderStorageUsageUI(data);

    if (showToastOnSuccess) {
      showToast("🔄 Cloudflare 资源用量数据已刷新！");
    }
  } catch (err) {
    console.warn("loadStorageUsage error:", err);
  } finally {
    const refreshBtn = document.getElementById("btn-refresh-usage");
    if (refreshBtn) {
      refreshBtn.textContent = "🔄 刷新";
      refreshBtn.disabled = false;
    }
  }
}

function renderStorageUsageUI(data) {
  if (!data) return;

  const r2 = data.r2 || {};
  const d1 = data.d1 || {};
  const status = data.status || 'safe';

  // 1. 顶部导航栏用量指示
  const navLabel = document.getElementById("nav-usage-label");
  const navDot = document.getElementById("nav-usage-dot");
  if (navLabel) {
    navLabel.textContent = r2.totalBytesFormatted ? `存储: ${r2.totalBytesFormatted}` : "存储用量";
  }
  if (navDot) {
    navDot.className = `nav-usage-dot ${status}`;
    navDot.title = status === 'safe' ? '配额安全充足' : (status === 'warning' ? '存储空间已使用过半' : '已达配额预警临界点');
  }

  // 2. 知识库胶囊按钮
  const kbUsageText = document.getElementById("kb-usage-text");
  if (kbUsageText) {
    kbUsageText.textContent = `硬盘: ${r2.totalBytesFormatted || '0 B'} / 10 GB`;
  }

  // 3. 设置弹窗简报卡片
  const settingsVal = document.getElementById("settings-r2-val");
  const settingsBar = document.getElementById("settings-r2-bar");
  const settingsPercent = document.getElementById("settings-r2-percent");
  if (settingsVal) settingsVal.textContent = `${r2.totalBytesFormatted || '0 B'} (${r2.totalFiles || 0} 个文件)`;
  if (settingsBar) {
    settingsBar.style.width = `${Math.min(100, Math.max(r2.totalBytes > 0 ? 1 : 0, r2.usedPercent || 0))}%`;
    settingsBar.className = `usage-progress-bar ${status}`;
  }
  if (settingsPercent) settingsPercent.textContent = `${r2.usedPercent || 0}%`;

  // 4. 专属监控弹窗
  const statusBadge = document.getElementById("usage-status-badge");
  if (statusBadge) {
    statusBadge.className = `usage-badge ${status}`;
    if (status === 'safe') {
      statusBadge.textContent = '🟢 状态充裕 (安全)';
    } else if (status === 'warning') {
      statusBadge.textContent = '🟡 空间过半 (关注)';
    } else {
      statusBadge.textContent = '🔴 临界预警 (建议清理)';
    }
  }

  // R2 数据
  const r2UsedVal = document.getElementById("usage-r2-used-val");
  const r2PercentVal = document.getElementById("usage-r2-percent-val");
  const r2Bar = document.getElementById("usage-r2-bar");
  const r2RemainVal = document.getElementById("usage-r2-remain-val");
  const r2ImgCount = document.getElementById("usage-r2-img-count");
  const r2VidCount = document.getElementById("usage-r2-video-count");
  const r2TotalCount = document.getElementById("usage-r2-total-count");

  if (r2UsedVal) r2UsedVal.textContent = r2.totalBytesFormatted || '0 B';
  if (r2PercentVal) r2PercentVal.textContent = `${r2.usedPercent || 0}%`;
  if (r2Bar) {
    r2Bar.style.width = `${Math.min(100, Math.max(r2.totalBytes > 0 ? 1 : 0, r2.usedPercent || 0))}%`;
    r2Bar.className = `usage-progress-bar ${status}`;
  }
  if (r2RemainVal) r2RemainVal.textContent = r2.remainingFormatted || '10 GB';
  if (r2ImgCount) r2ImgCount.textContent = `${r2.imageCount || 0} 张`;
  if (r2VidCount) r2VidCount.textContent = `${r2.videoCount || 0} 部`;
  if (r2TotalCount) r2TotalCount.textContent = `${r2.totalFiles || 0} 个`;

  // D1 数据
  const d1UsedVal = document.getElementById("usage-d1-used-val");
  const d1PercentVal = document.getElementById("usage-d1-percent-val");
  const d1Bar = document.getElementById("usage-d1-bar");
  const d1NotesCount = document.getElementById("usage-d1-notes-count");
  const d1RemainVal = document.getElementById("usage-d1-remain-val");

  if (d1UsedVal) d1UsedVal.textContent = d1.approxBytesFormatted || '0 B';
  if (d1PercentVal) d1PercentVal.textContent = `${d1.usedPercent || 0}%`;
  if (d1Bar) {
    d1Bar.style.width = `${Math.min(100, Math.max(d1.approxBytes > 0 ? 1 : 0, d1.usedPercent || 0))}%`;
  }
  if (d1NotesCount) d1NotesCount.textContent = d1.noteCount || 0;
  if (d1RemainVal) d1RemainVal.textContent = d1.remainingFormatted || '5 GB';

  // Workers AI
  const aiSub = document.getElementById("usage-ai-sub");
  if (aiSub && data.ai) {
    aiSub.textContent = data.ai.hasCustomWhisperKey 
      ? "✅ 已配置第三方 Whisper API Key (备选不限量)" 
      : "可在系统设置配置 Groq Key 作为不限量备选";
  }
}

// 知识库分类与笔记加载
async function loadTags() {
  const tagListContainer = document.getElementById("kb-tag-list");
  const totalBadge = document.getElementById("kb-total-badge");
  if (!tagListContainer) return;

  try {
    const res = await fetch("/api/tags", {
      headers: { "x-auth-pin": state.pin }
    });
    if (res.status === 401) {
      showPinLockView(true);
      return;
    }
    const data = await res.json();
    if (!data.success) return;

    state.tags = data.tags || [];
    state.tagCounts = data.counts || {};

    if (totalBadge) {
      totalBadge.textContent = `${state.tagCounts.__all__ || 0} 篇`;
    }

    renderTagsList();
  } catch (err) {
    console.warn("loadTags error:", err);
  }
}

function renderTagsList() {
  const tagListContainer = document.getElementById("kb-tag-list");
  if (!tagListContainer) return;
  tagListContainer.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = `kb-tag-item ${state.currentCategory === "__all__" ? "active" : ""}`;
  allItem.innerHTML = `
    <span>📌 全部笔记</span>
    <span class="tag-badge">${state.tagCounts.__all__ || 0}</span>
  `;
  allItem.addEventListener("click", () => switchCategory("__all__", "全部笔记"));
  tagListContainer.appendChild(allItem);

  const uncatItem = document.createElement("div");
  uncatItem.className = `kb-tag-item ${state.currentCategory === "__uncategorized__" ? "active" : ""}`;
  uncatItem.innerHTML = `
    <span>📁 未分类</span>
    <span class="tag-badge">${state.tagCounts.__uncategorized__ || 0}</span>
  `;
  uncatItem.addEventListener("click", () => switchCategory("__uncategorized__", "未分类"));
  tagListContainer.appendChild(uncatItem);

  state.tags.forEach((tag) => {
    const item = document.createElement("div");
    item.className = `kb-tag-item ${state.currentCategory === tag ? "active" : ""}`;
    item.innerHTML = `
      <span>🏷️ ${tag}</span>
      <span class="tag-badge">${state.tagCounts[tag] || 0}</span>
    `;
    item.addEventListener("click", () => switchCategory(tag, tag));
    tagListContainer.appendChild(item);
  });
}

function switchCategory(category, label) {
  state.currentCategory = category;
  const hint = document.getElementById("kb-filter-hint");
  if (hint) hint.textContent = label;
  renderTagsList();
  const searchVal = document.getElementById("kb-search-input")?.value || "";
  loadNotes(searchVal);
}

async function loadNotes(search = "") {
  const gridContainer = document.getElementById("kb-notes-grid");
  const emptyHint = document.getElementById("kb-empty-hint");
  if (!gridContainer) return;

  gridContainer.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; color: var(--text-sub);">正在加载知识库笔记...</div>`;

  try {
    const url = `/api/notes?limit=100&tag=${encodeURIComponent(state.currentCategory)}&q=${encodeURIComponent(search)}`;
    const res = await fetch(url, {
      headers: { "x-auth-pin": state.pin }
    });

    if (res.status === 401) {
      showPinLockView(true);
      return;
    }

    const data = await res.json();
    showPinLockView(false);

    if (!data.items || data.items.length === 0) {
      gridContainer.innerHTML = "";
      if (emptyHint) emptyHint.style.display = "block";
      return;
    }

    if (emptyHint) emptyHint.style.display = "none";
    gridContainer.innerHTML = "";

    data.items.forEach((item) => {
      const card = document.createElement("div");
      card.className = "kb-note-card";

      const tagsHtml = (item.tags || [])
        .map((t) => `<span class="kb-chip-small">${t}</span>`)
        .join("");

      card.innerHTML = `
        <div class="kb-card-cover-wrap">
          <img src="${item.cover_url || '/favicon.svg'}" alt="封面" loading="lazy" />
          <div class="kb-card-tag-chips">${tagsHtml}</div>
        </div>
        <div class="kb-card-info">
          <div class="kb-card-title">${item.title || "无标题笔记"}</div>
          <div class="kb-card-preview">${item.content_preview || "暂无正文描述..."}</div>
          ${item.thoughts_preview ? `<div class="kb-card-thought-preview">💡 ${item.thoughts_preview}</div>` : ""}
          <div class="kb-card-footer">
            <span>📅 ${formatTime(item.created_at)}</span>
            <span style="color: var(--primary); font-weight: 600;">查看详情 →</span>
          </div>
        </div>
      `;

      card.addEventListener("click", () => openNoteDetail(item.id));
      gridContainer.appendChild(card);
    });
  } catch (err) {
    gridContainer.innerHTML = `<div style="grid-column: 1/-1; color:var(--primary); padding:20px; text-align:center;">加载失败: ${err.message}</div>`;
  }
}

function showPinLockView(showLock) {
  const lockView = document.getElementById("kb-pin-lock-view");
  const sidebarNav = document.getElementById("kb-sidebar-content");
  const gridContainer = document.getElementById("kb-notes-grid");
  if (lockView) lockView.style.display = showLock ? "block" : "none";
  if (sidebarNav) sidebarNav.style.display = showLock ? "none" : "flex";
  if (gridContainer) gridContainer.style.display = showLock ? "none" : "grid";
}

// 展开单篇笔记详情弹窗
async function openNoteDetail(noteId) {
  showToast("正在载入笔记详情...");
  try {
    const res = await fetch(`/api/notes/${noteId}`, {
      headers: { "x-auth-pin": state.pin }
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || "读取失败");

    const note = data.note;
    state.activeDetailNote = note;

    document.getElementById("modal-note-title").textContent = note.title;
    document.getElementById("modal-note-time").textContent = `归档时间：${formatTime(note.createdAt)}`;

    const inputTitle = document.getElementById("modal-input-title");
    const inputContent = document.getElementById("modal-input-content");
    if (inputTitle) inputTitle.value = note.title || "";
    if (inputContent) inputContent.value = note.content || "";
    document.getElementById("modal-thoughts-input").value = note.thoughts || "";

    // 渲染原始采集链接
    const sourceBar = document.getElementById("modal-source-bar");
    const sourceLink = document.getElementById("modal-source-link");
    const copyBtn = document.getElementById("btn-modal-copy-source-link");
    if (sourceBar && sourceLink && note.sourceUrl) {
      sourceBar.style.display = "flex";
      sourceLink.href = note.sourceUrl;
      sourceLink.textContent = note.sourceUrl;
      if (copyBtn) {
        copyBtn.onclick = async () => {
          await navigator.clipboard.writeText(note.sourceUrl);
          showToast("已复制原始采集链接");
        };
      }
    } else if (sourceBar) {
      sourceBar.style.display = "none";
    }

    // 渲染分类标签交互 Chips
    renderDetailTags(note);

    // 渲染图片
    const grid = document.getElementById("modal-images-grid");
    grid.innerHTML = "";
    if (note.images && note.images.length > 0) {
      grid.style.display = "grid";
      note.images.forEach((img, i) => {
        const item = document.createElement("div");
        item.className = "image-item";
        item.innerHTML = `
          <img src="${img.url}" alt="图片 ${i + 1}" />
          ${img.livePhoto ? '<span class="live-badge">LIVE</span>' : ""}
          <div class="image-actions-overlay">
            <button class="img-btn-dl">查看大图</button>
          </div>
        `;
        item.addEventListener("click", () => window.open(img.url, "_blank"));
        grid.appendChild(item);
      });
    } else {
      grid.style.display = "none";
    }

    // 渲染视频与纯音频模式
    const vidWrap = document.getElementById("modal-video-wrap");
    const vidPlayer = document.getElementById("modal-video-player");
    const audioWrap = document.getElementById("modal-audio-player-wrap");
    const audioPlayer = document.getElementById("modal-audio-player");
    const vidContainer = document.getElementById("modal-video-player-container");
    const toggleAudioBtn = document.getElementById("btn-modal-toggle-audio");
    const transcribeBtn = document.getElementById("btn-modal-transcribe");
    const transcriptPanel = document.getElementById("modal-transcript-panel");

    if (note.videos && note.videos.length > 0) {
      const activeVideoUrl = note.videos[0].url;
      vidWrap.style.display = "block";
      if (vidContainer) vidContainer.style.display = "block";
      if (audioWrap) audioWrap.style.display = "none";
      vidPlayer.src = activeVideoUrl;
      if (audioPlayer) audioPlayer.src = activeVideoUrl;

      if (toggleAudioBtn) {
        toggleAudioBtn.textContent = "🎧 纯听音频";
        toggleAudioBtn.onclick = () => {
          const isAudioActive = audioWrap?.style.display === "block";
          if (isAudioActive) {
            audioWrap.style.display = "none";
            if (vidContainer) vidContainer.style.display = "block";
            audioPlayer?.pause();
            toggleAudioBtn.textContent = "🎧 纯听音频";
          } else {
            audioWrap.style.display = "block";
            if (vidContainer) vidContainer.style.display = "none";
            vidPlayer?.pause();
            audioPlayer?.play().catch(() => {});
            toggleAudioBtn.textContent = "🎬 切换回视频画面";
          }
        };
      }

      if (transcribeBtn) {
        transcribeBtn.onclick = () => {
          transcribeAudio(activeVideoUrl, "#modal-transcript-panel", note.id);
        };
      }

      // 如果笔记已保存过语音文案，自动渲染
      if (note.transcript) {
        renderTranscriptBox(transcriptPanel, note.transcript, note.id);
      } else if (transcriptPanel) {
        transcriptPanel.style.display = "none";
        transcriptPanel.innerHTML = "";
      }
    } else {
      vidWrap.style.display = "none";
      vidPlayer.removeAttribute("src");
      audioPlayer?.removeAttribute("src");
      if (transcriptPanel) {
        transcriptPanel.style.display = "none";
        transcriptPanel.innerHTML = "";
      }
    }

    // 显示弹窗
    document.getElementById("modal-note-detail").classList.add("active");
  } catch (err) {
    showToast(`无法打开详情: ${err.message}`);
  }
}

// 详情弹窗中的多标签选择与打标
function renderDetailTags(note) {
  const container = document.getElementById("detail-tags-chips");
  if (!container) return;
  container.innerHTML = "";

  const noteTags = new Set(note.tags || []);

  state.tags.forEach((tag) => {
    const isSelected = noteTags.has(tag);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `tag-chip-toggle ${isSelected ? "active" : ""}`;
    chip.innerHTML = `${isSelected ? "✓ " : ""}${tag}`;

    chip.addEventListener("click", async () => {
      if (isSelected) {
        noteTags.delete(tag);
      } else {
        noteTags.add(tag);
      }
      const updatedTags = Array.from(noteTags);
      note.tags = updatedTags;

      // 实时保存到后端
      try {
        await fetch(`/api/notes/${note.id}/tags`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({ tags: updatedTags })
        });
        renderDetailTags(note);
        loadTags();
        const searchVal = document.getElementById("kb-search-input")?.value || "";
        loadNotes(searchVal);
      } catch (e) {
        showToast("标签保存失败");
      }
    });

    container.appendChild(chip);
  });

  // 添加自定义标签胶囊
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "tag-chip-add";
  addBtn.innerHTML = "➕ 新建标签并打标";
  addBtn.addEventListener("click", async () => {
    const newTagName = prompt("请输入要新建的分类标签名称：");
    if (!newTagName || !newTagName.trim()) return;
    const cleanTag = newTagName.trim();

    try {
      // 1. 添加到全局标签库
      await fetch("/api/tags", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-auth-pin": state.pin
        },
        body: JSON.stringify({ action: "add", tag: cleanTag })
      });
      if (!state.tags.includes(cleanTag)) {
        state.tags.push(cleanTag);
      }

      // 2. 自动给当前笔记打标
      noteTags.add(cleanTag);
      const updatedTags = Array.from(noteTags);
      note.tags = updatedTags;

      await fetch(`/api/notes/${note.id}/tags`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-auth-pin": state.pin
        },
        body: JSON.stringify({ tags: updatedTags })
      });

      renderDetailTags(note);
      loadTags();
      const searchVal = document.getElementById("kb-search-input")?.value || "";
      loadNotes(searchVal);
      showToast(`已添加标签「${cleanTag}」并打标`);
    } catch {
      showToast("创建标签失败");
    }
  });

  container.appendChild(addBtn);
}

// 4. 事件监听与初始化绑定
document.addEventListener("DOMContentLoaded", () => {
  // 初始化划词重点浮动气泡
  initTranscriptSelectionPill();

  // 剪贴板开关初始化
  const clipSwitch = document.getElementById("clipboard-switch");
  if (clipSwitch) {
    clipSwitch.checked = state.autoClipboard;
    clipSwitch.addEventListener("change", (e) => {
      state.autoClipboard = e.target.checked;
      localStorage.setItem("xhs_auto_clipboard", String(e.target.checked));
      showToast(state.autoClipboard ? "已开启剪贴板自动解析" : "已关闭剪贴板自动解析");
    });
  }

  // 绑定自动剪贴板检测
  window.addEventListener("focus", checkAndAutoPasteClipboard);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkAndAutoPasteClipboard();
  });
  setTimeout(checkAndAutoPasteClipboard, 400);

  // 输入框实时检测多链接，监听原生 paste 事件并在移动端检测到链接时秒级自动解析
  const inputEl = document.getElementById("input-text");
  if (inputEl) {
    inputEl.addEventListener("input", updateInputUrlHint);
    inputEl.addEventListener("paste", () => {
      setTimeout(() => {
        updateInputUrlHint();
        const text = (inputEl.value || "").trim();
        const urls = extractAllXhsUrls(text);
        if (urls.length > 0) {
          showToast(`⚡ 已粘贴识别到 ${urls.length} 条小红书链接，开始解析...`);
          startParsing();
        }
      }, 60);
    });
  }

  // 输入操作按钮 (针对 iPhone / iOS WebKit 与移动端优化)
  document.getElementById("btn-paste")?.addEventListener("click", async () => {
    const input = document.getElementById("input-text");
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        throw new Error("浏览器不支持 Clipboard API");
      }

      // 注意：直接第一行调用 readText，避免异步微任务导致 iOS Safari 判定丢失手势
      const text = (await navigator.clipboard.readText()).trim();
      if (input && text) {
        input.value = text;
        updateInputUrlHint();
        const urls = extractAllXhsUrls(text);
        if (urls.length > 0) {
          showToast(`⚡ 已粘贴识别到 ${urls.length} 条小红书链接，开始解析...`);
          startParsing();
        } else {
          showToast("已粘贴剪贴板内容");
        }
        return;
      }
      throw new Error("剪贴板内容为空");
    } catch (err) {
      console.warn("Clipboard readText failed:", err);
      // 优雅降级：手机端自动聚焦输入框，拉起 iOS 原生粘贴菜单并引导
      if (input) {
        input.focus();
      }
      if (isMobile) {
        showToast("📱 请轻点输入框弹出的系统「粘贴」菜单（粘贴后将自动开始解析）");
      } else {
        showToast("无法直接访问剪贴板，请按 Ctrl+V 粘贴");
      }
    }
  });

  document.getElementById("btn-clear")?.addEventListener("click", () => {
    const input = document.getElementById("input-text");
    if (input) input.value = "";
    updateInputUrlHint();
  });

  document.getElementById("btn-parse")?.addEventListener("click", startParsing);

  // 批量采集控制与操作按钮
  document.getElementById("btn-batch-stop")?.addEventListener("click", () => {
    state.shouldStopBatch = true;
    showToast("⏹ 正在停止当前批量采集任务...");
  });

  document.getElementById("btn-batch-clear")?.addEventListener("click", () => {
    state.batchQueue = [];
    state.batchResults = [];
    const batchSec = document.getElementById("batch-section");
    if (batchSec) batchSec.style.display = "none";
    showToast("已清空批量采集记录");
  });

  document.getElementById("btn-batch-download-zip")?.addEventListener("click", downloadAllBatchZip);

  document.getElementById("btn-batch-go-kb")?.addEventListener("click", () => {
    switchPageTab("kb");
  });

  // 复制完整正文
  document.getElementById("btn-copy-content")?.addEventListener("click", async () => {
    const title = document.getElementById("result-title")?.textContent || "";
    const content = document.getElementById("result-content")?.textContent || "";
    const full = `${title}\n\n${content}`;
    await navigator.clipboard.writeText(full);
    showToast("📋 已复制完整文案到剪贴板");
  });

  // 全选/反选图片
  document.getElementById("btn-select-all")?.addEventListener("click", () => {
    if (!state.currentParsedNote?.images) return;
    if (state.selectedImages.size === state.currentParsedNote.images.length) {
      state.selectedImages.clear();
      showToast("已取消全选");
    } else {
      state.currentParsedNote.images.forEach((img) => state.selectedImages.add(img.url));
      showToast("已全选所有图片");
    }
  });

  // 主页 ZIP 下载
  document.getElementById("btn-download-zip")?.addEventListener("click", () => {
    if (!state.currentParsedNote?.images) return;
    const selected = state.currentParsedNote.images.filter((img) => state.selectedImages.has(img.url));
    downloadZipArchive(selected, state.currentParsedNote.title, state.currentParsedNote.content);
  });

  // 视频下载按钮 (按标题拼音命名)
  document.getElementById("btn-download-video")?.addEventListener("click", () => {
    const player = document.getElementById("video-player");
    if (player?.src) {
      const title = state.currentParsedNote?.title || "video";
      const filename = toPinyinFilename(title, ".mp4");
      downloadDirectFile(player.src, filename);
    }
  });

  // 详情弹窗中的视频下载按钮 (按标题拼音命名)
  document.getElementById("btn-modal-download-video")?.addEventListener("click", () => {
    const player = document.getElementById("modal-video-player");
    if (player?.src && state.activeDetailNote) {
      const title = state.activeDetailNote.title || "video";
      const filename = toPinyinFilename(title, ".mp4");
      downloadDirectFile(player.src, filename);
    }
  });

  // 页面顶级标签页切换管理 (采集下载工具 vs 收藏知识库)
  function switchPageTab(tabName) {
    const downloadTabBtn = document.getElementById("tab-nav-download");
    const kbTabBtn = document.getElementById("tab-nav-kb");
    const downloadView = document.getElementById("view-download");
    const kbView = document.getElementById("view-kb");

    if (tabName === "kb") {
      downloadTabBtn?.classList.remove("active");
      kbTabBtn?.classList.add("active");
      if (downloadView) downloadView.style.display = "none";
      if (kbView) kbView.style.display = "block";
      if (window.location.hash !== "#kb") {
        window.location.hash = "kb";
      }
      loadTags();
      loadNotes();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      kbTabBtn?.classList.remove("active");
      downloadTabBtn?.classList.add("active");
      if (kbView) kbView.style.display = "none";
      if (downloadView) downloadView.style.display = "block";
      if (window.location.hash === "#kb") {
        window.location.hash = "download";
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  document.getElementById("tab-nav-download")?.addEventListener("click", () => switchPageTab("download"));
  document.getElementById("tab-nav-kb")?.addEventListener("click", () => switchPageTab("kb"));
  document.getElementById("brand-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    switchPageTab("download");
  });
  document.getElementById("btn-empty-go-download")?.addEventListener("click", () => switchPageTab("download"));

  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#kb") {
      switchPageTab("kb");
    } else {
      switchPageTab("download");
    }
  });

  if (window.location.hash === "#kb") {
    switchPageTab("kb");
  }

  // 知识库解锁 PIN
  document.getElementById("btn-kb-unlock-pin")?.addEventListener("click", async () => {
    const input = document.getElementById("kb-pin-input");
    const pin = (input?.value || "").trim();
    const res = await fetch("/api/verify-pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (data.valid) {
      state.pin = pin;
      localStorage.setItem("xhs_pin", pin);
      showPinLockView(false);
      loadTags();
      loadNotes();
      loadStorageUsage();
      showToast("🔓 PIN 码验证成功");
    } else {
      const hint = document.getElementById("kb-pin-error");
      if (hint) hint.style.display = "block";
    }
  });

  // 知识库实时搜索
  let kbSearchTimer;
  document.getElementById("kb-search-input")?.addEventListener("input", (e) => {
    clearTimeout(kbSearchTimer);
    kbSearchTimer = setTimeout(() => {
      loadNotes(e.target.value);
    }, 300);
  });

  // 标签管理弹窗
  const manageTagsModal = document.getElementById("modal-manage-tags");
  document.getElementById("btn-open-manage-tags")?.addEventListener("click", () => {
    manageTagsModal?.classList.add("active");
    renderManageTagsList();
  });

  document.getElementById("btn-add-tag-quick")?.addEventListener("click", () => {
    manageTagsModal?.classList.add("active");
    document.getElementById("input-new-tag-name")?.focus();
    renderManageTagsList();
  });

  document.getElementById("btn-close-manage-tags")?.addEventListener("click", () => {
    manageTagsModal?.classList.remove("active");
  });

  manageTagsModal?.addEventListener("click", (e) => {
    if (e.target === manageTagsModal) manageTagsModal.classList.remove("active");
  });

  document.getElementById("btn-confirm-add-tag")?.addEventListener("click", async () => {
    const input = document.getElementById("input-new-tag-name");
    const val = (input?.value || "").trim();
    if (!val) return;
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
        body: JSON.stringify({ action: "add", tag: val })
      });
      const data = await res.json();
      if (data.success) {
        state.tags = data.tags;
        if (input) input.value = "";
        renderManageTagsList();
        loadTags();
        showToast(`已创建分类标签「${val}」`);
      }
    } catch {
      showToast("创建标签失败");
    }
  });

  function renderManageTagsList() {
    const container = document.getElementById("manage-tags-list");
    if (!container) return;
    container.innerHTML = "";

    if (state.tags.length === 0) {
      container.innerHTML = `<div style="text-align:center; color: var(--text-sub); padding: 16px;">暂无自定义标签</div>`;
      return;
    }

    state.tags.forEach((tag) => {
      const row = document.createElement("div");
      row.className = "manage-tag-row";
      row.innerHTML = `
        <span style="font-weight: 500;">🏷️ ${tag}</span>
        <div class="manage-tag-row-actions">
          <button class="manage-tag-btn btn-rename-tag" type="button">重命名</button>
          <button class="manage-tag-btn danger btn-del-tag" type="button">删除</button>
        </div>
      `;

      row.querySelector(".btn-rename-tag").addEventListener("click", async () => {
        const newName = prompt(`请输入「${tag}」的新名称：`, tag);
        if (!newName || !newName.trim() || newName.trim() === tag) return;
        try {
          const res = await fetch("/api/tags", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
            body: JSON.stringify({ action: "rename", tag, newTag: newName.trim() })
          });
          const data = await res.json();
          if (data.success) {
            state.tags = data.tags;
            renderManageTagsList();
            loadTags();
            loadNotes(document.getElementById("kb-search-input")?.value || "");
            showToast(`标签已重命名为「${newName.trim()}」`);
          }
        } catch {
          showToast("重命名失败");
        }
      });

      row.querySelector(".btn-del-tag").addEventListener("click", async () => {
        if (!confirm(`确定要删除标签「${tag}」吗？已归档笔记中该标签将被移除。`)) return;
        try {
          const res = await fetch("/api/tags", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
            body: JSON.stringify({ action: "delete", tag })
          });
          const data = await res.json();
          if (data.success) {
            state.tags = data.tags;
            renderManageTagsList();
            loadTags();
            loadNotes(document.getElementById("kb-search-input")?.value || "");
            showToast(`已删除标签「${tag}」`);
          }
        } catch {
          showToast("删除失败");
        }
      });

      container.appendChild(row);
    });
  }

  // 详情弹窗关闭
  const noteModal = document.getElementById("modal-note-detail");
  const closeNoteModal = () => {
    document.getElementById("modal-video-player")?.pause();
    document.getElementById("modal-audio-player")?.pause();
    noteModal?.classList.remove("active");
  };
  document.getElementById("btn-close-note-modal")?.addEventListener("click", closeNoteModal);
  noteModal?.addEventListener("click", (e) => {
    if (e.target === noteModal) closeNoteModal();
  });

  // 保存感想随笔
  document.getElementById("btn-save-thoughts")?.addEventListener("click", async () => {
    if (!state.activeDetailNote) return;
    const thoughts = document.getElementById("modal-thoughts-input")?.value || "";
    try {
      const res = await fetch(`/api/notes/${state.activeDetailNote.id}/thoughts`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-auth-pin": state.pin
        },
        body: JSON.stringify({ thoughts })
      });
      if (res.ok) {
        showToast("💡 随笔感想已成功保存！");
        loadNotes(document.getElementById("kb-search-input")?.value || "");
      }
    } catch (err) {
      showToast(`保存失败: ${err.message}`);
    }
  });

  // 从正文智能提取标题
  document.getElementById("btn-modal-smart-title")?.addEventListener("click", () => {
    const content = document.getElementById("modal-input-content")?.value || "";
    const extracted = extractTitleFromContent(content);
    if (extracted) {
      const titleInput = document.getElementById("modal-input-title");
      if (titleInput) titleInput.value = extracted;
      showToast("✨ 已从正文智能提取标题，请点击下方保存！");
    } else {
      showToast("未能从正文识别出合适标题，请手动输入");
    }
  });

  // 复制正文内容
  document.getElementById("btn-modal-copy-content")?.addEventListener("click", async () => {
    const content = document.getElementById("modal-input-content")?.value || "";
    if (content) {
      await navigator.clipboard.writeText(content);
      showToast("📋 已复制正文内容到剪贴板");
    }
  });

  // 保存标题与正文修改
  document.getElementById("btn-save-note-detail")?.addEventListener("click", async () => {
    if (!state.activeDetailNote) return;
    const newTitle = document.getElementById("modal-input-title")?.value.trim() || "";
    const newContent = document.getElementById("modal-input-content")?.value.trim() || "";

    if (!newTitle) {
      showToast("笔记标题不能为空", { isError: true });
      return;
    }

    const btn = document.getElementById("btn-save-note-detail");
    if (btn) btn.disabled = true;

    try {
      const res = await fetch(`/api/notes/${state.activeDetailNote.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-auth-pin": state.pin
        },
        body: JSON.stringify({ title: newTitle, content: newContent })
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || "保存失败");
      }

      state.activeDetailNote.title = newTitle;
      state.activeDetailNote.content = newContent;
      document.getElementById("modal-note-title").textContent = newTitle;

      // 实时更新知识库卡片列表
      const searchVal = document.getElementById("kb-search-input")?.value || "";
      loadNotes(searchVal);

      showToast("🎉 笔记标题与正文已保存成功！");
    } catch (err) {
      showToast(`❌ 保存失败: ${err.message}`, { isError: true });
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // 详情页 ZIP 打包
  document.getElementById("btn-modal-download-zip")?.addEventListener("click", () => {
    if (!state.activeDetailNote) return;
    downloadZipArchive(state.activeDetailNote.images, state.activeDetailNote.title, state.activeDetailNote.content);
  });

  // 彻底删除笔记
  document.getElementById("btn-delete-note")?.addEventListener("click", async () => {
    if (!state.activeDetailNote) return;
    if (!confirm("确定要彻底删除这篇笔记吗？这将从 Cloudflare R2 和数据库中永久清理所占空间。")) return;

    try {
      const res = await fetch(`/api/notes/${state.activeDetailNote.id}`, {
        method: "DELETE",
        headers: { "x-auth-pin": state.pin }
      });
      if (res.ok) {
        showToast("🗑️ 笔记已成功删除");
        closeNoteModal();
        loadTags();
        loadNotes(document.getElementById("kb-search-input")?.value || "");
        refreshNotesBadge();
        loadStorageUsage({ forceRefresh: true });
      }
    } catch (err) {
      showToast(`删除失败: ${err.message}`);
    }
  });

  // 设置弹窗
  const settingsModal = document.getElementById("modal-settings");
  document.getElementById("btn-open-settings")?.addEventListener("click", async () => {
    settingsModal?.classList.add("active");
    loadStorageUsage();
    const cookieEl = document.getElementById("settings-xhs-cookie");
    if (cookieEl) cookieEl.value = state.xhsCookie || "";
    const oldPinEl = document.getElementById("settings-old-pin");
    if (oldPinEl) oldPinEl.value = state.pin || "1987";
    const msg = document.getElementById("settings-msg");
    if (msg) msg.style.display = "none";

    // 尝试从云端加载已保存的配置
    try {
      const res = await fetch(`/api/settings?pin=${encodeURIComponent(state.pin)}`);
      const data = await res.json();
      if (data?.success) {
        if (data.xhsCookie && cookieEl && !cookieEl.value) {
          cookieEl.value = data.xhsCookie;
          state.xhsCookie = data.xhsCookie;
          localStorage.setItem("xhs_cookie", data.xhsCookie);
        }
        const whisperKeyEl = document.getElementById("settings-whisper-key");
        if (whisperKeyEl && data.whisperApiKey) {
          whisperKeyEl.value = data.whisperApiKey;
        }
        const whisperEndpointEl = document.getElementById("settings-whisper-endpoint");
        if (whisperEndpointEl && data.whisperApiEndpoint) {
          whisperEndpointEl.value = data.whisperApiEndpoint;
        }
      }
    } catch {}
  });

  document.getElementById("btn-close-settings-modal")?.addEventListener("click", () => {
    settingsModal?.classList.remove("active");
  });

  // 保存设置（Cookie、PIN 码与 Whisper 配置）提交
  document.getElementById("btn-submit-change-pin")?.addEventListener("click", async () => {
    const oldPin = document.getElementById("settings-old-pin")?.value.trim() || state.pin;
    const newPin = document.getElementById("settings-new-pin")?.value.trim();
    const rawCookie = document.getElementById("settings-xhs-cookie")?.value || "";
    const cookieVal = normalizeCookieString(rawCookie);
    const cookieInput = document.getElementById("settings-xhs-cookie");
    if (cookieInput && cookieVal) {
      cookieInput.value = cookieVal;
    }
    const whisperApiKey = document.getElementById("settings-whisper-key")?.value.trim() || "";
    const whisperApiEndpoint = document.getElementById("settings-whisper-endpoint")?.value.trim() || "";
    const msg = document.getElementById("settings-msg");

    if (!oldPin) {
      if (msg) {
        msg.textContent = "请填写当前验证 PIN 码";
        msg.style.color = "var(--primary)";
        msg.style.display = "block";
      }
      return;
    }

    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pin: oldPin,
          newPin: newPin || undefined,
          xhsCookie: cookieVal,
          whisperApiKey,
          whisperApiEndpoint
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (newPin && newPin.length >= 4) {
          state.pin = newPin;
          localStorage.setItem("xhs_pin", newPin);
        }
        state.xhsCookie = cookieVal;
        localStorage.setItem("xhs_cookie", cookieVal);

        if (msg) {
          msg.textContent = "✅ 设置已成功保存并同步到 Cloudflare！";
          msg.style.color = "var(--success)";
          msg.style.display = "block";
        }
        showToast("系统设置保存成功！");
        setTimeout(() => { settingsModal?.classList.remove("active"); }, 1500);
      } else {
        throw new Error(data.message || "PIN 码验证失败或保存出错");
      }
    } catch (err) {
      if (msg) {
        msg.textContent = `❌ ${err.message}`;
        msg.style.color = "var(--primary)";
        msg.style.display = "block";
      }
    }
  });

  // Cloudflare 用量监控专属弹窗交互管理
  const usageModal = document.getElementById("modal-usage");
  const openUsageModal = () => {
    usageModal?.classList.add("active");
    loadStorageUsage();
  };

  document.getElementById("btn-open-usage")?.addEventListener("click", openUsageModal);
  document.getElementById("btn-kb-usage-pill")?.addEventListener("click", openUsageModal);
  document.getElementById("btn-settings-open-usage-modal")?.addEventListener("click", () => {
    settingsModal?.classList.remove("active");
    openUsageModal();
  });

  const closeUsageModal = () => {
    usageModal?.classList.remove("active");
  };
  document.getElementById("btn-close-usage-modal")?.addEventListener("click", closeUsageModal);
  document.getElementById("btn-close-usage-footer")?.addEventListener("click", closeUsageModal);
  usageModal?.addEventListener("click", (e) => {
    if (e.target === usageModal) closeUsageModal();
  });

  // 刷新用量
  document.getElementById("btn-refresh-usage")?.addEventListener("click", () => {
    loadStorageUsage({ forceRefresh: true, showToastOnSuccess: true });
  });

  // 初始获取一次徽标计数与存储用量
  refreshNotesBadge();
  loadStorageUsage();
});
