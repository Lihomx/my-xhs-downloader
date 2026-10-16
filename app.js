import { makeZipBlob, makeNoteTextFileData } from "./lib/archive.js";
import { toPinyinFilename } from "./lib/pinyin.js";
import { extractWavFromMedia, extractFullWavFromMedia, extractAudioChunksFromMedia } from "./lib/audio.js";

// ========================================================
// 离线媒体缓存管理系统 (IndexedDB + Blob URL)
// 支持断网继续播放与自由拖拽进度条 (0 延迟即时跳转)
// ========================================================
const OFFLINE_DB_NAME = "xhs_offline_media_db";
const OFFLINE_DB_VERSION = 1;
const OFFLINE_STORE_NAME = "media_blobs";

let _offlineDbPromise = null;
function getOfflineDb() {
  if (!_offlineDbPromise) {
    _offlineDbPromise = new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !window.indexedDB) {
        return resolve(null);
      }
      const req = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
          db.createObjectStore(OFFLINE_STORE_NAME, { keyPath: "url" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  return _offlineDbPromise;
}

export const OfflineMediaManager = {
  // 获取本地缓存的 Blob
  async getBlob(url) {
    if (!url) return null;
    try {
      const db = await getOfflineDb();
      if (!db) return null;
      return new Promise((resolve) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readonly");
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const req = store.get(url);
        req.onsuccess = () => resolve(req.result?.blob || null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  },

  // 存储 Blob 到本地 IndexedDB
  async saveBlob(url, blob, meta = {}) {
    if (!url || !blob) return;
    try {
      const db = await getOfflineDb();
      if (!db) return;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readwrite");
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const req = store.put({
          url,
          blob,
          size: blob.size,
          type: blob.type,
          noteId: meta.noteId || "",
          title: meta.title || "",
          coverUrl: meta.coverUrl || "",
          transcript: meta.transcript || "",
          tags: meta.tags || [],
          cachedAt: Date.now()
        });
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
      });
    } catch (e) {
      console.warn("Save offline blob error:", e);
    }
  },

  // 缓存远端媒体 URL 到本地
  async cacheUrl(url, meta = {}) {
    if (!url) return null;
    const existing = await this.getBlob(url);
    if (existing) return existing;

    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const blob = await res.blob();
      await this.saveBlob(url, blob, meta);
      return blob;
    } catch (e) {
      console.warn("Cache media URL error:", url, e);
      return null;
    }
  },

  // 检查是否已离线缓存
  async has(url) {
    const b = await this.getBlob(url);
    return Boolean(b);
  },

  // 删除离线缓存
  async delete(url) {
    if (!url) return;
    try {
      const db = await getOfflineDb();
      if (!db) return;
      const tx = db.transaction(OFFLINE_STORE_NAME, "readwrite");
      tx.objectStore(OFFLINE_STORE_NAME).delete(url);
    } catch {}
  },

  // 获取全部已离线缓存的 URL 集合
  async getAllCachedUrls() {
    try {
      const db = await getOfflineDb();
      if (!db) return new Set();
      return new Promise((resolve) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readonly");
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(new Set(req.result || []));
        req.onerror = () => resolve(new Set());
      });
    } catch {
      return new Set();
    }
  },

  // 获取本地已离线缓存的全部音频曲目 (供断网环境下随身听电台离线播放)
  async getAllCachedTracks() {
    try {
      const db = await getOfflineDb();
      if (!db) return [];
      return new Promise((resolve) => {
        const tx = db.transaction(OFFLINE_STORE_NAME, "readonly");
        const store = tx.objectStore(OFFLINE_STORE_NAME);
        const req = store.getAll();
        req.onsuccess = () => {
          const list = (req.result || []).map((r) => ({
            id: r.noteId || r.url,
            title: r.title || "离线随身听音频",
            coverUrl: r.coverUrl || "",
            mediaUrl: r.url,
            audioUrl: r.url,
            transcript: r.transcript || "",
            tags: r.tags || [],
            isOfflineOnly: true
          }));
          resolve(list);
        };
        req.onerror = () => resolve([]);
      });
    } catch {
      return [];
    }
  },

  // 获取可播放媒体源 (如果是本地 Blob 则生成 ObjectURL，断网也可无缝播放且拖拽进度条 0 延迟；未缓存则后台静默预存)
  async getPlayableSource(url, meta = {}) {
    if (!url) return { src: "", isOffline: false };
    const localBlob = await this.getBlob(url);
    if (localBlob) {
      const objectUrl = URL.createObjectURL(localBlob);
      return { src: objectUrl, isOffline: true, blob: localBlob };
    }

    // 后台静默预缓存（供断网无缝播放）
    if (navigator.onLine) {
      setTimeout(() => {
        this.cacheUrl(url, meta).catch(() => {});
      }, 500);
    }

    return { src: url, isOffline: false };
  }
};

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
  filterMode: "tags",
  currentAuthor: "__all__",
  authors: [],
  unknownAuthorCount: 0,
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

// 格式化相对时间 (用于提取看板与活动记录)
function formatRelativeTime(timestamp) {
  if (!timestamp) return "";
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 60) return "刚刚";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}小时前`;
  if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)}天前`;
  const d = new Date(timestamp);
  return `${d.getMonth() + 1}/${d.getDate()}`;
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

  // 笔记博主账号与主页链接展示
  const authorBar = document.getElementById("result-author-bar");
  const authorNameEl = document.getElementById("result-author-name");
  const authorLinkEl = document.getElementById("result-author-link");
  const copyAuthorBtn = document.getElementById("btn-copy-author-link");
  const authorName = (note.authorName || note.user?.nickname || "").trim();
  const authorProfileUrl = (note.authorProfileUrl || note.user?.profileUrl || (note.authorId || note.user?.userId ? `https://www.xiaohongshu.com/user/profile/${note.authorId || note.user?.userId}` : "")).trim();

  if (authorBar && (authorName || authorProfileUrl)) {
    authorBar.style.display = "flex";
    if (authorNameEl) {
      authorNameEl.textContent = authorName || "（未提供昵称）";
    }
    if (authorLinkEl) {
      if (authorProfileUrl) {
        authorLinkEl.style.display = "inline";
        authorLinkEl.href = authorProfileUrl;
        authorLinkEl.textContent = authorProfileUrl;
      } else {
        authorLinkEl.style.display = "none";
      }
    }
    if (copyAuthorBtn) {
      if (authorProfileUrl) {
        copyAuthorBtn.style.display = "inline-block";
        copyAuthorBtn.onclick = async () => {
          await navigator.clipboard.writeText(authorProfileUrl);
          showToast("已复制博主主页链接");
        };
      } else {
        copyAuthorBtn.style.display = "none";
      }
    }
  } else if (authorBar) {
    authorBar.style.display = "none";
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

    // 智能提取字幕与语音文案 (优先软字幕 -> 探测硬字幕 -> 自动启用语音转写)
    const transcribeBtn = document.getElementById("btn-transcribe-video");
    if (transcribeBtn) {
      transcribeBtn.onclick = () => {
        extractVideoSubtitlesOrAudio(activeUrl, "#transcript-panel", note.noteId || note.id, videoPlayer);
      };
    }

    // 独立画面硬字幕视觉提取按钮 (标准极速)
    const ocrBtn = document.getElementById("btn-ocr-video");
    if (ocrBtn) {
      ocrBtn.onclick = () => {
        extractVideoHardSubtitles(activeUrl, "#transcript-panel", note.noteId || note.id, { fallbackToSpeech: true });
      };
    }

    // 慢速精细画面字幕提取按钮 (放慢节奏、密集采样、杜绝遗漏)
    const slowOcrBtn = document.getElementById("btn-slow-ocr-video");
    if (slowOcrBtn) {
      slowOcrBtn.onclick = () => {
        extractVideoHardSubtitles(activeUrl, "#transcript-panel", note.noteId || note.id, {
          isSlowMode: true,
          stepSec: 1.6,
          batchDelayMs: 2500,
          fallbackToSpeech: true
        });
      };
    }

    // 双模对比提取按钮 (慢速画面字幕 VS AI 语音转写，并排对比预览后手工采纳)
    const dualExtractBtn = document.getElementById("btn-dual-extract-video");
    if (dualExtractBtn) {
      dualExtractBtn.onclick = () => {
        runDualSubtitleExtraction(activeUrl, "#transcript-panel", note.noteId || note.id);
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
          authorName: note.authorName || note.user?.nickname || "",
          authorId: note.authorId || note.user?.userId || "",
          authorProfileUrl: note.authorProfileUrl || note.user?.profileUrl || "",
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

      // 只要是新增加的视频笔记，自动由后台以从容慢速提取画面硬字幕
      const autoBgOcr = localStorage.getItem("xhs_auto_bg_ocr") !== "false";
      if (autoBgOcr && Array.isArray(note.videos) && note.videos.length > 0 && !note.transcript) {
        BackgroundSubtitleQueue.enqueue(note);
      }
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

// 常见语音识别（ASR）同音错别字与成语语义修正表
function correctSpeechTypos(text) {
  if (!text) return "";
  let s = String(text);
  s = s.replace(/区利避害/g, "趋利避害");
  s = s.replace(/是号一个劳的|是号一个劳/g, "是好逸恶劳的");
  s = s.replace(/不知的任务不跟[，\s]*进|不知的任务不跟进/g, "布置的任务不跟进");
  s = s.replace(/用线机盘到最后|用线机盘/g, "期限拖到最后");
  s = s.replace(/下属技在心里|技在心里/g, "下属记在心里");
  s = s.replace(/东平吸凑/g, "东拼西凑");
  s = s.replace(/争议之眼必之一眼|争议之眼/g, "睁一只眼闭一只眼");
  s = s.replace(/直接汽权|直接气权/g, "直接弃权");
  s = s.replace(/在堵薄|在堵博/g, "在赌博");
  s = s.replace(/彻底点响了我/g, "彻底点醒了我");
  s = s.replace(/天涯隐学理/g, "天涯隐学里");
  s = s.replace(/下属感互怒/g, "下属敢怒不敢言");
  s = s.replace(/向了监工/g, "像个监工");
  s = s.replace(/彻底放全/g, "彻底放权");
  s = s.replace(/很抓检查/g, "狠抓检查");
  s = s.replace(/团队执行类/g, "团队执行力");
  s = s.replace(/执行类(?=[的人性的天花板强])/g, "执行力");
  return s;
}

// 智能中文启发式标点恢复与精准断句引擎
function autoPunctuateChinese(raw) {
  let s = correctSpeechTypos(String(raw || "").trim());
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
  s = s.replace(/(我以前也不是这样|以前也不是这样)(?=[，,、\s]*(?:刚当|那时候|当时))/g, '$1。\n');
  s = s.replace(/(下属也烦的|下属也烦|把自己累死)(?=[，,、\s]*(?:我要么|我彻底))/g, '$1。\n');
  s = s.replace(/(用人不疑|用人疑人)(?=[，,、\s]*(?:结果))/g, '$1。\n');
  s = s.replace(/(烂的一塌糊涂|一塌糊涂)(?=[，,、\s]*(?:后来))/g, '$1。\n');
  s = s.replace(/(彻底点响了我|彻底点醒了我)(?=[，,、\s]*(?:你的问题))/g, '$1。\n');
  s = s.replace(/(交代当成的结果|交代当成了结果|工作当成结果)(?=[，,、\s]*(?:授权|如果|所以|但是|并且))/g, '$1。\n');
  s = s.replace(/(等于直接汽权|等于直接气权|等于直接弃权)(?=[，,、\s]*(?:那一刻|这个时候|后来|从此|所以|管理者的检查力度|管理者))/g, '$1。\n');
  s = s.replace(/(缺一不可|至关重要|显而易见)(?=[，,、\s]*(?:为什么|很多|大家))/g, '$1。\n');
  s = s.replace(/(自由发挥)(?=[，,、\s]*(?:错|对|但是|然而|所以|很多人|很多))/g, '$1。\n');
  s = s.replace(/(不知道自己要做什么)(?=[，,、\s]*(?:第二|其次|另外))/g, '$1。\n');
  s = s.replace(/(三天打鱼两天晒网)(?=[，,、\s]*(?:第三|其次|最后))/g, '$1。\n');

  // 10.1 口语发问与反问词断句转为问号
  s = s.replace(/([^，。！？\n]{2,}?(?:多少钱|多少|为啥|凭啥|怎么|咋|什么|啥|能优惠不|能[^\n，。！？]{1,4}不|行不|好不|对不|是不是|在哪|几点))([，\s]+|$)/g, '$1？\n');

  // 10.2 呼语与应答对话切分 (例如：老板来份、好嘞、行、奶奶、小伙子、小娃子)
  s = s.replace(/([，\s]*)(好好好|好嘞|行|都听你的|老板来份|老板|奶奶|大叔|师傅|小伙子|小娃子|小叔|小哥)(?=[，\s\u4e00-\u9fa5])/g, '。\n$2，');

  // 10.3 强烈语气与感叹
  s = s.replace(/([^，。！？\n]{2,}?(?:太厉害了|好嘞|都听你的|错|真棒|干得漂亮))([，\s]+|$)/g, '$1！\n');

  // 10.4 动宾完结短句切分标志
  s = s.replace(/(卖给你|买下来|分两堆|卖完了|你去吧|先留个[^\n，。！？]+?)(?=[，,、\s])/g, '$1。\n');

  // 11. 韵律长度分段保底：如果一个长子句在逗号之间超过 18 个字且已有停顿，将过长的逗号升级为句号换行
  s = s.replace(/([^\n。！？]{15,30})[，,](?=[^\n。！？]{6,})/g, '$1。\n');

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

// 将 HTML 字符串按句号、问号、感叹号安全拆分为独立单句
function splitHtmlIntoSentences(html) {
  if (!html) return [];
  const parts = [];
  const tokens = html.split(/([。！？!?]+)/);
  for (let i = 0; i < tokens.length; i += 2) {
    const textPart = tokens[i]?.trim();
    const puncPart = tokens[i + 1] || "";
    if (textPart) {
      let sent = textPart + (puncPart || "。");
      // 检查标签未闭合情况（如 <mark> 在本句中未闭合）
      const openMarks = (sent.match(/<mark\b[^>]*>/gi) || []).length;
      const closeMarks = (sent.match(/<\/mark>/gi) || []).length;
      if (openMarks > closeMarks) {
        sent += "</mark>";
      } else if (closeMarks > openMarks) {
        sent = "<mark class=\"transcript-hl\">" + sent;
      }
      parts.push(sent);
    }
  }
  return parts.length > 0 ? parts : [html];
}

// 全文合并、智能标点与单句独立成段：一个句号/问号/感叹号为一个段落
function formatBySentences(rawText) {
  if (!rawText) return [];

  // 1. 全文合并为单一连续文本，消除原有切片换行干扰，清除已有 ¶ 编号标记，并将全角半角标点统一规范
  let s = String(rawText)
    .replace(/¶\s*\d+[:：\s]*/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[，,、]\s*\n/g, "，")
    .replace(/([^\n。！？!?”’"')\]）】])\n+/g, "$1。\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/,/g, "，")
    .replace(/\?/g, "？")
    .replace(/!/g, "！")
    .replace(/;/g, "；")
    .replace(/:/g, "：")
    .trim();

  // 2. 启发式补全标点与语义断句标志
  s = autoPunctuateChinese(s);

  // 3. 核心分段逻辑：一个句号（以及？、！）为一个段落，同时严密保护后双引号与括号不被分离错位
  const sentences = [];
  const tokens = s.split(/([。！？!?]+[”’"')\]）】]*|\n+)/);
  for (let i = 0; i < tokens.length; i += 2) {
    const textPart = tokens[i]?.trim();
    const puncPart = tokens[i + 1]?.trim() || "";
    if (textPart) {
      let line = textPart;
      const matchedPunc = puncPart.match(/[。！？!?][”’"')\]）】]*/);
      const punc = matchedPunc ? matchedPunc[0].replace(/\s+/g, "") : "。";
      line += punc;
      // 清理句首多余逗号与句末异常标点
      line = line.replace(/^[，\s]+/, "").replace(/，([。！？])/g, "$1").replace(/([。！？])\s*，/g, "$1");
      if (line.replace(/[，。！？\s”’"')\]）】]/g, "").length > 0) {
        sentences.push(line);
      }
    }
  }

  return sentences;
}


// 时间戳格式化 (秒数转 MM:SS 或 HH:MM:SS)
function formatTimestamp(sec) {
  if (typeof sec !== "number" || isNaN(sec) || sec < 0) sec = 0;
  const totalSec = Math.floor(sec);
  const s = totalSec % 60;
  const m = Math.floor((totalSec / 60) % 60);
  const h = Math.floor(totalSec / 3600);
  const sStr = String(s).padStart(2, "0");
  const mStr = String(m).padStart(2, "0");
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${mStr}:${sStr}`;
  }
  return `${mStr}:${sStr}`;
}

// 时间戳字符串解析为秒数
function parseTimestampToSeconds(str) {
  if (!str) return 0;
  const clean = String(str).replace(/[^\d:]/g, "").trim();
  const parts = clean.split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

// 同步跳转播放页面或弹窗中的媒体 (视频或音频)
function seekAllMediaTo(seconds) {
  if (typeof seconds !== "number" || isNaN(seconds) || seconds < 0) return;
  const detailModal = document.getElementById("modal-note-detail");
  const isModalActive = detailModal && (detailModal.classList.contains("active") || detailModal.style.display === "block" || detailModal.style.display === "flex");

  const candidates = [];
  if (isModalActive) {
    candidates.push(document.getElementById("modal-video-player"));
    candidates.push(document.getElementById("modal-audio-player"));
  }
  candidates.push(document.getElementById("video-player"));
  candidates.push(document.getElementById("audio-player"));
  candidates.push(document.getElementById("shuffle-audio-element"));

  let sought = false;
  for (const media of candidates) {
    if (media && (media.src || media.currentSrc)) {
      try {
        media.currentTime = seconds;
        media.play().catch(() => {});
        sought = true;
      } catch (e) {
        console.warn("Media seek error:", e);
      }
    }
  }

  if (sought) {
    showToast(`⏱️ 已跳转至 ${formatTimestamp(seconds)} 处同步播放`);
  }
}

// 解析语音文案为段落列表 [{ isStarred: boolean, html: string, timeStr: string, timeSec: number|null }]
// 核心规则：全文自然分段，一个句号/问号/感叹号为一个段落卡片显示，支持时间戳
function parseTranscriptParagraphs(raw) {
  if (!raw) return [];
  raw = String(raw).trim();

  // 1. 如果包含 <p 或 transcript-para 或 <mark 标签，说明是已保存的 HTML
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

        let timeSec = p.dataset.time !== undefined && p.dataset.time !== "" ? parseFloat(p.dataset.time) : null;
        let timeStr = p.dataset.timestr || "";
        const timeBtn = p.querySelector(".para-time-badge");
        if (timeBtn) {
          if (!timeStr) timeStr = timeBtn.textContent.replace(/[⏱️\s]/g, "");
          if (timeSec === null && timeBtn.dataset.time) timeSec = parseFloat(timeBtn.dataset.time);
          timeBtn.remove();
        }

        // 识别可能内嵌在 html 开头的时间戳如 [00:15] 或 ⏱️ 00:15
        const m = html.match(/^(?:\[|⏱️\s*)(\d{1,2}:\d{2}(?::\d{2})?)(?:\]|\s+)/);
        if (m) {
          if (!timeStr) {
            timeStr = m[1];
            timeSec = parseTimestampToSeconds(m[1]);
          }
          html = html.slice(m[0].length).trim();
        }

        if (html) {
          // 已保存的段落直接完整保留，避免重复拆词导致标点和引号错位
          results.push({ isStarred, html, timeStr, timeSec });
        }
      });
      if (results.length > 0) return results;
    }
  }

  // 2. 纯文本处理：支持 [MM:SS] 时间戳、¶ 编号与自然分段
  const lines = raw.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
  const results = [];

  for (const line of lines) {
    let cleanLine = line;
    let timeStr = "";
    let timeSec = null;

    const timeMatch = cleanLine.match(/^(?:\[|⏱️\s*)(\d{1,2}:\d{2}(?::\d{2})?)(?:\]|\s+)/);
    if (timeMatch) {
      timeStr = timeMatch[1];
      timeSec = parseTimestampToSeconds(timeStr);
      cleanLine = cleanLine.slice(timeMatch[0].length).trim();
    }

    cleanLine = cleanLine.replace(/^¶\s*\d+[:：\s]*/, "").trim();
    if (!cleanLine) continue;

    // 若原输入已分好行或带时间戳，直接作为单条字幕完整保留，绝不胡乱拆碎标点和丢失引号
    if (lines.length > 1 || timeStr) {
      results.push({
        isStarred: false,
        timeStr,
        timeSec,
        html: escapeHtml(cleanLine)
      });
    } else {
      const sentences = formatBySentences(cleanLine);
      for (const sent of sentences) {
        results.push({
          isStarred: false,
          timeStr,
          timeSec,
          html: escapeHtml(sent)
        });
      }
    }
  }

  if (results.length > 0) return results;

  // 保底纯文本
  const sentences = formatBySentences(raw);
  return sentences.map((sent) => ({
    isStarred: false,
    timeStr: "",
    timeSec: null,
    html: escapeHtml(sent)
  }));
}

// 序列化段落列表为可持久化的 HTML 字符串
function serializeTranscriptParagraphs(container) {
  if (!container) return "";
  const paras = container.querySelectorAll(".transcript-para");
  const parts = [];
  paras.forEach((p) => {
    const isStarred = p.classList.contains("para-starred");
    const contentEl = p.querySelector(".para-content");
    const timeBtn = p.querySelector(".para-time-badge");
    const timeSec = timeBtn?.dataset?.time ?? p.dataset?.time ?? "";
    const timeStr = timeBtn?.textContent?.replace(/[⏱️\s]/g, "") ?? p.dataset?.timestr ?? "";
    const html = contentEl ? contentEl.innerHTML.trim() : "";
    if (html) {
      const starAttr = isStarred ? ' class="para-starred"' : '';
      const timeAttr = (timeSec !== "" && timeStr) ? ` data-time="${timeSec}" data-timestr="${timeStr}"` : '';
      parts.push(`<p${starAttr}${timeAttr}>${html}</p>`);
    }
  });
  return parts.join("\n");
}

// 获取文案纯文本（格式化为带时间戳和段落号的结构化纯文本）
function getTranscriptPlainText(container) {
  if (!container) return "";
  const paras = container.querySelectorAll(".transcript-para");
  const lines = [];
  paras.forEach((p, idx) => {
    const num = (idx + 1).toString().padStart(2, "0");
    const contentEl = p.querySelector(".para-content");
    const timeBtn = p.querySelector(".para-time-badge");
    const timeStr = timeBtn ? timeBtn.textContent.replace(/[⏱️\s]/g, "") : (p.dataset?.timestr || "");
    if (contentEl) {
      const text = (contentEl.innerText || contentEl.textContent || "").trim();
      if (text) {
        if (timeStr) {
          lines.push(`[${timeStr}] ¶ ${num}：${text}`);
        } else {
          lines.push(`¶ ${num}：${text}`);
        }
      }
    }
  });
  return lines.join("\n");
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
    const timeBtn = p.querySelector(".para-time-badge");
    const timeStr = timeBtn ? timeBtn.textContent.replace(/[⏱️\s]/g, "") : (p.dataset?.timestr || "");
    const timePrefix = timeStr ? `[${timeStr}] ` : "";
    if (!contentEl) return;

    const marks = contentEl.querySelectorAll("mark.transcript-hl");
    const markTexts = Array.from(marks).map(m => m.textContent.trim()).filter(Boolean);

    if (isStarred) {
      starCount++;
      const paraText = (contentEl.innerText || contentEl.textContent || "").trim();
      summaryLines.push(`⭐ 【重点段落 ${idx + 1}】${timePrefix}\n${paraText}`);
    } else if (markTexts.length > 0) {
      markCount += markTexts.length;
      summaryLines.push(`✨ 【段落 ${idx + 1} 核心划词】${timePrefix}: ${markTexts.map(t => `「${t}」`).join("、")}`);
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
function renderTranscriptBox(container, rawText, noteId, detectedProvider) {
  if (!container) return;
  container.style.display = "block";
  if (noteId) {
    container.dataset.noteId = String(noteId);
  }
  if (detectedProvider) {
    container.dataset.aiProvider = detectedProvider;
  }

  const isVision = String(detectedProvider || container.dataset.aiProvider || "").includes("vision");
  const effectiveProvider = container.dataset.aiProvider || state.whisperProvider || (document.getElementById("settings-whisper-key")?.value ? "groq" : "cloudflare");
  const engineBadgeHtml = isVision
    ? `<span class="badge-engine" style="background: rgba(139, 92, 246, 0.15); color: #7c3aed; border-color: rgba(139, 92, 246, 0.3);" title="由 AI 视觉模型直接从视频画面底部的硬字幕识别提取">👁️ 画面硬字幕</span>`
    : (effectiveProvider === "groq"
      ? `<span class="badge-engine badge-groq" title="由 Groq LPU 极速芯片 Whisper Large-v3 驱动">⚡ Groq Large-v3</span>`
      : (effectiveProvider === "soft-subtitles"
        ? `<span class="badge-engine" style="background: rgba(16, 185, 129, 0.15); color: #059669; border-color: rgba(16, 185, 129, 0.3);" title="由视频原生外挂软字幕直接提取">🎬 原生字幕轨</span>`
        : `<span class="badge-engine badge-cf" title="由 Cloudflare Workers AI 驱动">☁️ Cloudflare AI</span>`));

  const paragraphs = parseTranscriptParagraphs(rawText);
  if (paragraphs.length === 0) {
    container.innerHTML = `<div class="transcript-filter-empty">暂无有效文案</div>`;
    return;
  }

  const paragraphsHtml = paragraphs.map((p, idx) => {
    const num = (idx + 1).toString().padStart(2, "0");
    const starClass = p.isStarred ? "active" : "";
    const paraClass = p.isStarred ? "transcript-para para-starred" : "transcript-para";
    const timeBadgeHtml = p.timeStr ? `
      <button type="button" class="para-time-badge" data-time="${p.timeSec ?? 0}" title="点击跳转至 ${p.timeStr} 播放视频">
        ⏱️ ${p.timeStr}
      </button>
    ` : "";

    return `
      <div class="${paraClass}" data-idx="${idx}" data-time="${p.timeSec ?? ''}" data-timestr="${p.timeStr || ''}">
        <div class="para-sidebar">
          ${timeBadgeHtml}
          <div class="para-sidebar-sub">
            <span class="para-num">#${num}</span>
            <button type="button" class="btn-para-star ${starClass}" title="${p.isStarred ? '取消重点段落' : '标记为重点段落'}">
              <svg class="star-icon" viewBox="0 0 24 24">
                <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="para-content">${p.html}</div>
      </div>
    `;
  }).join("");

  container.innerHTML = `
    <div class="transcript-header">
      <div class="transcript-header-left">
        <span class="transcript-title">${isVision ? "👁️ 视频画面字幕提取" : "🎙️ 视频语音提取文案"}</span>
        ${engineBadgeHtml}
        <span class="transcript-hl-badge" style="display: none;">⭐ 0 处重点</span>
      </div>
      <div class="transcript-header-actions">
        <button type="button" class="transcript-btn btn-ai-punctuate" title="通过 AI 深度纠正同音错别字、恢复标点并精准按句分段">
          🪄 AI 智能纠错
        </button>
        <button type="button" class="transcript-btn btn-toggle-filter" title="只显示标记了重点的段落和文字">
          <span class="btn-star-mark">⭐</span> 仅看重点
        </button>
        <button type="button" class="transcript-btn btn-toggle-autoscroll active" title="播放视频/音频时，文案像滚动字幕/歌词一样跟随滚动">
          🔄 滚动跟随
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

  // 2. 点击时间戳跳转播放 & 点击高亮标签弹出浮动气泡
  if (wrap) {
    wrap.addEventListener("click", (e) => {
      const timeBtn = e.target.closest(".para-time-badge");
      if (timeBtn) {
        e.stopPropagation();
        const sec = parseFloat(timeBtn.dataset.time || "0");
        seekAllMediaTo(sec);
        return;
      }
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
      toggleFilterBtn.innerHTML = isFilterActive
        ? `<span class="btn-star-mark">⭐</span> 查看全部段落`
        : `<span class="btn-star-mark">⭐</span> 仅看重点`;
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

  // 6. 「🪄 AI 智能纠错」
  const punctuateBtn = container.querySelector(".btn-ai-punctuate");
  if (punctuateBtn) {
    punctuateBtn.addEventListener("click", async () => {
      punctuateBtn.disabled = true;
      const originalText = punctuateBtn.innerHTML;
      punctuateBtn.innerHTML = `⏳ AI 纠错中...`;

      try {
        const paras = parseTranscriptParagraphs(container.innerHTML);
        if (paras.length === 0) return;

        // 构建带时间戳前缀的单行文本传递给大模型纠错 (如: [00:10] 文本)
        const rawLines = paras.map(p => {
          const tPrefix = p.timeStr ? `[${p.timeStr}] ` : '';
          const plain = p.html.replace(/<[^>]+>/g, '').trim();
          return `${tPrefix}${plain}`;
        }).filter(Boolean);
        const textToFix = rawLines.join('\n');

        let fixedText = '';
        try {
          const res = await fetch('/api/punctuate', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-auth-pin': state.pin
            },
            body: JSON.stringify({
              text: textToFix,
              noteId: noteId || (state.activeDetailNote?.id)
            })
          });
          if (res.ok) {
            const data = await res.json();
            if (data.success && data.text) {
              fixedText = data.text;
            }
          }
        } catch (netErr) {
          console.warn('API punctuate network error, fallback to local punctuation:', netErr);
        }

        if (fixedText) {
          renderTranscriptBox(container, fixedText, noteId, detectedProvider);
          triggerTranscriptAutoSave(container, noteId);
          showToast('🪄 AI 智能纠错已完成：已精准修复同音错别字并按句分段！');
        } else {
          // 本地智能分段回退
          const formattedParas = [];
          for (const p of paras) {
            const rawSentText = p.html.replace(/<[^>]+>/g, '').trim();
            if (!rawSentText) continue;
            const subSents = formatBySentences(rawSentText);
            for (const s of subSents) {
              formattedParas.push({
                isStarred: p.isStarred,
                timeStr: p.timeStr || '',
                timeSec: p.timeSec ?? null,
                html: escapeHtml(s)
              });
            }
          }

          const serialized = formattedParas.map(p => {
            const timeAttr = (p.timeSec !== null && p.timeStr) ? ` data-time="${p.timeSec}" data-timestr="${p.timeStr}"` : '';
            const starAttr = p.isStarred ? ' class="para-starred"' : '';
            return `<p${starAttr}${timeAttr}>${p.html}</p>`;
          }).join('\n');

          renderTranscriptBox(container, serialized, noteId, detectedProvider);
          triggerTranscriptAutoSave(container, noteId);
          showToast('🎉 已完成智能标点断句，并保留每段时间戳！');
        }
      } catch (err) {
        showToast(`标点纠错失败: ${err.message}`);
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

  // 绑定滚动字幕跟随控制器
  setupTranscriptPlaybackSync(container);
}

// 全局播放字幕跟随控制器 (滚动字幕模式)
let _userScrollTimeout = null;
let _isUserScrolling = false;
let _isAutoScrollEnabled = true;

function setupTranscriptPlaybackSync(container) {
  if (!container) return;
  const wrap = container.querySelector(".transcript-paragraphs-wrap");
  if (!wrap) return;

  // 用户手动滚动时暂停自动居中 3.5 秒，避免打乱用户自由阅读
  wrap.addEventListener("wheel", () => {
    _isUserScrolling = true;
    clearTimeout(_userScrollTimeout);
    _userScrollTimeout = setTimeout(() => { _isUserScrolling = false; }, 3500);
  }, { passive: true });

  wrap.addEventListener("touchmove", () => {
    _isUserScrolling = true;
    clearTimeout(_userScrollTimeout);
    _userScrollTimeout = setTimeout(() => { _isUserScrolling = false; }, 3500);
  }, { passive: true });

  const autoScrollBtn = container.querySelector(".btn-toggle-autoscroll");
  if (autoScrollBtn) {
    autoScrollBtn.addEventListener("click", () => {
      _isAutoScrollEnabled = !_isAutoScrollEnabled;
      autoScrollBtn.classList.toggle("active", _isAutoScrollEnabled);
      autoScrollBtn.innerHTML = _isAutoScrollEnabled
        ? `🔄 滚动跟随`
        : `⏸️ 暂停跟随`;
      showToast(_isAutoScrollEnabled ? "🔄 已开启播放文案滚动跟随" : "⏸️ 已暂停播放文案自动跟随");
    });
  }

  attachMediaSyncListeners();
}

// 视频/音频播放时间更新时，同步高亮并滚动到对应文案卡片
function syncTranscriptWithCurrentTime(currentTime) {
  if (typeof currentTime !== "number" || isNaN(currentTime) || currentTime < 0) return;

  const containers = [
    document.getElementById("modal-transcript-panel"),
    document.getElementById("transcript-panel")
  ].filter(c => c && c.style.display !== "none" && c.offsetHeight > 0);

  for (const container of containers) {
    const wrap = container.querySelector(".transcript-paragraphs-wrap");
    if (!wrap) continue;

    const paras = Array.from(wrap.querySelectorAll(".transcript-para"));
    if (paras.length === 0) continue;

    let activePara = null;
    for (let i = 0; i < paras.length; i++) {
      const pTime = parseFloat(paras[i].dataset.time || "0");
      if (pTime <= currentTime) {
        activePara = paras[i];
      } else {
        break;
      }
    }

    if (!activePara && paras.length > 0) {
      activePara = paras[0];
    }

    const prevPlaying = wrap.querySelector(".transcript-para.para-playing");
    if (prevPlaying !== activePara) {
      if (prevPlaying) prevPlaying.classList.remove("para-playing");
      if (activePara) {
        activePara.classList.add("para-playing");

        // 像歌词一样平滑滚动居中 (如果不处于用户手动干预状态且启用了自动跟随)
        if (_isAutoScrollEnabled && !_isUserScrolling) {
          activePara.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  }
}

// 挂载媒体元素的时间更新监听
function attachMediaSyncListeners() {
  const mediaIds = [
    "modal-video-player",
    "modal-audio-player",
    "video-player",
    "audio-player",
    "shuffle-audio-element"
  ];
  mediaIds.forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.dataset.hasTranscriptSync) {
      el.dataset.hasTranscriptSync = "true";
      el.addEventListener("timeupdate", () => {
        syncTranscriptWithCurrentTime(el.currentTime);
      });
      el.addEventListener("seeked", () => {
        syncTranscriptWithCurrentTime(el.currentTime);
      });
      el.addEventListener("play", () => {
        syncTranscriptWithCurrentTime(el.currentTime);
      });
    }
  });
}

// 发送单个音频切片至后端 Whisper 接口，安全兼容 JSON 与异常响应
async function sendAudioChunkForTranscription(blob, options = {}) {
  const headers = {
    "x-auth-pin": state.pin,
    "Content-Type": "audio/wav"
  };
  if (options.prompt) {
    headers["x-whisper-prompt"] = encodeURIComponent(options.prompt.slice(-150));
  }
  if (options.temperature !== undefined) {
    headers["x-whisper-temperature"] = String(options.temperature);
  }
  if (options.model) {
    headers["x-whisper-model"] = options.model;
  }

  const res = await fetch("/api/transcribe", {
    method: "POST",
    headers,
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
      throw new Error("AI 请求超时 (524)，请稍后重试");
    } else if (res.status === 413) {
      throw new Error("音频切片超出体积限制 (413)");
    } else {
      throw new Error(`服务响应异常 (HTTP ${res.status}): ${textResp.slice(0, 100)}`);
    }
  }

  if (!res.ok || !data.success) {
    const errMsg = data?.message || `识别失败 (HTTP ${res.status})`;
    const err = new Error(errMsg);
    err.status = res.status;
    err.isRateLimit = res.status === 429 || errMsg.includes("429") || errMsg.includes("Rate limit");
    throw err;
  }

  return {
    text: (data.text || "").trim(),
    segments: Array.isArray(data.segments) ? data.segments : [],
    provider: data.provider || "cloudflare",
    model: data.model || ""
  };
}

function cleanWhisperHallucinationsClient(text) {
  if (!text) return "";
  let cleaned = String(text).trim();
  const hallucinationPatterns = [
    /请务必使用简体中文.*?标点符号[。！!？?]?/g,
    /这是一段中文普通话演讲.*?标点符号[。！!？?]?/g,
    /这是一段中文普通话演讲与知识分享口语录音[。！!？?]?/g,
    /请准确听写文字.*?标点符号[。！!？?]?/g,
    /请准确听写文字[。！!？?]?/g,
    /使用简体中文及规范标点符号[。！!？?]?/g,
    /普通话[，, ]*口语[，, ]*对话[，, ]*简体中文[。！!？?]?/g,
    /普通话视频对话录音.*?口述内容[。！!？?]?/g,
    /请不吝点赞.*?栏目[。！!？?]?/g,
    /请不吝点赞.*?支持[。！!？?]?/g,
    /欢迎订阅.*?频道[。！!？?]?/g,
    /感谢大家的?收看[。！!？?]?/g,
    /感谢收看[。！!？?]?/g,
    /感谢观看[。！!？?]?/g,
    /不吝点赞.*?打赏[。！!？?]?/g,
    /点赞、?投币、?收藏[。！!？?]?/g,
    /字幕由.*?社区提供[。！!？?]?/g,
    /字幕制作.*$/g,
    /Thank you for watching\.?/gi,
    /Please subscribe\.?/gi
  ];
  for (const pattern of hallucinationPatterns) {
    cleaned = cleaned.replace(pattern, " ");
  }
  // 消除连续重复短语 (短语长度 2~40，如果复读超过 4 次则彻底丢弃幻觉，否则保留 1 次)
  cleaned = cleaned.replace(/(.{2,40}?)\1{2,}/g, (match, g1) => {
    if (match.length >= g1.length * 4) return "";
    return g1;
  });
  return cleaned.trim();
}

// 音频提取与 AI Whisper 语音识别 (支持多段切片流水线、实时流式文案呈现与双模对比)
async function transcribeAudio(
  mediaUrl,
  containerSelector,
  noteId,
  {
    autoSave = true,
    renderBox = true,
    onProgress = null,
    onStatus = null,
    onPartialResult = null
  } = {}
) {
  const extractionStartTime = Date.now();
  const container = containerSelector ? document.querySelector(containerSelector) : null;
  if (renderBox && !container) return;

  if (renderBox && container) {
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
  }

  const statusText = renderBox && container ? container.querySelector("#transcribe-status-text") : null;
  const progressTrack = renderBox && container ? container.querySelector("#transcribe-progress-track") : null;
  const progressBar = renderBox && container ? container.querySelector("#transcribe-progress-bar") : null;
  const livePreview = renderBox && container ? container.querySelector("#transcribe-live-preview") : null;

  const updateStatus = (msg) => {
    if (statusText) statusText.textContent = msg;
    if (typeof onStatus === "function") {
      try { onStatus(msg); } catch {}
    }
  };

  const updateProgress = (pct, current, total, msg) => {
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (typeof onProgress === "function") {
      try { onProgress({ percent: pct, current, total, msg }); } catch {}
    }
  };

  const updatePartial = (items) => {
    if (livePreview && items.length > 0) {
      livePreview.style.display = "block";
      livePreview.textContent = items.map(it => `[${it.timeStr}] ${it.text}`).join("\n\n");
      livePreview.scrollTop = livePreview.scrollHeight;
    }
    if (typeof onPartialResult === "function") {
      try { onPartialResult(items); } catch {}
    }
  };

  try {
    const isGroq = state.whisperProvider === "groq" || Boolean(document.getElementById("settings-whisper-key")?.value);
    // 切片时长优化为 20 秒：严格契合 Whisper 30s 声学窗口，大幅减少因背景杂音/转场特效触发的早停遗漏
    const chunkDuration = 20;

    const { duration, chunks, sliceAudioBlob } = await extractAudioChunksFromMedia(mediaUrl, (msg) => {
      updateStatus(msg);
    }, chunkDuration);

    const totalChunks = chunks.length;
    if (progressTrack) progressTrack.style.display = "block";

    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);
    const durationStr = `${minutes > 0 ? `${minutes}分` : ''}${seconds}秒`;

    if (statusText) {
      statusText.textContent = totalChunks > 1
        ? `音频共 ${durationStr}，已智能切分为 ${totalChunks} 个分段并发起 AI 深度识别...`
        : `音频共 ${durationStr}，正在通过 AI 进行精准转写...`;
    }

    const collectedItems = [];
    let detectedProvider = state.whisperProvider || "cloudflare";
    let lastChunkSentence = "";

    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunks[i];
      const chunkIndex = i + 1;
      const percent = Math.round(((i) / totalChunks) * 100);

      // 绝不跳过任何分段（包含低音量片段），确保 100% 完整录音全部进入转写
      if (progressBar) progressBar.style.width = `${percent}%`;
      if (statusText) {
        statusText.textContent = totalChunks > 1
          ? `正在识别分段 [${chunkIndex}/${totalChunks}] (${percent}%)...`
          : "正在通过 AI (Whisper) 深度识别文本，请稍候...";
      }

      // 上下文顺延：将上一段末尾语句作为本次转写 Prompt，维持上下文语义连贯，防止 Whisper 换段早停或幻觉
      const carryPrompt = lastChunkSentence ? lastChunkSentence.slice(-60) : "";

      // 携带多轮指数退避重试机制 (最多 4 次，绝不静默丢失任何切片)
      let chunkResult = null;
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          chunkResult = await sendAudioChunkForTranscription(chunk.blob, {
            prompt: carryPrompt,
            temperature: 0.2
          });
          if (chunkResult?.provider) {
            detectedProvider = chunkResult.provider;
          }
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          const isRateLimit = e.isRateLimit || String(e.message).includes("429") || String(e.message).includes("Rate limit");
          const waitMs = isRateLimit ? (3000 * (attempt + 1)) : (1500 * (attempt + 1));
          console.warn(`Chunk ${chunkIndex} attempt ${attempt + 1} error: ${e.message}, retrying in ${waitMs}ms...`);
          if (statusText) {
            statusText.textContent = `分段 [${chunkIndex}/${totalChunks}] 遇到${isRateLimit ? '频率限制' : '网络波动'}，正在等待重试 (第 ${attempt + 1}/4 次)...`;
          }
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }

      // 请求之间保留轻量缓冲延迟 (350ms)，避免突发并发打满 API 频率
      await new Promise((r) => setTimeout(r, 350));

      if (lastErr && !chunkResult?.text) {
        console.warn(`Chunk ${chunkIndex} all attempts failed:`, lastErr);
      }

      if (chunkResult) {
        let maxSegEnd = 0;
        const chunkSpan = chunk.duration || (chunk.endTime - chunk.startTime);

        if (Array.isArray(chunkResult.segments) && chunkResult.segments.length > 0) {
          for (const seg of chunkResult.segments) {
            let segText = (seg.text || "").trim();
            segText = cleanWhisperHallucinationsClient(segText);
            if (!segText) continue;

            const segStart = typeof seg.start === "number" ? seg.start : 0;
            const segEnd = typeof seg.end === "number" ? seg.end : segStart + 2;
            if (segEnd > maxSegEnd) maxSegEnd = segEnd;
            const segDuration = Math.max(1, segEnd - segStart);

            // 拆分为单句并进行时间戳内插，避免多个独立句子共享完全相同的时间戳
            const subSents = formatBySentences(segText);
            subSents.forEach((sent, sIdx) => {
              const absStart = Math.max(0, Math.floor(chunk.startTime + segStart + (sIdx / Math.max(1, subSents.length)) * segDuration));
              if (collectedItems.length === 0 || collectedItems[collectedItems.length - 1].text !== sent) {
                collectedItems.push({
                  timeSec: absStart,
                  timeStr: formatTimestamp(absStart),
                  text: sent
                });
              }
            });
          }
        } else {
          // 兼容无 segments 返回的服务商
          let text = (chunkResult.text || "").trim();
          text = cleanWhisperHallucinationsClient(text);
          if (text) {
            const sentences = formatBySentences(text);
            sentences.forEach((sent, sIdx) => {
              const absStart = Math.max(0, Math.floor(chunk.startTime + (sIdx / Math.max(1, sentences.length)) * chunkSpan));
              if (collectedItems.length === 0 || collectedItems[collectedItems.length - 1].text !== sent) {
                collectedItems.push({
                  timeSec: absStart,
                  timeStr: formatTimestamp(absStart),
                  text: sent
                });
              }
            });
          }
        }

        // 核心：早停自愈补录机制 (Early Cutoff Rescue)
        // 若切片时长 >= 8 秒，但识别末尾距离切片终点大于 4 秒，说明 Whisper 因背景乐/音效提前中止。
        // 自动截取后半段音频并以微调温度发起补录，彻底杜绝遗漏！
        const chunkRemainingSec = chunkSpan - maxSegEnd;
        if (maxSegEnd > 0 && chunkRemainingSec >= 4.0 && sliceAudioBlob) {
          const rescueStartSec = chunk.startTime + maxSegEnd;
          const rescueEndSec = chunk.endTime;
          console.warn(`[早停检测] 分段 ${chunkIndex} 在 ${maxSegEnd.toFixed(1)}s 提前中断，后半段剩余 ${chunkRemainingSec.toFixed(1)}s，正在自动补录...`);
          if (statusText) {
            statusText.textContent = `检测到分段 [${chunkIndex}/${totalChunks}] 遇到音效干扰提前中止，正在自动补录后半段音频...`;
          }

          try {
            const rescueBlob = sliceAudioBlob(rescueStartSec, rescueEndSec);
            const rescuePrompt = collectedItems[collectedItems.length - 1]?.text || carryPrompt;
            const rescueResult = await sendAudioChunkForTranscription(rescueBlob, {
              prompt: rescuePrompt,
              temperature: 0.3
            });

            if (rescueResult) {
              const rescueSegments = Array.isArray(rescueResult.segments) ? rescueResult.segments : [];
              if (rescueSegments.length > 0) {
                for (const rSeg of rescueSegments) {
                  let rText = cleanWhisperHallucinationsClient((rSeg.text || "").trim());
                  if (!rText) continue;
                  const rStart = typeof rSeg.start === "number" ? rSeg.start : 0;
                  const rEnd = typeof rSeg.end === "number" ? rSeg.end : rStart + 2;
                  const rDur = Math.max(1, rEnd - rStart);
                  const subSents = formatBySentences(rText);
                  subSents.forEach((sent, sIdx) => {
                    const absStart = Math.max(0, Math.floor(rescueStartSec + rStart + (sIdx / Math.max(1, subSents.length)) * rDur));
                    if (collectedItems.length === 0 || collectedItems[collectedItems.length - 1].text !== sent) {
                      collectedItems.push({
                        timeSec: absStart,
                        timeStr: formatTimestamp(absStart),
                        text: sent
                      });
                    }
                  });
                }
              } else if (rescueResult.text) {
                let rText = cleanWhisperHallucinationsClient((rescueResult.text || "").trim());
                if (rText) {
                  const subSents = formatBySentences(rText);
                  const rSpan = Math.max(1, rescueEndSec - rescueStartSec);
                  subSents.forEach((sent, sIdx) => {
                    const absStart = Math.max(0, Math.floor(rescueStartSec + (sIdx / Math.max(1, subSents.length)) * rSpan));
                    if (collectedItems.length === 0 || collectedItems[collectedItems.length - 1].text !== sent) {
                      collectedItems.push({
                        timeSec: absStart,
                        timeStr: formatTimestamp(absStart),
                        text: sent
                      });
                    }
                  });
                }
              }
            }
          } catch (rescueErr) {
            console.warn(`分段 ${chunkIndex} 早停补录异常:`, rescueErr);
          }
        }

        if (collectedItems.length > 0) {
          lastChunkSentence = collectedItems[collectedItems.length - 1].text;
        }

        // 实时流式呈现在预览区
        updatePartial(collectedItems);
      }
    }

    updateProgress(100, totalChunks, totalChunks, "语音识别完成");

    const fullTranscript = collectedItems.map(it => `[${it.timeStr}] ${it.text}`).join("\n\n").trim();
    if (!fullTranscript || collectedItems.length === 0) {
      throw new Error("未能识别出有效语音或音频中无清晰人声");
    }

    updateStatus("✨ 语音提取完成，正在组织带时间戳的段落排版...");

    // 每一个独立完整单句为一个自然段卡片
    const finalLines = collectedItems.map(item => `[${item.timeStr}] ${item.text}`);
    const finalTranscript = finalLines.join("\n");
    const targetNoteId = noteId || (state.activeDetailNote?.id);

    // 渲染最终文案结果面板
    if (renderBox && container) {
      renderTranscriptBox(container, finalTranscript, noteId, detectedProvider);
      if (detectedProvider === "groq") {
        showToast(`⚡ 视频文案已由 Groq Whisper Large-v3 提取并生成精准时间戳 (共 ${finalLines.length} 个段落)！`);
      } else {
        showToast(`🎉 视频语音文案已提取完成 (共 ${finalLines.length} 个段落)！`);
      }
    }

    if (autoSave && targetNoteId) {
      try {
        const savedTranscript = (renderBox && container) ? (serializeTranscriptParagraphs(container) || fullTranscript) : fullTranscript;
        const durationMs = Date.now() - extractionStartTime;
        await fetch(`/api/notes/${targetNoteId}/transcript`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({
            transcript: savedTranscript,
            durationMs,
            method: detectedProvider === "groq" ? "speech_groq" : "speech_whisper",
            extractedAt: Date.now()
          })
        });
        if (state.activeDetailNote && state.activeDetailNote.id === targetNoteId) {
          state.activeDetailNote.transcript = savedTranscript;
        }
      } catch (err) {
        console.warn("保存 transcript 到数据库失败:", err);
      }
    }

    return {
      success: true,
      transcript: finalTranscript,
      items: collectedItems,
      provider: detectedProvider
    };
  } catch (err) {
    console.error("Transcribe error:", err);
    if (renderBox && container) {
      container.innerHTML = `
        <div style="color: var(--primary); font-size: 13px; padding: 12px; background: rgba(234, 44, 67, 0.05); border-radius: 8px;">
          ❌ 语音转写失败: ${escapeHtml(err.message)}
        </div>
      `;
      showToast(`❌ 语音转写失败: ${err.message}`, { isError: true });
    }
    if (!renderBox) {
      throw err;
    }
    return {
      success: false,
      error: err.message
    };
  }
}

// 视频原生外挂软字幕轨探测 (TextTracks / cues)
function detectVideoSoftSubtitles(videoEl) {
  if (!videoEl) return null;
  const tracks = videoEl.textTracks;
  if (!tracks || tracks.length === 0) return null;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    try {
      if (track.mode === "disabled") track.mode = "hidden";
    } catch {}
    if (track.cues && track.cues.length > 0) {
      const items = [];
      for (let j = 0; j < track.cues.length; j++) {
        const cue = track.cues[j];
        const text = (cue.text || "").replace(/<[^>]+>/g, "").trim();
        if (text) {
          const timeSec = Math.floor(cue.startTime || 0);
          items.push({
            timeSec,
            timeStr: formatTimestamp(timeSec),
            text
          });
        }
      }
      if (items.length > 0) return items;
    }
  }
  return null;
}

// 视频画面底部硬字幕视觉提取 (Vision OCR，支持极速/慢速精细两种模式，支持后台静默执行与双模对比)
async function extractVideoHardSubtitles(
  mediaUrl,
  containerSelector,
  noteId,
  {
    fallbackToSpeech = false,
    isSlowMode = false,
    stepSec = null,
    batchDelayMs = null,
    autoSave = true,
    renderBox = true,
    onProgress = null,
    onStatus = null,
    onPartialResult = null
  } = {}
) {
  const extractionStartTime = Date.now();
  const container = containerSelector ? document.querySelector(containerSelector) : null;
  if (renderBox && containerSelector && !container) return false;

  if (renderBox && container) {
    container.style.display = "block";
    container.innerHTML = `
      <div class="transcript-loading">
        <div class="spinner"></div>
        <div style="flex: 1; min-width: 0;">
          <div id="ocr-status-text" style="font-weight: 500; font-size: 13px; color: #334155; margin-bottom: 6px;">
            ${isSlowMode ? '🐢 正在以慢速精细模式分析视频画面字幕 (密集抽样 · 杜绝遗漏)...' : '🔍 正在准备视频画面字幕区域识别 (AI 视觉模型)...'}
          </div>
          <div id="ocr-progress-track" class="transcribe-progress-track" style="display: none;">
            <div id="ocr-progress-bar" class="transcribe-progress-bar" style="width: 0%;"></div>
          </div>
        </div>
      </div>
      <div id="ocr-live-preview" class="transcribe-live-preview" style="display: none;"></div>
    `;
  }

  const statusText = renderBox && container ? container.querySelector("#ocr-status-text") : null;
  const progressTrack = renderBox && container ? container.querySelector("#ocr-progress-track") : null;
  const progressBar = renderBox && container ? container.querySelector("#ocr-progress-bar") : null;
  const livePreview = renderBox && container ? container.querySelector("#ocr-live-preview") : null;

  let tempVideo = null;
  let createdBlobUrl = null;

  const updateStatus = (msg) => {
    if (statusText) statusText.textContent = msg;
    if (typeof onStatus === "function") {
      try { onStatus(msg); } catch {}
    }
  };

  const notifyProgress = (pct, currentBatch, totalBatches, msg) => {
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (typeof onProgress === "function") {
      try {
        onProgress({ percent: pct, currentBatch, totalBatches, msg });
      } catch {}
    }
  };

  const updatePartial = (subs) => {
    if (livePreview && subs.length > 0) {
      livePreview.style.display = "block";
      livePreview.textContent = subs.map(s => `[${s.timeStr}] ${s.text}`).join("\n");
      livePreview.scrollTop = livePreview.scrollHeight;
    }
    if (typeof onPartialResult === "function") {
      try { onPartialResult(subs); } catch {}
    }
  };

  try {
    updateStatus(isSlowMode ? "🐢 正在获取视频画面资源 (准备慢速精细扫描)..." : "正在获取视频画面资源...");
    notifyProgress(0, 0, 0, "正在获取视频画面资源...");

    let safeVideoUrl = mediaUrl;
    try {
      const cached = await OfflineMediaManager.getPlayableSource(mediaUrl);
      if (cached?.src) safeVideoUrl = cached.src;
    } catch {}

    if (!safeVideoUrl.startsWith("blob:") && !safeVideoUrl.startsWith("data:")) {
      try {
        const res = await fetch(safeVideoUrl);
        if (res.ok) {
          const blob = await res.blob();
          createdBlobUrl = URL.createObjectURL(blob);
          safeVideoUrl = createdBlobUrl;
        }
      } catch (e) {
        console.warn("Direct blob fetch for OCR video failed:", e);
      }
    }

    tempVideo = document.createElement("video");
    tempVideo.muted = true;
    tempVideo.playsInline = true;
    tempVideo.crossOrigin = "anonymous";
    tempVideo.src = safeVideoUrl;

    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        tempVideo.removeEventListener("loadedmetadata", onLoaded);
        resolve();
      };
      tempVideo.addEventListener("loadedmetadata", onLoaded);
      tempVideo.addEventListener("error", () => reject(new Error("视频画面加载失败")));
      setTimeout(onLoaded, 6000);
    });

    const duration = tempVideo.duration;
    if (!duration || isNaN(duration) || duration <= 0) {
      throw new Error("无法读取视频长度");
    }

    if (progressTrack) progressTrack.style.display = "block";

    // 抽帧策略与延时步长：慢速模式下步长 1.6 秒（密集无遗漏同时防止打满 API Token），普通模式 2.5 秒
    const effectiveStepSec = stepSec || (isSlowMode ? 1.6 : 2.5);
    const effectiveBatchDelay = batchDelayMs !== null && batchDelayMs !== undefined ? batchDelayMs : (isSlowMode ? 2200 : 500);

    const sampleTimes = [];
    for (let t = 0.5; t < duration; t += effectiveStepSec) {
      sampleTimes.push(Math.round(t * 10) / 10);
    }
    if (sampleTimes.length === 0) sampleTimes.push(0.5);

    const batchSize = 2;
    const totalBatches = Math.ceil(sampleTimes.length / batchSize);
    const collectedSubs = [];
    let providerUsed = isSlowMode ? "vision-ocr-slow" : "vision-ocr";

    const vw = tempVideo.videoWidth || 720;
    const vh = tempVideo.videoHeight || 1280;
    // 字幕热区：精准覆盖中下部 58% ~ 88% 高度范围（彻底避免人脸和多余背景，节省 80% Token 消耗）
    const cropX = Math.floor(vw * 0.05);
    const cropY = Math.floor(vh * 0.58);
    const cropW = Math.floor(vw * 0.90);
    const cropH = Math.floor(vh * 0.30);

    // 目标每个切条绘制规格：宽度 520，高度按比例
    const targetW = 520;
    const targetH = Math.round((cropH / cropW) * targetW);

    for (let b = 0; b < totalBatches; b++) {
      const batchTimes = sampleTimes.slice(b * batchSize, (b + 1) * batchSize);
      const percent = Math.round((b / totalBatches) * 100);
      if (progressBar) progressBar.style.width = `${percent}%`;
      const curStatusMsg = isSlowMode
        ? `🐢 慢速精细识别字幕中 (${percent}%，第 ${b + 1}/${totalBatches} 批)...`
        : `正在识别视频画面字幕 (${percent}%，第 ${b + 1}/${totalBatches} 批)...`;
      if (statusText) statusText.textContent = curStatusMsg;
      notifyProgress(percent, b + 1, totalBatches, curStatusMsg);

      // 创建合成 Canvas
      const compCanvas = document.createElement("canvas");
      compCanvas.width = targetW;
      compCanvas.height = targetH * batchTimes.length;
      const compCtx = compCanvas.getContext("2d");

      for (let sIdx = 0; sIdx < batchTimes.length; sIdx++) {
        const timeSec = batchTimes[sIdx];
        tempVideo.currentTime = timeSec;
        await new Promise(res => {
          let tId;
          const onSeeked = () => {
            clearTimeout(tId);
            tempVideo.removeEventListener("seeked", onSeeked);
            res();
          };
          tempVideo.addEventListener("seeked", onSeeked, { once: true });
          tId = setTimeout(() => {
            tempVideo.removeEventListener("seeked", onSeeked);
            res();
          }, 800);
        });

        const destY = sIdx * targetH;
        compCtx.drawImage(tempVideo, cropX, cropY, cropW, cropH, 0, destY, targetW, targetH);

        // 在左上角绘制明显的时间戳标签，供视觉大模型直接识别与锚定时间
        const tStr = formatTimestamp(Math.floor(timeSec));
        compCtx.fillStyle = "rgba(0, 0, 0, 0.85)";
        compCtx.fillRect(10, destY + 8, 120, 34);
        compCtx.fillStyle = "#ffffff";
        compCtx.font = "bold 20px sans-serif";
        compCtx.fillText(`[${tStr}]`, 18, destY + 32);
      }

      // 将合成图转为 DataURL 并发送至服务端 OCR 视觉模型 (支持指数退避重试，绝不静默丢弃任何批次)
      const base64Data = compCanvas.toDataURL("image/jpeg", 0.85);
      let ocrData = null;
      let lastErr = null;

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const ocrResp = await fetch("/api/ocr-subtitle", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-auth-pin": state.pin
            },
            body: JSON.stringify({ image: base64Data })
          });

          if (ocrResp.ok) {
            ocrData = await ocrResp.json();
            lastErr = null;
            break;
          } else {
            const errJson = await ocrResp.json().catch(() => ({}));
            const isRateLimit = ocrResp.status === 429 || String(errJson.message).includes("429") || String(errJson.message).includes("Rate limit");
            const waitMs = isRateLimit ? Math.min(22000, 4000 * Math.pow(1.5, attempt)) : (2500 * (attempt + 1));
            console.warn(`第 ${b + 1} 批 OCR 尝试 ${attempt + 1} (${ocrResp.status}):`, errJson.message, `等待 ${waitMs}ms 后重试...`);
            const retryMsg = `第 ${b + 1}/${totalBatches} 批${isRateLimit ? '遇到频率窗口限制' : '识别波动'}，正在等待重试 (第 ${attempt + 1}/5 次)...`;
            if (statusText) statusText.textContent = retryMsg;
            notifyProgress(percent, b + 1, totalBatches, retryMsg);
            lastErr = new Error(errJson.message || `HTTP ${ocrResp.status}`);
            await new Promise(r => setTimeout(r, waitMs));
          }
        } catch (netErr) {
          lastErr = netErr;
          console.warn(`第 ${b + 1} 批网络请求异常，重试中:`, netErr);
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // 批次之间缓冲等待（慢速模式延时 2.2 秒），平滑流量，防止突发打满 API TPM
      await new Promise(r => setTimeout(r, effectiveBatchDelay));

      if (ocrData && ocrData.success) {
        if (ocrData.provider) providerUsed = ocrData.provider;
        const ocrText = (ocrData.text || "").trim();

        if (ocrText && !ocrText.includes("NONE") && !ocrText.includes("无字幕")) {
          const lines = ocrText.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
          for (const line of lines) {
            // 解析出 [00:10] 字幕文本
            const m = line.match(/^(?:\[|⏱️\s*)(\d{1,2}:\d{2})(?:\]|\s+)(.*)$/);
            if (m) {
              const tStr = m[1];
              const tText = m[2].trim();
              if (/(?:女性在|她在|身穿|握手的|红色礼服|图[片中]是|一[位名]人)/.test(tText)) continue;
              if (tText && (!collectedSubs.length || collectedSubs[collectedSubs.length - 1].text !== tText)) {
                collectedSubs.push({
                  timeStr: tStr,
                  timeSec: parseTimestampToSeconds(tStr),
                  text: tText
                });
              }
            } else if (line.length > 1 && !line.includes("NONE")) {
              if (/(?:女性在|她在|身穿|握手的|红色礼服|图[片中]是|一[位名]人)/.test(line)) continue;
              const approxTime = Math.floor(batchTimes[0]);
              if (!collectedSubs.length || collectedSubs[collectedSubs.length - 1].text !== line) {
                collectedSubs.push({
                  timeStr: formatTimestamp(approxTime),
                  timeSec: approxTime,
                  text: line
                });
              }
            }
          }

          updatePartial(collectedSubs);
        }
      } else if (lastErr) {
        console.warn(`第 ${b + 1} 批多次重试后仍然未成功:`, lastErr.message);
        if (b === 0 && !fallbackToSpeech) {
          throw new Error(lastErr.message || "视觉大模型服务未响应");
        }
      }

      // 探针策略：如果在前 2 批 (约前 15 秒) 采样完毕后完全未识别出任何字幕，才平滑自动启用语音转写
      if (b === 1 && collectedSubs.length === 0 && fallbackToSpeech) {
        updateStatus("前 15 秒画面未检测到硬字幕，自动启用 AI 语音转写引擎...");
        await new Promise(r => setTimeout(r, 600));
        return false;
      }
    }

    if (progressBar) progressBar.style.width = "100%";
    notifyProgress(100, totalBatches, totalBatches, "字幕提取完成，正在整理保存...");

    if (collectedSubs.length === 0) {
      if (fallbackToSpeech) {
        return false;
      }
      throw new Error("视频画面未检测到清晰文字字幕");
    }

    const finalLines = collectedSubs.map(s => `[${s.timeStr}] ${s.text}`);
    const finalTranscript = finalLines.join("\n");
    const targetNoteId = noteId || (state.activeDetailNote?.id);

    if (renderBox && container) {
      renderTranscriptBox(container, finalTranscript, targetNoteId, providerUsed);
      showToast(`👁️ 已直接从视频画面提取硬字幕 (共 ${collectedSubs.length} 条)！`);
    }

    // 存储字幕至云端 D1，并实时更新当前活跃展示的视图
    if (autoSave && targetNoteId) {
      try {
        const durationMs = Date.now() - extractionStartTime;
        await fetch(`/api/notes/${targetNoteId}/transcript`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({
            transcript: finalTranscript,
            durationMs,
            method: isSlowMode ? "vision_slow" : "vision_fast",
            extractedAt: Date.now()
          })
        });

        if (state.activeDetailNote && state.activeDetailNote.id === targetNoteId) {
          state.activeDetailNote.transcript = finalTranscript;
          // 若详情弹窗当前打开，刷新详情弹窗内的字幕框
          const modalPanel = document.getElementById("modal-transcript-panel");
          const modalDetail = document.getElementById("modal-note-detail");
          if (renderBox && modalPanel && modalDetail?.classList.contains("active")) {
            renderTranscriptBox(modalPanel, finalTranscript, targetNoteId, providerUsed);
          }
        }

        // 若主页正显示该笔记解析结果，同步刷新
        if (state.lastParsedNote && (state.lastParsedNote.noteId === targetNoteId || state.lastParsedNote.id === targetNoteId)) {
          state.lastParsedNote.transcript = finalTranscript;
          const mainPanel = document.getElementById("transcript-panel");
          if (renderBox && mainPanel) {
            renderTranscriptBox(mainPanel, finalTranscript, targetNoteId, providerUsed);
          }
        }
      } catch (err) {
        console.warn("保存字幕到数据库失败:", err);
      }
    }

    return {
      success: true,
      transcript: finalTranscript,
      items: collectedSubs,
      provider: providerUsed
    };
  } catch (err) {
    if (fallbackToSpeech && container && renderBox) {
      console.warn("画面字幕提取遇到限制或未果，自动切换至 AI 语音识别:", err.message);
      showToast("🐢 画面视觉接口繁忙，已自动为您平滑切换至 AI 语音极速转写！");
      try {
        await transcribeAudio(mediaUrl, containerSelector, noteId);
        return true;
      } catch (audioErr) {
        console.error("Fallback speech transcription error:", audioErr);
      }
    }
    if (fallbackToSpeech) {
      return false;
    }
    console.error("Hard subtitle OCR error:", err);
    if (renderBox && container) {
      // 遇到视觉限制时，直接自动平滑转为语音识别兜底
      showToast("🐢 画面字幕识别受限，正在平滑切换至 AI 语音极速转写...");
      try {
        await transcribeAudio(mediaUrl, containerSelector, noteId);
        return true;
      } catch (audioErr) {
        const cleanMsg = String(err.message || "").includes("5016")
          ? "视觉模型接口繁忙，已尝试切换语音识别"
          : escapeHtml(err.message);
        container.innerHTML = `
          <div style="color: var(--primary); font-size: 13px; padding: 12px; background: rgba(234, 44, 67, 0.05); border-radius: 8px;">
            ⚠️ 字幕与文案提取未成功 (${cleanMsg})，请检查网络或在系统设置中确认 API Key。
          </div>
        `;
        showToast(`提取未果: ${cleanMsg}`, { isError: true });
        return false;
      }
    }
    if (!renderBox) {
      throw err;
    }
    return false;
  } finally {
    if (createdBlobUrl) {
      URL.revokeObjectURL(createdBlobUrl);
    }
    if (tempVideo) {
      tempVideo.src = "";
      tempVideo.remove();
    }
  }
}

// 全局后台慢速精细画面字幕提取任务队列 (支持多端自动断点接力与实时耗时看板监控)
const BackgroundSubtitleQueue = {
  queue: [],
  isProcessing: false,
  currentNote: null,
  failedNoteIds: new Set(),
  isCheckingPending: false,
  lastCheckTime: 0,
  taskStartTime: 0,
  tickerTimer: null,
  isPaused: localStorage.getItem("xhs_relay_paused") === "true",

  enqueue(note) {
    if (!note) return;
    const noteId = note.id || note.noteId;
    if (!noteId) return;

    // 手工提取模式跳过自动队列
    if (note.status === 'manual' || note.isManual || note.extractionStatus === 'manual') return;

    // 已有文案或已在处理中或已在队列中，跳过
    if (note.transcript && String(note.transcript).trim()) return;
    if (this.currentNote && (this.currentNote.id === noteId || this.currentNote.noteId === noteId)) return;
    if (this.queue.some(n => (n.id || n.noteId) === noteId)) return;

    // 需有视频
    const hasVideo = Array.isArray(note.videos) && note.videos.length > 0 && Boolean(note.videos[0]?.url || note.videos[0]);
    if (!hasVideo) return;

    // 关键：尝试失败过的任务放到队列最后；全新未尝试任务排在前面优先处理！
    const failCount = Number(note.failCount || note.extractionFailCount || 0);
    if (failCount > 0) {
      this.queue.push(note);
    } else {
      const firstFailIdx = this.queue.findIndex(n => Number(n.failCount || n.extractionFailCount || 0) > 0);
      if (firstFailIdx !== -1) {
        this.queue.splice(firstFailIdx, 0, note);
      } else {
        this.queue.push(note);
      }
    }

    this.updatePillUI();
    if (typeof ExtractionDashboardManager !== "undefined") {
      ExtractionDashboardManager.renderStats();
      if (ExtractionDashboardManager.activeView === "tasks") {
        ExtractionDashboardManager.renderList();
      }
    }
    this.processNext();
  },

  removeFromQueue(noteId) {
    if (!noteId) return;
    const idStr = String(noteId);
    this.queue = this.queue.filter(n => String(n.id || n.noteId) !== idStr);
    this.updatePillUI();
  },

  togglePause() {
    this.isPaused = !this.isPaused;
    localStorage.setItem("xhs_relay_paused", String(this.isPaused));
    this.updatePillUI();
    if (typeof ExtractionDashboardManager !== "undefined") {
      ExtractionDashboardManager.updateRelayStatusUI();
    }
    if (!this.isPaused && !this.isProcessing) {
      showToast("▶️ 已继续后台自动接力字幕提取");
      this.processNext();
    } else if (this.isPaused) {
      showToast("⏸️ 已暂停后台自动接力字幕提取");
    }
    return this.isPaused;
  },

  startTaskTimer(noteTitle, noteId) {
    this.taskStartTime = Date.now();
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
    }
    const banner = document.getElementById("kb-task-active-banner");
    const titleEl = document.getElementById("kb-active-task-title");
    const timerEl = document.getElementById("kb-active-task-timer");
    const barEl = document.getElementById("kb-active-task-bar");

    if (banner) banner.style.display = "flex";
    if (titleEl) {
      titleEl.textContent = noteTitle || "视频笔记";
      titleEl.onclick = () => {
        if (noteId && typeof openNoteDetail === "function") openNoteDetail(noteId);
      };
    }
    if (barEl) barEl.style.width = "0%";
    if (timerEl) timerEl.textContent = "⏱️ 已耗时 0s";

    this.tickerTimer = setInterval(() => {
      if (!this.taskStartTime) return;
      const elapsedSec = Math.round((Date.now() - this.taskStartTime) / 1000);
      const tEl = document.getElementById("kb-active-task-timer");
      if (tEl) tEl.textContent = `⏱️ 已耗时 ${elapsedSec}s`;
    }, 1000);
  },

  stopTaskTimer() {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer);
      this.tickerTimer = null;
    }
    this.taskStartTime = 0;
    const banner = document.getElementById("kb-task-active-banner");
    if (banner) banner.style.display = "none";
  },

  updateActiveProgress(percent) {
    const barEl = document.getElementById("kb-active-task-bar");
    if (barEl) {
      barEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    }
  },

  // 🔍 核心：多端断点接力检测器 (从 Cloudflare D1 拉取所有未提取文案的视频笔记)
  async checkAndResumePending(showNotify = false) {
    const autoBgOcr = localStorage.getItem("xhs_auto_bg_ocr") !== "false";
    if (!autoBgOcr && !showNotify) return 0;
    if (this.isCheckingPending) return 0;

    this.isCheckingPending = true;
    this.lastCheckTime = Date.now();

    try {
      const res = await fetch("/api/notes-pending-subtitles?limit=60", {
        headers: { "x-auth-pin": state.pin }
      });
      if (!res.ok) return 0;

      const data = await res.json();
      const items = data.items || [];
      const totalPending = typeof data.total === "number" ? data.total : items.length;

      // 同步更新系统设置与知识库待提取字幕徽标与快捷按钮
      const badge = document.getElementById("pending-ocr-badge");
      if (badge) {
        if (totalPending > 0) {
          badge.textContent = `待提取 ${totalPending} 篇`;
          badge.style.display = "inline-flex";
        } else {
          badge.style.display = "none";
        }
      }
      const kbBtn = document.getElementById("btn-kb-pending-subtitles");
      const kbText = document.getElementById("kb-pending-subtitles-text");
      if (kbBtn && kbText) {
        if (totalPending > 0) {
          kbText.textContent = `待提取字幕 (${totalPending})`;
          kbBtn.style.display = "inline-flex";
        } else {
          kbBtn.style.display = "none";
        }
      }

      if (typeof ExtractionDashboardManager !== "undefined") {
        ExtractionDashboardManager.renderStats();
      }

      if (!autoBgOcr && !showNotify) return 0;
      if (!Array.isArray(items) || items.length === 0) return 0;

      let addedCount = 0;
      const freshNotes = [];
      const failedNotes = [];

      items.forEach((note) => {
        const noteId = note.id;
        if (!noteId) return;
        // 排除已标记为手工提取的笔记
        if (note.status === 'manual' || note.isManual || note.extractionStatus === 'manual') return;
        if (this.failedNoteIds.has(noteId)) return;
        if (this.currentNote && (this.currentNote.id === noteId || this.currentNote.noteId === noteId)) return;
        if (this.queue.some((n) => (n.id || n.noteId) === noteId)) return;

        if (Number(note.failCount || note.extractionFailCount || 0) > 0) {
          failedNotes.push(note);
        } else {
          freshNotes.push(note);
        }
      });

      // 核心要求：未尝试的新鲜任务排在最前处理，失败过的任务放到队列末尾！
      const sortedToAdd = [...freshNotes, ...failedNotes];
      sortedToAdd.forEach((n) => {
        this.queue.push(n);
        addedCount++;
      });

      if (addedCount > 0) {
        this.updatePillUI();
        if (typeof ExtractionDashboardManager !== "undefined") {
          ExtractionDashboardManager.renderStats();
          if (ExtractionDashboardManager.activeView === "tasks") {
            ExtractionDashboardManager.renderList();
          }
        }
        if (showNotify || !this.isProcessing) {
          showToast(`🐢 检测到 ${addedCount} 篇未提取文案的视频，已加入后台慢速精细提取队列...`);
        }
        this.processNext();
      }
      return addedCount;
    } catch (err) {
      console.warn("checkAndResumePending error:", err);
      return 0;
    } finally {
      this.isCheckingPending = false;
    }
  },

  updatePillUI(customText = null) {
    const pill = document.getElementById("bg-subtitle-pill");
    const textEl = document.getElementById("bg-subtitle-text");
    if (!pill || !textEl) return;

    const remaining = this.queue.length + (this.isProcessing ? 1 : 0);
    if (remaining === 0) {
      pill.style.display = "none";
      return;
    }

    pill.style.display = "flex";
    if (this.isPaused) {
      textEl.textContent = `⏸️ 后台慢速提取已暂停 (待处理 ${remaining} 个)`;
      return;
    }

    if (customText) {
      textEl.textContent = customText;
    } else {
      const title = (this.currentNote?.title || "视频笔记").substring(0, 10);
      textEl.textContent = `🐢 后台慢速提取字幕: 「${title}...」(队列待处理 ${this.queue.length} 个)`;
    }
  },

  async processNext() {
    if (this.isProcessing) return;
    if (this.isPaused) {
      this.updatePillUI();
      return;
    }
    if (this.queue.length === 0) {
      this.updatePillUI();
      this.stopTaskTimer();
      return;
    }

    this.isProcessing = true;
    this.currentNote = this.queue.shift();
    const note = this.currentNote;
    const noteId = note.id || note.noteId;
    const videoUrl = note.videos[0]?.url || note.videos[0];
    const noteTitle = (note.title || "视频笔记").trim();

    this.startTaskTimer(noteTitle, noteId);
    if (typeof ExtractionDashboardManager !== "undefined") {
      ExtractionDashboardManager.renderStats();
      if (ExtractionDashboardManager.activeView === "tasks") {
        ExtractionDashboardManager.renderList();
      }
    }

    try {
      this.updatePillUI(`🐢 后台精细提取准备中: 「${noteTitle.substring(0, 10)}...」`);

      let visionError = "";
      let ok = false;
      try {
        ok = await extractVideoHardSubtitles(videoUrl, null, noteId, {
          isSlowMode: true,
          stepSec: 1.6,
          batchDelayMs: 2500,
          fallbackToSpeech: false,
          onProgress: ({ percent, currentBatch, totalBatches }) => {
            this.updateActiveProgress(percent);
            this.updatePillUI(`🐢 后台精细提取 (${percent}% 第${currentBatch}/${totalBatches}批): 「${noteTitle.substring(0, 8)}...」`);
          }
        });
      } catch (vErr) {
        visionError = vErr.message || String(vErr);
        ok = false;
      }

      if (!ok) {
        // 视觉未提取到或遇到限制时，自动无缝启用 AI 语音转写 (Groq Whisper Large-v3) 极速补齐
        this.updatePillUI(`🎙️ 画面字幕未就绪，自动转为语音转写: 「${noteTitle.substring(0, 8)}...」`);
        try {
          const speechRes = await transcribeAudio(videoUrl, null, noteId);
          if (!speechRes || !speechRes.transcript || !speechRes.transcript.trim()) {
            throw new Error(visionError ? `画面视觉未提取到字幕 (${visionError})，且音频未识别出有效人声` : "画面与音频均未检测到清晰字幕或人声");
          }
        } catch (sErr) {
          const finalReason = visionError 
            ? `画面视觉: ${visionError}；语音转写: ${sErr.message || sErr}`
            : (sErr.message || "未能识别出有效字幕或语音人声");
          throw new Error(finalReason);
        }
      }

      showToast(`✅ 后台已完成「${noteTitle.substring(0, 12)}」文案字幕提取！`);
      if (typeof ShufflePlayer !== "undefined" && typeof ShufflePlayer.loadPlaylist === "function") {
        ShufflePlayer.loadPlaylist();
      }
    } catch (err) {
      const durationMs = Date.now() - (this.taskStartTime || Date.now());
      const cleanErrMsg = (err.message || String(err)).replace(/Error:\s*/g, "").slice(0, 400);
      console.warn("Background subtitle extraction error for note:", noteId, cleanErrMsg);
      this.failedNoteIds.add(noteId);

      // 上报失败原因、耗时与尝试记录到云端 D1
      try {
        await fetch(`/api/notes/${noteId}/extraction-failure`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({
            errorMessage: cleanErrMsg,
            durationMs,
            method: "vision_slow"
          })
        });
      } catch (saveErr) {
        console.warn("Failed to report extraction failure to D1:", saveErr);
      }

      showToast(`⚠️「${noteTitle.substring(0, 10)}」提取未成功: ${cleanErrMsg.substring(0, 32)}`, { isError: true });
    } finally {
      this.stopTaskTimer();
      this.isProcessing = false;
      this.currentNote = null;
      this.updatePillUI();

      if (typeof ExtractionDashboardManager !== "undefined") {
        ExtractionDashboardManager.refresh();
      }

      if (this.queue.length > 0) {
        setTimeout(() => this.processNext(), 2000);
      } else {
        // 当前队列已跑完，检查云端是否还有下一批未提取文案的视频（全自动连续接力）
        const autoBgOcr = localStorage.getItem("xhs_auto_bg_ocr") !== "false";
        if (autoBgOcr) {
          setTimeout(async () => {
            const added = await this.checkAndResumePending(false);
            if (added === 0) {
              const kbContainer = document.getElementById("kb-cards-container");
              if (kbContainer && kbContainer.children.length > 0) {
                loadNotes(document.getElementById("kb-search-input")?.value || "");
              }
            }
          }, 2500);
        } else {
          const kbContainer = document.getElementById("kb-cards-container");
          if (kbContainer && kbContainer.children.length > 0) {
            loadNotes(document.getElementById("kb-search-input")?.value || "");
          }
        }
      }
    }
  }
};

// ==========================================================================
// 🐢 慢速精细字幕提取看板管理器 (ExtractionDashboardManager)
// 统一管理多端断点接力、耗时统计、分类记录、失败排查与笔记快捷详情进入
// ==========================================================================
export const ExtractionDashboardManager = {
  currentFilter: "all",
  searchQuery: "",
  tasksData: null,
  activeView: "notes", // "notes" | "tasks"

  init() {
    // 绑定顶部视图分段切换 (笔记库 vs 提取看板)
    const btnNotes = document.getElementById("btn-kb-view-notes");
    const btnTasks = document.getElementById("btn-kb-view-tasks");
    btnNotes?.addEventListener("click", () => this.switchView("notes"));
    btnTasks?.addEventListener("click", () => this.switchView("tasks"));

    // 绑定分类 Tab
    const tabBtns = document.querySelectorAll(".kb-task-tab");
    tabBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        tabBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.currentFilter = btn.dataset.filter || "all";
        this.renderList();
      });
    });

    // 绑定搜索过滤
    const searchInput = document.getElementById("kb-tasks-search-input");
    searchInput?.addEventListener("input", (e) => {
      this.searchQuery = e.target.value.trim().toLowerCase();
      this.renderList();
    });

    // 绑定暂停/恢复接力按钮
    const toggleRelayBtn = document.getElementById("btn-kb-toggle-relay");
    toggleRelayBtn?.addEventListener("click", () => {
      BackgroundSubtitleQueue.togglePause();
      this.updateRelayStatusUI();
    });

    // 绑定立即扫描按钮
    const rescanBtn = document.getElementById("btn-kb-rescan-tasks");
    rescanBtn?.addEventListener("click", async () => {
      showToast("🔄 正在扫描全库待提取文案的视频笔记...");
      const count = await BackgroundSubtitleQueue.checkAndResumePending(true);
      await this.refresh();
      showToast(`扫描完毕，已加入 ${count} 篇待接力提取视频`);
    });

    // 绑定浮动指示胶囊点击 -> 一键直达提取看板
    const pill = document.getElementById("bg-subtitle-pill");
    pill?.addEventListener("click", () => {
      const kbTabBtn = document.getElementById("tab-nav-kb");
      kbTabBtn?.click();
      this.switchView("tasks");
    });

    this.updateRelayStatusUI();
  },

  updateRelayStatusUI() {
    const isPaused = BackgroundSubtitleQueue.isPaused;
    const dot = document.getElementById("kb-task-relay-dot");
    const text = document.getElementById("kb-task-relay-status-text");
    const btn = document.getElementById("btn-kb-toggle-relay");

    if (dot) {
      dot.className = `relay-status-dot ${isPaused ? "paused" : "running"}`;
    }
    if (text) {
      text.textContent = isPaused ? "自动接力已暂停" : "自动接力运行中";
    }
    if (btn) {
      btn.innerHTML = isPaused ? "▶️ 继续接力" : "⏸️ 暂停接力";
    }
  },

  switchView(viewName) {
    this.activeView = viewName;
    const notesContent = document.getElementById("kb-view-notes-content");
    const tasksContent = document.getElementById("kb-view-tasks-content");
    const btnNotes = document.getElementById("btn-kb-view-notes");
    const btnTasks = document.getElementById("btn-kb-view-tasks");

    if (viewName === "tasks") {
      if (notesContent) notesContent.style.display = "none";
      if (tasksContent) tasksContent.style.display = "block";
      btnNotes?.classList.remove("active");
      btnTasks?.classList.add("active");
      this.refresh();
    } else {
      if (tasksContent) tasksContent.style.display = "none";
      if (notesContent) notesContent.style.display = "block";
      btnTasks?.classList.remove("active");
      btnNotes?.classList.add("active");
    }
  },

  async refresh() {
    try {
      const res = await fetch("/api/notes-extraction-tasks?limit=200", {
        headers: { "x-auth-pin": state.pin }
      });
      if (res.ok) {
        this.tasksData = await res.json();
        this.renderStats();
        this.renderList();
      }
    } catch (err) {
      console.warn("Failed to refresh extraction tasks:", err);
    }
  },

  renderStats() {
    const pendingCount = this.tasksData?.stats?.pendingCount !== undefined
      ? this.tasksData.stats.pendingCount
      : (this.tasksData?.pending !== undefined ? this.tasksData.pending : BackgroundSubtitleQueue.queue.length + (BackgroundSubtitleQueue.currentNote ? 1 : 0));
    const completedCount = this.tasksData?.stats?.completedCount !== undefined
      ? this.tasksData.stats.completedCount
      : (this.tasksData?.completed || 0);
    const failedCount = this.tasksData?.stats?.failedCount !== undefined
      ? this.tasksData.stats.failedCount
      : 0;
    const avgSec = this.tasksData?.stats?.avgDurationSec !== undefined
      ? this.tasksData.stats.avgDurationSec
      : (this.tasksData?.avgDurationSec || 0);

    const pendingEl = document.getElementById("kb-stat-pending-count");
    const completedEl = document.getElementById("kb-stat-completed-count");
    const failedEl = document.getElementById("kb-stat-failed-count");
    const avgEl = document.getElementById("kb-stat-avg-duration");
    const badgeEl = document.getElementById("kb-tasks-badge");

    if (pendingEl) pendingEl.textContent = pendingCount;
    if (completedEl) completedEl.textContent = completedCount;
    if (failedEl) failedEl.textContent = failedCount;
    if (avgEl) avgEl.textContent = avgSec > 0 ? `${avgSec}s` : "--";

    // 统计各 Tab 上的数量
    const tabAllCount = document.getElementById("kb-tab-all-count");
    const tabActiveCount = document.getElementById("kb-tab-active-count");
    const tabCompletedCount = document.getElementById("kb-tab-completed-count");
    const tabFailedCount = document.getElementById("kb-tab-failed-count");
    const tabManualCount = document.getElementById("kb-tab-manual-count");

    const manualCount = this.tasksData?.stats?.manualCount !== undefined
      ? this.tasksData.stats.manualCount
      : (this.tasksData?.items || []).filter(it => it.status === "manual" || it.isManual).length;

    if (tabAllCount) tabAllCount.textContent = (this.tasksData?.items || []).length;
    if (tabActiveCount) tabActiveCount.textContent = pendingCount + (BackgroundSubtitleQueue.currentNote ? 1 : 0);
    if (tabCompletedCount) tabCompletedCount.textContent = completedCount;
    if (tabFailedCount) tabFailedCount.textContent = failedCount;
    if (tabManualCount) tabManualCount.textContent = manualCount;

    if (badgeEl) {
      badgeEl.textContent = pendingCount;
      badgeEl.style.display = pendingCount > 0 ? "inline-flex" : "none";
    }
  },

  renderList() {
    const listEl = document.getElementById("kb-tasks-list");
    if (!listEl) return;

    if (!this.tasksData || !Array.isArray(this.tasksData.items)) {
      listEl.innerHTML = `<div class="kb-task-empty"><div class="empty-icon">⏳</div><div>正在加载提取任务记录...</div></div>`;
      return;
    }

    let items = [...this.tasksData.items];
    const currentNote = BackgroundSubtitleQueue.currentNote;
    const memoryQueue = BackgroundSubtitleQueue.queue;
    const currentId = currentNote ? (currentNote.id || currentNote.noteId) : null;

    const itemMap = new Map();
    items.forEach(it => itemMap.set(String(it.id), it));

    if (currentNote && currentId) {
      const existing = itemMap.get(String(currentId)) || {};
      itemMap.set(String(currentId), {
        ...existing,
        id: currentId,
        title: currentNote.title || existing.title || "视频笔记",
        coverUrl: currentNote.coverUrl || existing.coverUrl || (currentNote.images && currentNote.images[0]?.url) || "",
        status: "processing",
        statusText: "正在提取",
        method: "vision_slow",
        methodName: "🐢 画面慢速精细"
      });
    }

    memoryQueue.forEach(qNote => {
      const qId = qNote.id || qNote.noteId;
      if (!qId) return;
      const existing = itemMap.get(String(qId)) || {};
      itemMap.set(String(qId), {
        ...existing,
        id: qId,
        title: qNote.title || existing.title || "视频笔记",
        coverUrl: qNote.coverUrl || existing.coverUrl || (qNote.images && qNote.images[0]?.url) || "",
        status: "pending",
        statusText: "排队待提取",
        method: existing.method || "vision_slow",
        methodName: existing.methodName || "🐢 待接力"
      });
    });

    items = Array.from(itemMap.values());

    // 核心要求排序：处理中 > 全新未尝试排队中 > 尝试失败(放到队列最后) > 手工提取模式 > 已完成
    items.sort((a, b) => {
      const score = (item) => {
        if (item.status === "processing") return 5;
        if (item.status === "pending" && (!item.failCount || item.failCount === 0)) return 4;
        if (item.status === "failed" || (item.failCount > 0 && !item.isCompleted && !item.isManual && item.status !== "manual")) return 2;
        if (item.status === "manual" || item.isManual) return 1.5;
        return 1; // completed
      };
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return (b.extractedAt || b.createdAt || b.downloadTime || 0) - (a.extractedAt || a.createdAt || a.downloadTime || 0);
    });

    // 分类筛选
    if (this.currentFilter === "active") {
      items = items.filter(it => it.status === "processing" || (it.status === "pending" && (!it.failCount || it.failCount === 0)));
    } else if (this.currentFilter === "completed") {
      items = items.filter(it => it.status === "completed" || it.isCompleted);
    } else if (this.currentFilter === "failed") {
      items = items.filter(it => (it.status === "failed" || it.failCount > 0) && !it.isCompleted && !it.isManual && it.status !== "manual");
    } else if (this.currentFilter === "manual") {
      items = items.filter(it => (it.status === "manual" || it.isManual) && !it.isCompleted);
    }

    // 关键词搜索
    if (this.searchQuery) {
      items = items.filter(it => (it.title || "").toLowerCase().includes(this.searchQuery));
    }

    if (items.length === 0) {
      listEl.innerHTML = `
        <div class="kb-task-empty">
          <div class="empty-icon">📭</div>
          <div style="font-weight: 600; margin-bottom: 4px;">暂无相关提取记录</div>
          <div style="font-size: 12px; color: var(--text-muted);">
            ${this.currentFilter === 'active' ? '当前没有正在处理或排队的接力任务' : (this.currentFilter === 'failed' ? '太棒了！暂无提取异常的记录' : (this.currentFilter === 'manual' ? '暂无手动提取模式的视频笔记' : '暂未找到符合条件的提取任务'))}
          </div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = "";
    items.forEach(task => {
      const card = document.createElement("div");
      card.className = `kb-task-card ${task.status}`;

      const durationText = task.durationSec > 0 ? `⏱️ 耗时 ${task.durationSec}s` : "";
      const methodLabel = task.methodName || (task.method === "vision_slow" ? "🐢 画面慢速精细" : task.method?.startsWith("speech") ? "🎙️ 语音智能转写" : "AI 提取");

      let statusBadgeClass = "pending";
      let statusBadgeLabel = "⏳ 排队待提取";
      if (task.status === "completed" || task.isCompleted) {
        statusBadgeClass = "completed";
        statusBadgeLabel = "✅ 已提取文案";
      } else if (task.status === "processing") {
        statusBadgeClass = "processing";
        statusBadgeLabel = "🔄 正在提取中";
      } else if (task.status === "manual" || task.isManual) {
        statusBadgeClass = "manual";
        statusBadgeLabel = "🖐️ 手工提取模式";
      } else if (task.status === "failed" || task.failCount > 0) {
        statusBadgeClass = "failed";
        statusBadgeLabel = `⚠️ 提取异常 (失败 ${task.failCount} 次)`;
      }

      // 组装失败原因与历史列表展开结构
      let failureBoxHtml = "";
      if (task.failCount > 0) {
        const errorLogs = Array.isArray(task.errorLog) && task.errorLog.length > 0
          ? task.errorLog
          : (task.lastError ? [{ attempt: task.failCount, time: task.updatedAt || Date.now(), error: task.lastError, durationSec: task.durationSec }] : []);

        const hasMultiple = errorLogs.length > 1;
        const latestLog = errorLogs[0] || {};
        const latestDurationStr = (latestLog.durationSec > 0 || task.durationSec > 0) ? ` · 耗时 ${latestLog.durationSec || task.durationSec}s` : "";

        failureBoxHtml = `
          <div class="task-failure-box">
            <div class="task-failure-header">
              <div class="failure-title-wrap">
                <span class="failure-badge">⚠️ 尝试失败 ${task.failCount} 次${latestDurationStr}</span>
                <span class="failure-latest-reason">${escapeHtml(task.lastError || latestLog.error || "提取过程遇到异常")}</span>
              </div>
              <div style="display: inline-flex; align-items: center; gap: 6px;">
                ${!task.isCompleted && !task.isManual && task.status !== "manual" ? `
                  <button type="button" class="btn-box-switch-manual" title="转入手工提取模式，避免后台接力反复重试">🖐️ 切换成手工提取</button>
                ` : ""}
                ${hasMultiple ? `<button type="button" class="btn-toggle-error-history">查看各次原因 (${errorLogs.length}次) ▾</button>` : ''}
              </div>
            </div>
            ${hasMultiple ? `
              <div class="task-failure-history" style="display: none;">
                ${errorLogs.map((log, idx) => `
                  <div class="failure-history-item">
                    <div class="failure-history-meta">
                      <span class="fail-idx">第 ${log.attempt || (errorLogs.length - idx)} 次</span>
                      <span class="fail-duration">⏱️ 用时 ${log.durationSec || Math.round((log.durationMs || 0)/1000)}s</span>
                      <span class="fail-time">${log.time ? formatTime(log.time) : ""}</span>
                      ${log.method ? `<span style="font-size: 10.5px; color: #6b7280;">(${log.method})</span>` : ""}
                    </div>
                    <div class="fail-reason">${escapeHtml(log.error || "未记录具体异常信息")}</div>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
        `;
      }

      card.innerHTML = `
        <div class="kb-task-main">
          <img src="${task.coverUrl || '/favicon.svg'}" class="kb-task-cover" alt="封面" loading="lazy" title="点击查看笔记详情与文案" />
          <div class="kb-task-content">
            <div class="kb-task-title" title="点击查看笔记详情与文案">${escapeHtml(task.title || "视频笔记")}</div>
            <div class="kb-task-meta">
              <span class="task-status-pill ${statusBadgeClass}">${statusBadgeLabel}</span>
              ${task.isCompleted && task.failCount > 0 ? `<span class="task-prev-failed-pill" title="该笔记曾尝试失败后成功提取">⚠️ 曾失败 ${task.failCount} 次后成功</span>` : ""}
              ${durationText ? `<span class="task-duration-pill">${durationText}</span>` : ""}
              <span class="task-method-badge">${methodLabel}</span>
              <span style="font-size: 11.5px; color: var(--text-muted);">${formatRelativeTime(task.extractedAt || task.downloadTime)}</span>
            </div>
            ${failureBoxHtml}
          </div>
        </div>
        <div class="kb-task-actions">
          <button class="btn btn-secondary btn-sm btn-task-view" type="button" title="查看笔记详情与完整提取文案">📖 查看</button>
          ${!task.isCompleted ? `
            ${(task.isManual || task.status === "manual") ? `
              <button class="btn btn-warning btn-sm btn-task-manual active" type="button" title="当前为手工提取模式，点击打开详情提取">🖐️ 手工提取</button>
              <button class="btn btn-ghost btn-sm btn-task-auto" type="button" title="恢复自动后台慢速接力">🔄 恢复自动</button>
            ` : `
              <button class="btn btn-warning btn-sm btn-task-manual" type="button" title="切换成手工提取模式，后台接力将不再重试此笔记">🖐️ 手工提取</button>
              ${task.status !== "processing" ? `<button class="btn btn-ghost btn-sm btn-task-retry" type="button" title="重新放入后台队列重新提取">🔄 重提</button>` : ""}
            `}
          ` : ""}
        </div>
      `;

      // 展开/收起多条失败原因明细
      card.querySelector(".btn-toggle-error-history")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const histEl = card.querySelector(".task-failure-history");
        if (histEl) {
          const isHidden = histEl.style.display === "none";
          histEl.style.display = isHidden ? "flex" : "none";
          e.currentTarget.textContent = isHidden ? `收起失败明细 ▴` : `查看各次原因 (${task.errorLog?.length || task.failCount}次) ▾`;
        }
      });

      // 切换为手工提取模式操作函数
      const switchToManual = async (e) => {
        if (e) e.stopPropagation();
        try {
          showToast("⏳ 正在切换为手工提取模式...");
          await fetch(`/api/notes/${task.id}/extraction-mode`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-auth-pin": state.pin
            },
            body: JSON.stringify({ mode: "manual" })
          });
          BackgroundSubtitleQueue.removeFromQueue(task.id);
          showToast("🖐️ 已切换为手工提取模式（后台接力已跳过此篇）！正在打开详情...");
          if (typeof openNoteDetail === "function") {
            await openNoteDetail(task.id);
            setTimeout(() => {
              const targetAction = document.getElementById("btn-modal-dual-extract") || document.getElementById("btn-modal-transcribe") || document.getElementById("modal-media-actions");
              if (targetAction) {
                targetAction.scrollIntoView({ behavior: "smooth", block: "center" });
                targetAction.classList.add("pulse-highlight");
                setTimeout(() => targetAction.classList.remove("pulse-highlight"), 4000);
              }
            }, 350);
          }
          ExtractionDashboardManager.refresh();
        } catch (err) {
          showToast(`切换失败: ${err.message}`);
        }
      };

      // 恢复自动接力提取操作函数
      const switchToAuto = async (e) => {
        if (e) e.stopPropagation();
        try {
          showToast("⏳ 正在恢复自动接力提取...");
          await fetch(`/api/notes/${task.id}/extraction-mode`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-auth-pin": state.pin
            },
            body: JSON.stringify({ mode: "auto" })
          });
          BackgroundSubtitleQueue.failedNoteIds.delete(task.id);
          BackgroundSubtitleQueue.enqueue({
            id: task.id,
            title: task.title,
            coverUrl: task.coverUrl,
            videos: task.videos || [{ url: task.videoUrl || "" }]
          });
          showToast("🔄 已恢复自动后台接力提取！");
          ExtractionDashboardManager.refresh();
        } catch (err) {
          showToast(`操作失败: ${err.message}`);
        }
      };

      // 绑定手工提取与恢复自动事件
      card.querySelector(".btn-task-manual")?.addEventListener("click", switchToManual);
      card.querySelector(".btn-box-switch-manual")?.addEventListener("click", switchToManual);
      card.querySelector(".btn-task-auto")?.addEventListener("click", switchToAuto);

      // 点击标题或封面直接进入该笔记详情
      card.querySelector(".kb-task-title")?.addEventListener("click", () => {
        if (typeof openNoteDetail === "function") openNoteDetail(task.id);
      });
      card.querySelector(".kb-task-cover")?.addEventListener("click", () => {
        if (typeof openNoteDetail === "function") openNoteDetail(task.id);
      });
      card.querySelector(".btn-task-view")?.addEventListener("click", () => {
        if (typeof openNoteDetail === "function") openNoteDetail(task.id);
      });
      card.querySelector(".btn-task-retry")?.addEventListener("click", (e) => {
        e.stopPropagation();
        showToast(`已将「${(task.title || "").substring(0, 8)}...」加入慢速精细提取队列`);
        BackgroundSubtitleQueue.failedNoteIds.delete(task.id);
        BackgroundSubtitleQueue.enqueue({
          id: task.id,
          title: task.title,
          coverUrl: task.coverUrl,
          videos: task.videos || [{ url: task.videoUrl || "" }]
        });
        ExtractionDashboardManager.refresh();
      });

      listEl.appendChild(card);
    });
  }
};

// 智能字幕与文案提取总入口：原生软字幕 -> 画面硬字幕 OCR -> AI 语音转写 (Whisper)
async function extractVideoSubtitlesOrAudio(mediaUrl, containerSelector, noteId, videoEl) {
  const container = document.querySelector(containerSelector);
  if (!container) return;
  container.style.display = "block";

  // 1. 优先探测视频原生软字幕轨 (TextTracks / cues)
  const softSubs = detectVideoSoftSubtitles(videoEl);
  if (softSubs && softSubs.length > 0) {
    const lines = softSubs.map(s => `[${s.timeStr}] ${s.text}`);
    const text = lines.join("\n");
    renderTranscriptBox(container, text, noteId, "soft-subtitles");
    triggerTranscriptAutoSave(container, noteId);
    showToast(`🎉 已直接从视频原生字幕轨提取 ${lines.length} 条字幕！`);
    return;
  }

  // 2. 尝试探测并提取画面硬字幕 (Vision OCR)
  const ocrSuccess = await extractVideoHardSubtitles(mediaUrl, containerSelector, noteId, { fallbackToSpeech: true });
  if (ocrSuccess) {
    return;
  }

  // 3. 画面无字幕时，平滑自动启用 AI 语音转写引擎 (Whisper Large-v3 / Cloudflare)
  await transcribeAudio(mediaUrl, containerSelector, noteId);
}

// 双模对比提取：慢速精细画面字幕提取 VS AI 语音识别转写，并排预览对比后手工确定采纳版本
async function runDualSubtitleExtraction(mediaUrl, containerSelector, noteId) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  container.style.display = "block";

  // 记录原先已有文案 (如果用户关闭对比或放弃，可以恢复)
  const prevTranscript = (state.activeDetailNote && state.activeDetailNote.id === noteId && state.activeDetailNote.transcript)
    ? state.activeDetailNote.transcript
    : ((state.lastParsedNote && (state.lastParsedNote.noteId === noteId || state.lastParsedNote.id === noteId) && state.lastParsedNote.transcript)
        ? state.lastParsedNote.transcript
        : "");

  container.innerHTML = `
    <div class="dual-compare-container">
      <div class="dual-compare-header">
        <div class="dual-compare-title-wrap">
          <div class="dual-compare-title">⚖️ 双模对比提取 · 画面字幕 VS 语音转写</div>
          <div class="dual-compare-sub">
            系统正在同时并发运行【慢速精细画面字幕提取】与【AI 语音识别转写】。您可在下方并排核对文案完整度、错别字与断句，点击底部按钮直接采纳心仪版本。
          </div>
        </div>
        <div class="dual-compare-header-actions">
          <button type="button" class="btn-dual-close" title="退出对比模式">✖️ 关闭对比</button>
        </div>
      </div>

      <div class="dual-compare-grid">
        <!-- 左侧：画面字幕提取 (Vision OCR) -->
        <div class="dual-col dual-col-vision" id="dual-col-vision">
          <div class="dual-col-header">
            <div class="dual-col-title-box">
              <span class="dual-col-tag tag-vision">🐢 慢速精细画面字幕</span>
              <span class="dual-stats-badge" id="dual-vision-stats">正在逐帧扫描...</span>
            </div>
            <span class="dual-engine-badge badge-vision" id="dual-vision-engine">CF Vision / Qwen</span>
          </div>

          <div class="dual-progress-wrap" id="dual-vision-progress-wrap">
            <div class="dual-status-text" id="dual-vision-status">正在准备抽帧分析画面字幕...</div>
            <div class="transcribe-progress-track">
              <div class="transcribe-progress-bar" id="dual-vision-progress-bar" style="width: 0%;"></div>
            </div>
          </div>

          <div class="dual-preview-box" id="dual-vision-preview">
            <div class="dual-empty-tip">⏳ 正在密集抽帧分析画面硬字幕 (慢速精细模式)...</div>
          </div>

          <div class="dual-col-footer">
            <button type="button" class="btn-adopt-dual btn-adopt-vision" id="btn-adopt-vision" disabled>
              ✅ 采纳画面字幕版
            </button>
            <button type="button" class="btn-copy-dual" id="btn-copy-vision" disabled title="复制画面字幕纯文本">
              📋 复制
            </button>
          </div>
        </div>

        <!-- 右侧：语音识别转写 (Whisper) -->
        <div class="dual-col dual-col-speech" id="dual-col-speech">
          <div class="dual-col-header">
            <div class="dual-col-title-box">
              <span class="dual-col-tag tag-speech">🎙️ AI 语音识别转写</span>
              <span class="dual-stats-badge" id="dual-speech-stats">准备中...</span>
            </div>
            <span class="dual-engine-badge badge-speech" id="dual-speech-engine">Groq Whisper Large-v3</span>
          </div>

          <div class="dual-progress-wrap" id="dual-speech-progress-wrap">
            <div class="dual-status-text" id="dual-speech-status">正在解析音频轨道...</div>
            <div class="transcribe-progress-track">
              <div class="transcribe-progress-bar" id="dual-speech-progress-bar" style="width: 0%;"></div>
            </div>
          </div>

          <div class="dual-preview-box" id="dual-speech-preview">
            <div class="dual-empty-tip">⏳ 正在提取视频音频进行语音识别...</div>
          </div>

          <div class="dual-col-footer">
            <button type="button" class="btn-adopt-dual btn-adopt-speech" id="btn-adopt-speech" disabled>
              ✅ 采纳语音转写版
            </button>
            <button type="button" class="btn-copy-dual" id="btn-copy-speech" disabled title="复制语音文案纯文本">
              📋 复制
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  // 绑定关闭对比按钮
  const closeBtn = container.querySelector(".btn-dual-close");
  if (closeBtn) {
    closeBtn.onclick = () => {
      if (prevTranscript) {
        renderTranscriptBox(container, prevTranscript, noteId);
      } else {
        container.style.display = "none";
        container.innerHTML = "";
      }
    };
  }

  // 点击时间戳跳转播放事件委托
  container.onclick = (e) => {
    const timeEl = e.target.closest(".dual-preview-time");
    if (timeEl && timeEl.dataset.time !== undefined && timeEl.dataset.time !== "") {
      const sec = parseFloat(timeEl.dataset.time);
      if (!isNaN(sec)) {
        seekAllMediaTo(sec);
      }
    }
  };

  // 视觉与语音 UI 节点缓存
  const visionStatusEl = container.querySelector("#dual-vision-status");
  const visionBarEl = container.querySelector("#dual-vision-progress-bar");
  const visionPreviewEl = container.querySelector("#dual-vision-preview");
  const visionStatsEl = container.querySelector("#dual-vision-stats");
  const visionEngineEl = container.querySelector("#dual-vision-engine");
  const btnAdoptVision = container.querySelector("#btn-adopt-vision");
  const btnCopyVision = container.querySelector("#btn-copy-vision");

  const speechStatusEl = container.querySelector("#dual-speech-status");
  const speechBarEl = container.querySelector("#dual-speech-progress-bar");
  const speechPreviewEl = container.querySelector("#dual-speech-preview");
  const speechStatsEl = container.querySelector("#dual-speech-stats");
  const speechEngineEl = container.querySelector("#dual-speech-engine");
  const btnAdoptSpeech = container.querySelector("#btn-adopt-speech");
  const btnCopySpeech = container.querySelector("#btn-copy-speech");

  let visionResult = null;
  let speechResult = null;

  // 渲染对比条目辅助函数
  const renderItemsToBox = (boxEl, items) => {
    if (!boxEl) return;
    if (!items || items.length === 0) {
      boxEl.innerHTML = `<div class="dual-empty-tip">暂无提取内容</div>`;
      return;
    }
    boxEl.innerHTML = items.map((it) => `
      <div class="dual-preview-item">
        <span class="dual-preview-time" data-time="${it.timeSec ?? ''}" title="点击跳转至此时间点播放">${escapeHtml(it.timeStr || '00:00')}</span>
        <span class="dual-preview-text">${escapeHtml(it.text)}</span>
      </div>
    `).join("");
    boxEl.scrollTop = boxEl.scrollHeight;
  };

  // 统一采纳保存处理
  const adoptVersion = async (chosenTranscript, chosenProvider, sourceName) => {
    const targetNoteId = noteId || state.activeDetailNote?.id;
    if (targetNoteId) {
      try {
        await fetch(`/api/notes/${targetNoteId}/transcript`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({ transcript: chosenTranscript })
        });

        if (state.activeDetailNote && state.activeDetailNote.id === targetNoteId) {
          state.activeDetailNote.transcript = chosenTranscript;
        }
        if (state.lastParsedNote && (state.lastParsedNote.noteId === targetNoteId || state.lastParsedNote.id === targetNoteId)) {
          state.lastParsedNote.transcript = chosenTranscript;
        }
      } catch (err) {
        console.warn("保存采纳文案到数据库失败:", err);
      }
    }

    renderTranscriptBox(container, chosenTranscript, targetNoteId, chosenProvider);
    showToast(`🎉 已成功采纳【${sourceName}】并永久保存至云端数据库！`);
  };

  // 采纳与复制按钮交互绑定
  if (btnAdoptVision) {
    btnAdoptVision.onclick = () => {
      if (visionResult?.transcript) {
        adoptVersion(visionResult.transcript, visionResult.provider || "vision", "画面字幕版");
      }
    };
  }
  if (btnCopyVision) {
    btnCopyVision.onclick = () => {
      if (visionResult?.transcript) {
        navigator.clipboard.writeText(visionResult.transcript);
        showToast("📋 已复制画面字幕全文！");
      }
    };
  }

  if (btnAdoptSpeech) {
    btnAdoptSpeech.onclick = () => {
      if (speechResult?.transcript) {
        adoptVersion(speechResult.transcript, speechResult.provider || "groq", "语音转写版");
      }
    };
  }
  if (btnCopySpeech) {
    btnCopySpeech.onclick = () => {
      if (speechResult?.transcript) {
        navigator.clipboard.writeText(speechResult.transcript);
        showToast("📋 已复制语音转写文案全文！");
      }
    };
  }

  // 1. 并发启动极速语音识别转写 (Whisper)
  const pSpeech = (async () => {
    try {
      const res = await transcribeAudio(mediaUrl, containerSelector, noteId, {
        autoSave: false,
        renderBox: false,
        onStatus: (msg) => {
          if (speechStatusEl) speechStatusEl.textContent = msg;
        },
        onProgress: ({ percent, current, total, msg }) => {
          if (speechBarEl) speechBarEl.style.width = `${percent}%`;
          if (speechStatusEl && msg) speechStatusEl.textContent = msg;
        },
        onPartialResult: (items) => {
          renderItemsToBox(speechPreviewEl, items);
          if (speechStatsEl) {
            const charCount = items.reduce((acc, it) => acc + (it.text ? it.text.length : 0), 0);
            speechStatsEl.textContent = `已识别 ${items.length} 句 · ${charCount} 字`;
          }
        }
      });

      if (res && res.items && res.items.length > 0) {
        speechResult = res;
        if (speechBarEl) speechBarEl.style.width = "100%";
        const totalChars = res.items.reduce((acc, it) => acc + (it.text ? it.text.length : 0), 0);
        if (speechStatusEl) speechStatusEl.textContent = `✨ 语音转写完成 (共 ${res.items.length} 句 · ${totalChars} 字)`;
        if (speechStatsEl) speechStatsEl.textContent = `共 ${res.items.length} 句 · ${totalChars} 字`;
        if (speechEngineEl && res.provider) {
          speechEngineEl.textContent = res.provider === "groq" ? "⚡ Groq Whisper Large-v3" : "☁️ Cloudflare AI";
        }
        renderItemsToBox(speechPreviewEl, res.items);
        if (btnAdoptSpeech) {
          btnAdoptSpeech.disabled = false;
          btnAdoptSpeech.classList.add("ready");
        }
        if (btnCopySpeech) btnCopySpeech.disabled = false;
        showToast(`🎙️ 语音转写就绪 (${res.items.length} 句)！可并排预览对比`);
      } else {
        throw new Error("未能识别出有效语音或音频中无清晰人声");
      }
    } catch (err) {
      console.warn("Dual extraction speech error:", err);
      if (speechStatusEl) speechStatusEl.textContent = `⚠️ 语音转写未成功: ${err.message}`;
      if (speechPreviewEl) {
        speechPreviewEl.innerHTML = `
          <div class="dual-error-tip">
            <p>❌ 语音转写未成功 (${escapeHtml(err.message)})</p>
            <p style="margin-top: 6px; font-size: 12px; color: #64748b;">提示：若视频无声或声音过小，可参考左侧【画面字幕提取】。</p>
          </div>
        `;
      }
    }
  })();

  // 2. 并发启动慢速精细画面字幕提取 (Vision OCR)
  const pVision = (async () => {
    try {
      const res = await extractVideoHardSubtitles(mediaUrl, containerSelector, noteId, {
        isSlowMode: true,
        stepSec: 1.6,
        batchDelayMs: 2200,
        fallbackToSpeech: false, // 对比模式下画面字幕无需降级回语音，各自独立展示真实效果
        autoSave: false,
        renderBox: false,
        onStatus: (msg) => {
          if (visionStatusEl) visionStatusEl.textContent = msg;
        },
        onProgress: ({ percent, currentBatch, totalBatches, msg }) => {
          if (visionBarEl) visionBarEl.style.width = `${percent}%`;
          if (visionStatusEl && msg) visionStatusEl.textContent = msg;
        },
        onPartialResult: (subs) => {
          renderItemsToBox(visionPreviewEl, subs);
          if (visionStatsEl) {
            const charCount = subs.reduce((acc, it) => acc + (it.text ? it.text.length : 0), 0);
            visionStatsEl.textContent = `已扫描 ${subs.length} 句 · ${charCount} 字`;
          }
        }
      });

      if (res && res.items && res.items.length > 0) {
        visionResult = res;
        if (visionBarEl) visionBarEl.style.width = "100%";
        const totalChars = res.items.reduce((acc, it) => acc + (it.text ? it.text.length : 0), 0);
        if (visionStatusEl) visionStatusEl.textContent = `✨ 画面字幕提取完成 (共 ${res.items.length} 句 · ${totalChars} 字)`;
        if (visionStatsEl) visionStatsEl.textContent = `共 ${res.items.length} 句 · ${totalChars} 字`;
        if (visionEngineEl && res.provider) {
          visionEngineEl.textContent = res.provider.includes("llama") ? "🦙 Llama 3.2 Vision" : (res.provider === "groq" ? "⚡ Groq Vision" : res.provider);
        }
        renderItemsToBox(visionPreviewEl, res.items);
        if (btnAdoptVision) {
          btnAdoptVision.disabled = false;
          btnAdoptVision.classList.add("ready");
        }
        if (btnCopyVision) btnCopyVision.disabled = false;
        showToast(`🐢 画面字幕提取就绪 (${res.items.length} 句)！`);
      } else {
        throw new Error("视频画面未检测到清晰硬字幕");
      }
    } catch (err) {
      console.warn("Dual extraction vision error:", err);
      if (visionStatusEl) visionStatusEl.textContent = `⚠️ 画面硬字幕未能提取: ${err.message}`;
      if (visionPreviewEl) {
        visionPreviewEl.innerHTML = `
          <div class="dual-error-tip">
            <p>⚠️ 画面字幕未检测到字幕或已限流 (${escapeHtml(err.message)})</p>
            <p style="margin-top: 6px; font-size: 12px; color: #64748b;">提示：若视频无底部硬字幕或视觉接口繁忙，建议右侧直接点击【采纳语音转写版】。</p>
          </div>
        `;
      }
    }
  })();
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

// 知识库分类、博主与笔记加载
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

    if (state.filterMode === "tags") {
      renderTagsList();
    }
    // 同时刷新博主数据
    loadAuthors();
  } catch (err) {
    console.warn("loadTags error:", err);
  }
}

async function loadAuthors() {
  const badge = document.getElementById("kb-authors-count-badge");
  try {
    const res = await fetch("/api/authors", {
      headers: { "x-auth-pin": state.pin }
    });
    if (res.status === 401) {
      showPinLockView(true);
      return;
    }
    const data = await res.json();
    if (!data.success) return;

    state.authors = data.authors || [];
    state.unknownAuthorCount = data.unknownCount || 0;

    if (badge) {
      badge.textContent = state.authors.length;
    }

    if (state.filterMode === "authors") {
      renderAuthorsList();
    }
  } catch (err) {
    console.warn("loadAuthors error:", err);
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

  updateActiveFilterIndicator();
}

function renderAuthorsList() {
  const tagListContainer = document.getElementById("kb-tag-list");
  if (!tagListContainer) return;
  tagListContainer.innerHTML = "";

  const allItem = document.createElement("div");
  allItem.className = `kb-tag-item ${state.currentAuthor === "__all__" ? "active" : ""}`;
  const totalNotes = state.tagCounts.__all__ || 0;
  allItem.innerHTML = `
    <span>👤 全部博主</span>
    <span class="tag-badge">${totalNotes}</span>
  `;
  allItem.addEventListener("click", () => switchAuthor("__all__", "全部博主"));
  tagListContainer.appendChild(allItem);

  state.authors.forEach((author) => {
    const item = document.createElement("div");
    item.className = `kb-tag-item ${state.currentAuthor === author.name ? "active" : ""}`;
    item.innerHTML = `
      <span>👤 ${author.name}</span>
      <span class="tag-badge">${author.count || 0}</span>
    `;
    item.addEventListener("click", () => switchAuthor(author.name, `博主: ${author.name}`));
    tagListContainer.appendChild(item);
  });

  if (state.unknownAuthorCount > 0) {
    const unkItem = document.createElement("div");
    unkItem.className = `kb-tag-item ${state.currentAuthor === "__unknown__" ? "active" : ""}`;
    unkItem.innerHTML = `
      <span>❓ 未识别博主</span>
      <span class="tag-badge">${state.unknownAuthorCount}</span>
    `;
    unkItem.addEventListener("click", () => switchAuthor("__unknown__", "未识别博主"));
    tagListContainer.appendChild(unkItem);
  }

  updateActiveFilterIndicator();
}

function setFilterMode(mode) {
  state.filterMode = mode;
  const btnTags = document.getElementById("btn-mode-tags");
  const btnAuthors = document.getElementById("btn-mode-authors");
  if (mode === "tags") {
    btnTags?.classList.add("active");
    btnAuthors?.classList.remove("active");
    renderTagsList();
  } else {
    btnAuthors?.classList.add("active");
    btnTags?.classList.remove("active");
    renderAuthorsList();
  }
  updateActiveFilterIndicator();
}

function updateActiveFilterIndicator() {
  const indicator = document.getElementById("kb-active-filter-indicator");
  const textEl = document.getElementById("kb-active-filter-text");
  if (!indicator || !textEl) return;

  const hasAuthorFilter = state.currentAuthor && state.currentAuthor !== "__all__";
  const hasTagFilter = state.currentCategory && state.currentCategory !== "__all__";

  if (state.filterMode === "authors" && hasTagFilter) {
    indicator.style.display = "inline-flex";
    textEl.textContent = `🏷️ 兼选分类: ${state.currentCategory === '__uncategorized__' ? '未分类' : state.currentCategory}`;
  } else if (state.filterMode === "tags" && hasAuthorFilter) {
    indicator.style.display = "inline-flex";
    textEl.textContent = `👤 兼选博主: ${state.currentAuthor === '__unknown__' ? '未识别博主' : state.currentAuthor}`;
  } else {
    indicator.style.display = "none";
  }
}

function switchCategory(category, label) {
  state.currentCategory = category;
  renderTagsList();
  const searchVal = document.getElementById("kb-search-input")?.value || "";
  loadNotes(searchVal);
}

function switchAuthor(author, label) {
  state.currentAuthor = author;
  renderAuthorsList();
  const searchVal = document.getElementById("kb-search-input")?.value || "";
  loadNotes(searchVal);
}

async function loadNotes(search = "") {
  const gridContainer = document.getElementById("kb-notes-grid");
  const emptyHint = document.getElementById("kb-empty-hint");
  if (!gridContainer) return;

  gridContainer.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 40px; color: var(--text-sub);">正在加载知识库笔记...</div>`;

  try {
    let url = `/api/notes?limit=100&q=${encodeURIComponent(search)}`;
    if (state.currentCategory && state.currentCategory !== "__all__") {
      url += `&tag=${encodeURIComponent(state.currentCategory)}`;
    }
    if (state.currentAuthor && state.currentAuthor !== "__all__") {
      url += `&author=${encodeURIComponent(state.currentAuthor)}`;
    }
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
            <span>${item.author_name ? `👤 ${item.author_name} · ` : ''}📅 ${formatTime(item.created_at)}</span>
            <div style="display: flex; align-items: center; gap: 8px;">
              ${item.hasAudioOrVideo ? `
                <label class="kb-shuffle-toggle ${item.inShuffle ? 'active' : ''}" title="勾选加入随身听随机播放库" onclick="event.stopPropagation();">
                  <input type="checkbox" class="kb-shuffle-checkbox" data-id="${item.id}" ${item.inShuffle ? "checked" : ""} />
                  <span>📻 随身听</span>
                </label>
              ` : ''}
              <span style="color: var(--primary); font-weight: 600;">查看详情 →</span>
            </div>
          </div>
        </div>
      `;

      // 随身听勾选交互绑定
      const chk = card.querySelector(".kb-shuffle-checkbox");
      if (chk) {
        chk.addEventListener("change", async (e) => {
          e.stopPropagation();
          const targetChecked = e.target.checked;
          const parentLabel = e.target.closest(".kb-shuffle-toggle");
          try {
            const res = await fetch(`/api/notes/${item.id}/shuffle`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
              body: JSON.stringify({ inShuffle: targetChecked })
            });
            if (res.ok) {
              item.inShuffle = targetChecked;
              if (parentLabel) {
                if (targetChecked) parentLabel.classList.add("active");
                else parentLabel.classList.remove("active");
              }
              showToast(targetChecked ? "📻 已加入随身听播放库" : "已从随身听播放库移除");
              ShufflePlayer.loadPlaylist();
            } else {
              throw new Error("更新失败");
            }
          } catch (err) {
            e.target.checked = !targetChecked;
            showToast(`操作失败: ${err.message}`);
          }
        });
      }

      card.addEventListener("click", () => openNoteDetail(item.id));
      gridContainer.appendChild(card);
    });

    // 检查并同步待提取字幕状态徽标
    BackgroundSubtitleQueue.checkAndResumePending(false);
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

    // 渲染博主账号与主页链接
    const modalAuthorBar = document.getElementById("modal-author-bar");
    const modalAuthorName = document.getElementById("modal-author-name");
    const modalAuthorLink = document.getElementById("modal-author-link");
    const modalAuthorLinkRow = document.getElementById("modal-author-link-row");
    const copyModalAuthorBtn = document.getElementById("btn-modal-copy-author-link");
    const filterByAuthorBtn = document.getElementById("btn-modal-filter-by-author");
    const refreshAuthorBtn = document.getElementById("btn-modal-refresh-author");

    const noteAuthorName = (note.authorName || note.user?.nickname || "").trim();
    const noteAuthorProfileUrl = (note.authorProfileUrl || note.user?.profileUrl || (note.authorId || note.user?.userId ? `https://www.xiaohongshu.com/user/profile/${note.authorId || note.user?.userId}` : "")).trim();

    if (modalAuthorBar) {
      modalAuthorBar.style.display = "flex";
      if (modalAuthorName) {
        modalAuthorName.textContent = noteAuthorName || "（未识别博主）";
      }

      if (modalAuthorLinkRow) {
        if (noteAuthorProfileUrl) {
          modalAuthorLinkRow.style.display = "flex";
          if (modalAuthorLink) {
            modalAuthorLink.href = noteAuthorProfileUrl;
            modalAuthorLink.textContent = noteAuthorProfileUrl;
          }
          if (copyModalAuthorBtn) {
            copyModalAuthorBtn.onclick = async () => {
              await navigator.clipboard.writeText(noteAuthorProfileUrl);
              showToast("已复制博主主页链接");
            };
          }
        } else {
          modalAuthorLinkRow.style.display = "none";
        }
      }

      // 🔍 查看TA的笔记 快捷按钮
      if (filterByAuthorBtn) {
        if (noteAuthorName) {
          filterByAuthorBtn.style.display = "inline-flex";
          filterByAuthorBtn.onclick = () => {
            closeNoteModal();
            setFilterMode("authors");
            switchAuthor(noteAuthorName, `博主: ${noteAuthorName}`);
          };
        } else {
          filterByAuthorBtn.style.display = "none";
        }
      }

      // 🔄 重新识别 / 补全博主 按钮
      if (refreshAuthorBtn) {
        refreshAuthorBtn.textContent = noteAuthorName ? "🔄 重新识别博主" : "🔄 补全博主信息";
        refreshAuthorBtn.onclick = async () => {
          if (!note.sourceUrl) {
            showToast("❌ 该笔记未记录原始采集链接，无法自动补全博主", { isError: true });
            return;
          }
          refreshAuthorBtn.disabled = true;
          refreshAuthorBtn.textContent = "⏳ 正在识别...";
          showToast("⏳ 正在从小红书重新获取博主信息...");
          try {
            const r = await fetch(`/api/notes/${encodeURIComponent(note.id)}/refresh-author`, {
              method: "POST",
              headers: { "x-auth-pin": state.pin }
            });
            const d = await r.json();
            if (d.success) {
              note.authorName = d.authorName;
              note.authorId = d.authorId;
              note.authorProfileUrl = d.authorProfileUrl;
              showToast(`✅ 成功获取博主信息：${d.authorName || '已补全'}`);
              openNoteDetail(note.id);
              loadAuthors();
              loadNotes();
            } else {
              showToast(`❌ 补全失败: ${d.message || "未能识别"}`, { isError: true });
            }
          } catch (e) {
            showToast(`❌ 请求异常: ${e.message}`, { isError: true });
          } finally {
            refreshAuthorBtn.disabled = false;
          }
        };
      }
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

    // 渲染视频、纯音频与语音文案置顶展示
    const vidWrap = document.getElementById("modal-video-wrap");
    const vidPlayer = document.getElementById("modal-video-player");
    const audioWrap = document.getElementById("modal-audio-player-wrap");
    const audioPlayer = document.getElementById("modal-audio-player");
    const audioStatusTag = document.getElementById("modal-audio-status-tag");
    const vidContainer = document.getElementById("modal-video-player-container");
    const mediaActions = document.getElementById("modal-media-actions");
    const mediaFreedBanner = document.getElementById("modal-media-freed-banner");
    const toggleAudioBtn = document.getElementById("btn-modal-toggle-audio");
    const transcribeBtn = document.getElementById("btn-modal-transcribe");
    const modalOcrBtn = document.getElementById("btn-modal-ocr-subtitles");
    const modalSlowOcrBtn = document.getElementById("btn-modal-slow-ocr");
    const modalDualBtn = document.getElementById("btn-modal-dual-extract");
    const downloadVideoBtn = document.getElementById("btn-modal-download-video");
    const cleanupMediaBtn = document.getElementById("btn-modal-cleanup-media");
    const transcriptPanel = document.getElementById("modal-transcript-panel");

    const hasVideo = Array.isArray(note.videos) && note.videos.length > 0 && Boolean(note.videos[0]?.url);
    const activeVideoUrl = hasVideo ? note.videos[0].url : "";
    const hasAudio = Boolean(note.audioUrl);
    const activeAudioUrl = hasAudio ? note.audioUrl : (hasVideo ? activeVideoUrl : "");
    const hasTranscript = Boolean(note.transcript && String(note.transcript).trim());

    // 随身听加入/移出交互绑定
    const toggleShuffleBtn = document.getElementById("btn-modal-toggle-shuffle");
    if (toggleShuffleBtn) {
      if (hasAudio || hasVideo) {
        toggleShuffleBtn.style.display = "inline-flex";
        const updateShuffleBtnUI = (inShuffle) => {
          if (inShuffle) {
            toggleShuffleBtn.classList.add("active");
            toggleShuffleBtn.innerHTML = "📻 已在随身听 (点击移出)";
            toggleShuffleBtn.style.borderColor = "var(--primary)";
            toggleShuffleBtn.style.color = "var(--primary)";
            toggleShuffleBtn.style.background = "var(--primary-light)";
          } else {
            toggleShuffleBtn.classList.remove("active");
            toggleShuffleBtn.innerHTML = "📻 加入随身听";
            toggleShuffleBtn.style.borderColor = "";
            toggleShuffleBtn.style.color = "";
            toggleShuffleBtn.style.background = "";
          }
        };
        updateShuffleBtnUI(Boolean(note.inShuffle));

        toggleShuffleBtn.onclick = async () => {
          const nextState = !Boolean(note.inShuffle);
          try {
            const res = await fetch(`/api/notes/${note.id}/shuffle`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
              body: JSON.stringify({ inShuffle: nextState })
            });
            if (res.ok) {
              note.inShuffle = nextState;
              updateShuffleBtnUI(nextState);
              showToast(nextState ? "📻 已加入随身听播放库" : "已从随身听播放库移出");
              loadNotes(document.getElementById("kb-search-input")?.value || "");
              ShufflePlayer.loadPlaylist();
            } else {
              throw new Error("更新失败");
            }
          } catch (err) {
            showToast(`操作失败: ${err.message}`);
          }
        };
      } else {
        toggleShuffleBtn.style.display = "none";
      }
    }

    if (hasVideo) {
      if (vidWrap) vidWrap.style.display = "block";
      if (vidContainer) vidContainer.style.display = "block";
      if (audioWrap) audioWrap.style.display = "none";
      if (audioStatusTag) audioStatusTag.style.display = "none";
      if (mediaActions) mediaActions.style.display = "flex";
      if (mediaFreedBanner) mediaFreedBanner.style.display = "none";

      if (activeVideoUrl) {
        OfflineMediaManager.getPlayableSource(activeVideoUrl, {
          noteId: note.id,
          title: note.title,
          coverUrl: note.cover_url,
          transcript: note.transcript,
          tags: note.tags
        }).then(({ src }) => {
          if (vidPlayer) vidPlayer.src = src;
        });
      }
      if (activeAudioUrl) {
        OfflineMediaManager.getPlayableSource(activeAudioUrl, {
          noteId: note.id,
          title: note.title,
          coverUrl: note.cover_url,
          transcript: note.transcript,
          tags: note.tags
        }).then(({ src }) => {
          if (audioPlayer) audioPlayer.src = src;
        });
      }

      if (downloadVideoBtn) downloadVideoBtn.style.display = "inline-flex";
      if (cleanupMediaBtn) cleanupMediaBtn.style.display = "inline-flex";

      if (toggleAudioBtn) {
        toggleAudioBtn.style.display = "inline-flex";
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
        transcribeBtn.style.display = "inline-flex";
        transcribeBtn.onclick = () => {
          extractVideoSubtitlesOrAudio(activeVideoUrl, "#modal-transcript-panel", note.id, vidPlayer);
        };
      }
      if (modalOcrBtn) {
        modalOcrBtn.style.display = "inline-flex";
        modalOcrBtn.onclick = () => {
          extractVideoHardSubtitles(activeVideoUrl, "#modal-transcript-panel", note.id, { fallbackToSpeech: true });
        };
      }
      if (modalSlowOcrBtn) {
        modalSlowOcrBtn.style.display = "inline-flex";
        modalSlowOcrBtn.onclick = () => {
          extractVideoHardSubtitles(activeVideoUrl, "#modal-transcript-panel", note.id, {
            isSlowMode: true,
            stepSec: 1.6,
            batchDelayMs: 2500,
            fallbackToSpeech: true
          });
        };
      }
      if (modalDualBtn) {
        modalDualBtn.style.display = "inline-flex";
        modalDualBtn.onclick = () => {
          runDualSubtitleExtraction(activeVideoUrl, "#modal-transcript-panel", note.id);
        };
      }
    } else if (hasAudio) {
      // 视频已清理，但纯音频保留
      if (vidWrap) vidWrap.style.display = "block";
      if (vidContainer) vidContainer.style.display = "none";
      vidPlayer?.removeAttribute("src");
      if (audioWrap) audioWrap.style.display = "block";
      if (audioStatusTag) audioStatusTag.style.display = "inline-block";
      if (mediaActions) mediaActions.style.display = "flex";
      if (mediaFreedBanner) mediaFreedBanner.style.display = "none";

      if (activeAudioUrl) {
        OfflineMediaManager.getPlayableSource(activeAudioUrl, {
          noteId: note.id,
          title: note.title,
          coverUrl: note.cover_url,
          transcript: note.transcript,
          tags: note.tags
        }).then(({ src }) => {
          if (audioPlayer) audioPlayer.src = src;
        });
      }

      if (downloadVideoBtn) downloadVideoBtn.style.display = "none";
      if (toggleAudioBtn) toggleAudioBtn.style.display = "none";
      if (cleanupMediaBtn) cleanupMediaBtn.style.display = "inline-flex";
      if (modalOcrBtn) modalOcrBtn.style.display = "none";
      if (modalSlowOcrBtn) modalSlowOcrBtn.style.display = "none";
      if (modalDualBtn) modalDualBtn.style.display = "none";

      if (transcribeBtn) {
        transcribeBtn.style.display = "inline-flex";
        transcribeBtn.onclick = () => {
          transcribeAudio(activeAudioUrl, "#modal-transcript-panel", note.id);
        };
      }
    } else if (hasTranscript) {
      // 视频与音频均已删除，但提取的语音文案完整保留
      if (modalOcrBtn) modalOcrBtn.style.display = "none";
      if (modalSlowOcrBtn) modalSlowOcrBtn.style.display = "none";
      if (modalDualBtn) modalDualBtn.style.display = "none";
      if (vidWrap) vidWrap.style.display = "block";
      if (vidContainer) vidContainer.style.display = "none";
      if (audioWrap) audioWrap.style.display = "none";
      if (mediaActions) mediaActions.style.display = "none";
      if (mediaFreedBanner) mediaFreedBanner.style.display = "block";
      vidPlayer?.removeAttribute("src");
      audioPlayer?.removeAttribute("src");
    } else {
      // 普通图文笔记或无任何媒体
      if (modalOcrBtn) modalOcrBtn.style.display = "none";
      if (modalSlowOcrBtn) modalSlowOcrBtn.style.display = "none";
      if (modalDualBtn) modalDualBtn.style.display = "none";
      if (vidWrap) vidWrap.style.display = "none";
      vidPlayer?.removeAttribute("src");
      audioPlayer?.removeAttribute("src");
    }

    // 只要有提取过的语音文案，一律置顶稳定呈现；若提取失败或设为手工提取，展示模式状态与操作入口
    if (hasTranscript) {
      renderTranscriptBox(transcriptPanel, note.transcript, note.id);
    } else if (transcriptPanel) {
      const isManual = note.extractionStatus === "manual";
      if (note.extractionFailCount > 0 || isManual) {
        const errList = Array.isArray(note.extractionErrorLog) ? note.extractionErrorLog : [];
        const durSec = Math.round((note.extractionDurationMs || 0) / 1000);
        transcriptPanel.style.display = "block";
        transcriptPanel.innerHTML = `
          <div class="modal-extraction-failure-alert" style="${isManual ? 'background: rgba(254, 243, 199, 0.85); border-color: #fde68a;' : ''}">
            <div class="modal-failure-header">
              <span class="modal-failure-title" style="${isManual ? 'color: #92400e;' : ''}">
                ${isManual 
                  ? '🖐️ 当前处于手工提取模式（后台接力已跳过此篇）' 
                  : `⚠️ 字幕与文案尝试提取未成功 (${note.extractionFailCount}次${durSec > 0 ? ` · 用时 ${durSec}s` : ""})`}
              </span>
              <div style="display: inline-flex; align-items: center; gap: 8px;">
                ${isManual ? `
                  <button type="button" class="btn btn-ghost btn-sm btn-modal-switch-auto" title="恢复自动多端断点接力后台提取">🔄 恢复自动</button>
                ` : `
                  <button type="button" class="btn btn-warning btn-sm btn-modal-switch-manual" title="转入手工提取模式，避免后台接力反复重试">🖐️ 切换成手工提取</button>
                `}
                <button type="button" class="btn btn-primary btn-sm btn-modal-retry-extract">🔄 重新提取</button>
              </div>
            </div>
            <div class="modal-failure-body" style="${isManual ? 'color: #78350f;' : ''}">
              ${isManual 
                ? `<strong>提示：</strong>可在上方点击<strong>「⚖️ 双模对比提取」</strong>或<strong>「🎙️ 提取字幕与文案」</strong>进行精准提取。${note.extractionLastError ? `<div style="margin-top: 4px; font-size: 11.5px; color: #b45309;">上次失败原因：${escapeHtml(note.extractionLastError)}</div>` : ''}`
                : `<strong>失败原因：</strong>${escapeHtml(note.extractionLastError || "未知提取异常")}`}
            </div>
            ${errList.length > 1 ? `
              <div class="task-failure-history" style="margin-top: 6px;">
                <div style="font-size: 11px; font-weight: 700; color: #991b1b; margin-bottom: 2px;">📋 历次失败记录：</div>
                ${errList.map((log, idx) => `
                  <div class="failure-history-item">
                    <div class="failure-history-meta">
                      <span class="fail-idx">第 ${log.attempt || (errList.length - idx)} 次</span>
                      <span class="fail-duration">⏱️ 用时 ${log.durationSec || Math.round((log.durationMs || 0)/1000)}s</span>
                      <span class="fail-time">${log.time ? formatTime(log.time) : ""}</span>
                    </div>
                    <div class="fail-reason">${escapeHtml(log.error || "未记录异常")}</div>
                  </div>
                `).join('')}
              </div>
            ` : ""}
          </div>
        `;

        transcriptPanel.querySelector(".btn-modal-switch-manual")?.addEventListener("click", async () => {
          try {
            showToast("⏳ 正在切换为手工提取模式...");
            await fetch(`/api/notes/${note.id}/extraction-mode`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
              body: JSON.stringify({ mode: "manual" })
            });
            BackgroundSubtitleQueue.removeFromQueue(note.id);
            showToast("🖐️ 已切换为手工提取模式，后台接力将不再反复重试！");
            openNoteDetail(note.id);
            ExtractionDashboardManager.refresh();
            setTimeout(() => {
              const dualBtn = document.getElementById("btn-modal-dual-extract") || document.getElementById("btn-modal-transcribe");
              if (dualBtn) {
                dualBtn.scrollIntoView({ behavior: "smooth", block: "center" });
                dualBtn.classList.add("pulse-highlight");
                setTimeout(() => dualBtn.classList.remove("pulse-highlight"), 3500);
              }
            }, 300);
          } catch (err) {
            showToast(`操作失败: ${err.message}`);
          }
        });

        transcriptPanel.querySelector(".btn-modal-switch-auto")?.addEventListener("click", async () => {
          try {
            showToast("⏳ 正在恢复自动后台接力...");
            await fetch(`/api/notes/${note.id}/extraction-mode`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
              body: JSON.stringify({ mode: "auto" })
            });
            BackgroundSubtitleQueue.failedNoteIds.delete(note.id);
            BackgroundSubtitleQueue.enqueue({
              id: note.id,
              title: note.title,
              coverUrl: note.cover_url,
              videos: note.videos || []
            });
            showToast("🔄 已恢复自动后台接力提取！");
            openNoteDetail(note.id);
            ExtractionDashboardManager.refresh();
          } catch (err) {
            showToast(`操作失败: ${err.message}`);
          }
        });

        transcriptPanel.querySelector(".btn-modal-retry-extract")?.addEventListener("click", () => {
          if (modalSlowOcrBtn) modalSlowOcrBtn.click();
        });
      } else {
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

// ========================================================
// 📻 随身听随机播客电台播放引擎 (ShufflePlayer)
// 支持断网离线畅听、0 延迟进度条拖拽快进快退、随机/循环/单曲模式
// ========================================================
export const ShufflePlayer = {
  playlist: [],
  currentIndex: -1,
  mode: localStorage.getItem("shuffle_play_mode") || "order", // "order" | "loop" | "shuffle" | "single"
  playbackRate: 1.0,
  audioEl: null,
  isScrubbing: false,
  cachedUrls: new Set(),
  _dragSourceIndex: null,
  _touchDragSourceIndex: null,
  _touchOverIndex: null,
  _touchIsBottom: false,

  init() {
    this.audioEl = document.getElementById("shuffle-audio-element");
    if (!this.audioEl) return;

    this.updateModeBtnUI();

    // 播放/暂停
    const playPauseBtn = document.getElementById("btn-shuffle-play-pause");
    playPauseBtn?.addEventListener("click", () => this.togglePlay());

    // 上一首 / 下一首
    document.getElementById("btn-shuffle-prev-track")?.addEventListener("click", () => this.playPrev());
    document.getElementById("btn-shuffle-next-track")?.addEventListener("click", () => this.playNext());

    // 播放模式切换 (顺序播放 / 列表循环 / 随机播放 / 单曲循环)
    const modeBtn = document.getElementById("btn-shuffle-mode-toggle");
    modeBtn?.addEventListener("click", () => {
      if (this.mode === "order") {
        this.mode = "loop";
        showToast("已切换为：列表循环");
      } else if (this.mode === "loop") {
        this.mode = "shuffle";
        showToast("已切换为：随机播放");
      } else if (this.mode === "shuffle") {
        this.mode = "single";
        showToast("已切换为：单曲循环");
      } else {
        this.mode = "order";
        showToast("已切换为：顺序播放");
      }
      localStorage.setItem("shuffle_play_mode", this.mode);
      this.updateModeBtnUI();
    });

    // 倍速切换 (1.0x -> 1.25x -> 1.5x -> 2.0x -> 0.75x)
    const speedBtn = document.getElementById("btn-shuffle-speed-toggle");
    const speeds = [1.0, 1.25, 1.5, 2.0, 0.75];
    speedBtn?.addEventListener("click", () => {
      const idx = speeds.indexOf(this.playbackRate);
      const nextIdx = (idx + 1) % speeds.length;
      this.playbackRate = speeds[nextIdx];
      if (this.audioEl) this.audioEl.playbackRate = this.playbackRate;
      speedBtn.textContent = `${this.playbackRate}x`;
      showToast(`播放倍速：${this.playbackRate}x`);
    });

    // 进度条拖拽绑定 (完美支持拖拽快进快退，无卡顿跳转)
    const slider = document.getElementById("shuffle-scrub-slider");
    const curTimeEl = document.getElementById("shuffle-time-current");
    const durTimeEl = document.getElementById("shuffle-time-duration");

    slider?.addEventListener("input", (e) => {
      this.isScrubbing = true;
      if (this.audioEl && this.audioEl.duration) {
        const targetTime = (parseFloat(e.target.value) / 100) * this.audioEl.duration;
        if (curTimeEl) curTimeEl.textContent = this.formatTimeSec(targetTime);
      }
    });

    slider?.addEventListener("change", (e) => {
      if (this.audioEl && this.audioEl.duration) {
        const targetTime = (parseFloat(e.target.value) / 100) * this.audioEl.duration;
        this.audioEl.currentTime = targetTime;
      }
      this.isScrubbing = false;
    });

    // 音频核心事件监听
    this.audioEl.addEventListener("timeupdate", () => {
      if (this.isScrubbing) return;
      if (!this.audioEl.duration) return;
      const cur = this.audioEl.currentTime;
      const dur = this.audioEl.duration;
      if (curTimeEl) curTimeEl.textContent = this.formatTimeSec(cur);
      if (durTimeEl) durTimeEl.textContent = this.formatTimeSec(dur);
      if (slider) slider.value = ((cur / dur) * 100).toFixed(1);
    });

    this.audioEl.addEventListener("loadedmetadata", () => {
      if (durTimeEl && this.audioEl.duration) {
        durTimeEl.textContent = this.formatTimeSec(this.audioEl.duration);
      }
    });

    this.audioEl.addEventListener("play", () => {
      this.updatePlayStateUI(true);
    });

    this.audioEl.addEventListener("pause", () => {
      this.updatePlayStateUI(false);
    });

    this.audioEl.addEventListener("ended", () => {
      if (this.mode === "single") {
        this.audioEl.currentTime = 0;
        this.audioEl.play().catch(() => {});
      } else if (this.mode === "order") {
        if (this.currentIndex < this.playlist.length - 1) {
          this.playNext();
        } else {
          this.stop();
          showToast("已播放完列表全部音频");
        }
      } else {
        this.playNext();
      }
    });

    this.audioEl.addEventListener("error", (e) => {
      console.warn("Shuffle audio error:", e);
      this.updatePlayStateUI(false);
    });

    // 顶部操作栏事件
    document.getElementById("btn-shuffle-reload")?.addEventListener("click", () => {
      this.loadPlaylist(true);
    });

    document.getElementById("btn-shuffle-cache-all")?.addEventListener("click", () => {
      this.cacheAllTracks();
    });

    document.getElementById("btn-shuffle-clear-all")?.addEventListener("click", async () => {
      if (this.playlist.length === 0) return;
      if (!confirm("确定要清空随身听播放库中的所有音频吗？（笔记和文案仍然会保留）")) return;
      showToast("正在清空播放库...");
      try {
        await Promise.all(
          this.playlist.map((track) =>
            fetch(`/api/notes/${track.id}/shuffle`, {
              method: "PUT",
              headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
              body: JSON.stringify({ inShuffle: false })
            })
          )
        );
        this.stop();
        this.playlist = [];
        this.saveCustomOrder();
        await this.loadPlaylist();
        showToast("已清空随身听播放库");
        loadNotes(document.getElementById("kb-search-input")?.value || "");
      } catch (err) {
        showToast(`清空失败: ${err.message}`);
      }
    });
  },

  updateModeBtnUI() {
    const modeBtn = document.getElementById("btn-shuffle-mode-toggle");
    if (!modeBtn) return;
    if (this.mode === "order") {
      modeBtn.innerHTML = "➡️ 顺序";
      modeBtn.title = "顺序播放模式 (播完列表停止)";
    } else if (this.mode === "loop") {
      modeBtn.innerHTML = "🔁 循环";
      modeBtn.title = "列表循环模式";
    } else if (this.mode === "shuffle") {
      modeBtn.innerHTML = "🔀 随机";
      modeBtn.title = "随机播放模式";
    } else if (this.mode === "single") {
      modeBtn.innerHTML = "🔂 单曲";
      modeBtn.title = "单曲循环模式";
    }
  },

  getSavedCustomOrder() {
    try {
      const raw = localStorage.getItem("shuffle_playlist_order");
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  },

  saveCustomOrder() {
    try {
      const ids = this.playlist.map((t) => t.id);
      localStorage.setItem("shuffle_playlist_order", JSON.stringify(ids));
    } catch (e) {
      console.warn("Failed to save shuffle order:", e);
    }
  },

  applyCustomOrder(items) {
    if (!Array.isArray(items) || items.length === 0) return items;
    const savedIds = this.getSavedCustomOrder();
    if (!Array.isArray(savedIds) || savedIds.length === 0) return items;

    const idMap = new Map();
    items.forEach((item) => idMap.set(String(item.id), item));

    const ordered = [];
    savedIds.forEach((id) => {
      const strId = String(id);
      if (idMap.has(strId)) {
        ordered.push(idMap.get(strId));
        idMap.delete(strId);
      }
    });

    // 未在缓存序列中的新增音频，追加到末尾
    idMap.forEach((item) => ordered.push(item));
    return ordered;
  },

  calculateInsertIndex(fromIdx, overIdx, isBottomHalf) {
    if (isBottomHalf) {
      return fromIdx <= overIdx ? overIdx : overIdx + 1;
    } else {
      return fromIdx < overIdx ? overIdx - 1 : overIdx;
    }
  },

  clearDragIndicators() {
    const cards = document.querySelectorAll(".shuffle-item-card");
    cards.forEach((c) => c.classList.remove("drag-over-top", "drag-over-bottom"));
  },

  reorderTracks(fromIndex, toIndex) {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= this.playlist.length ||
      toIndex >= this.playlist.length
    ) {
      return;
    }

    const currentTrackId =
      this.currentIndex >= 0 && this.playlist[this.currentIndex]
        ? this.playlist[this.currentIndex].id
        : null;

    const [movedTrack] = this.playlist.splice(fromIndex, 1);
    this.playlist.splice(toIndex, 0, movedTrack);

    if (currentTrackId) {
      this.currentIndex = this.playlist.findIndex((t) => t.id === currentTrackId);
    }

    this.saveCustomOrder();
    this.renderPlaylist();
    showToast(`已调整播放顺序至 #${toIndex + 1}`);
  },

  formatTimeSec(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  },

  updatePlayStateUI(isPlaying) {
    const icon = document.getElementById("shuffle-play-icon");
    const coverWrap = document.getElementById("shuffle-cover-wrap");
    if (icon) icon.textContent = isPlaying ? "⏸️" : "▶️";
    if (coverWrap) {
      if (isPlaying) coverWrap.classList.add("playing");
      else coverWrap.classList.remove("playing");
    }
  },

  async loadPlaylist(showNotify = false) {
    try {
      this.cachedUrls = await OfflineMediaManager.getAllCachedUrls();

      let items = [];
      try {
        const res = await fetch("/api/shuffle-notes", {
          headers: { "x-auth-pin": state.pin }
        });
        if (res.ok) {
          const data = await res.json();
          items = data.items || [];
        } else {
          throw new Error("HTTP error");
        }
      } catch (networkErr) {
        console.warn("Failed to fetch shuffle notes online, loading from local offline cache:", networkErr);
        items = await OfflineMediaManager.getAllCachedTracks();
      }

      // 应用自定义排序
      this.playlist = this.applyCustomOrder(items);
      this.updateBadgeCounts();
      this.renderPlaylist();

      if (showNotify) {
        showToast(`已同步随身听播放库，共 ${this.playlist.length} 首音频`);
      }

      // 如果当前没有正在播放的音频且列表不为空，预载第一首
      if (this.playlist.length > 0 && this.currentIndex === -1) {
        this.prepareTrack(0, false);
      }
    } catch (err) {
      console.error("loadPlaylist error:", err);
    }
  },

  updateBadgeCounts() {
    const total = this.playlist.length;
    let cachedCount = 0;
    this.playlist.forEach((track) => {
      if (this.cachedUrls.has(track.mediaUrl)) cachedCount++;
    });

    const badge = document.getElementById("shuffle-badge");
    const listBadge = document.getElementById("shuffle-list-badge");
    const totalCountEl = document.getElementById("shuffle-total-count");
    const cachedCountEl = document.getElementById("shuffle-cached-count");

    if (badge) {
      badge.textContent = total;
      badge.style.display = total > 0 ? "inline-block" : "none";
    }
    if (listBadge) listBadge.textContent = total;
    if (totalCountEl) totalCountEl.textContent = total;
    if (cachedCountEl) cachedCountEl.textContent = cachedCount;

    const cacheAllBtn = document.getElementById("btn-shuffle-cache-all");
    if (cacheAllBtn) {
      if (total > 0 && cachedCount >= total) {
        cacheAllBtn.innerHTML = `✅ 已全部离线 (${cachedCount}/${total})`;
        cacheAllBtn.disabled = true;
      } else {
        cacheAllBtn.innerHTML = `📥 一键离线缓存 (<span id="shuffle-cached-count">${cachedCount}</span>/<span id="shuffle-total-count">${total}</span>)`;
        cacheAllBtn.disabled = total === 0;
      }
    }
  },

  renderPlaylist() {
    const listWrap = document.getElementById("shuffle-playlist-wrap");
    const emptyGuide = document.getElementById("shuffle-empty-guide");
    if (!listWrap) return;

    if (this.playlist.length === 0) {
      listWrap.innerHTML = "";
      if (emptyGuide) emptyGuide.style.display = "block";
      this.renderCurrentTrackInfo(null);
      return;
    }

    if (emptyGuide) emptyGuide.style.display = "none";
    listWrap.innerHTML = "";

    let isDraggingDesktop = false;

    this.playlist.forEach((track, index) => {
      const isCached = this.cachedUrls.has(track.mediaUrl);
      const isActive = index === this.currentIndex;

      const card = document.createElement("div");
      card.className = `shuffle-item-card ${isActive ? "active" : ""}`;
      card.dataset.index = index;
      card.setAttribute("draggable", "true");

      const tagsHtml = (track.tags || []).slice(0, 2).map((t) => `<span class="kb-chip-small">${t}</span>`).join("");

      card.innerHTML = `
        <div class="shuffle-drag-handle" title="按住拖拽调整顺序" data-index="${index}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="8" cy="5" r="2"/>
            <circle cx="16" cy="5" r="2"/>
            <circle cx="8" cy="12" r="2"/>
            <circle cx="16" cy="12" r="2"/>
            <circle cx="8" cy="19" r="2"/>
            <circle cx="16" cy="19" r="2"/>
          </svg>
        </div>
        <span class="shuffle-item-index">#${index + 1}</span>
        <img src="${track.coverUrl || '/favicon.svg'}" class="shuffle-item-cover" alt="封面" loading="lazy" style="cursor: pointer;" title="点击查看笔记详情与文案" />
        <div class="shuffle-item-content">
          <div class="shuffle-item-title clickable" title="点击查看笔记详情与文案">${escapeHtml(track.title || "无标题音频")}</div>
          <div class="shuffle-item-meta">
            ${isCached ? '<span class="shuffle-item-cached-pill">💾 已离线</span>' : '<span style="color:#94a3b8;">☁️ 在线</span>'}
            ${tagsHtml}
          </div>
        </div>
        <div class="shuffle-item-actions">
          <button class="btn-item-remove-shuffle" title="从播放库移出" type="button">✕</button>
        </div>
      `;

      // 桌面鼠标拖拽排序 (HTML5 Drag & Drop)
      card.addEventListener("dragstart", (e) => {
        isDraggingDesktop = true;
        this._dragSourceIndex = index;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
        card.classList.add("dragging");
      });

      card.addEventListener("dragend", () => {
        card.classList.remove("dragging");
        this.clearDragIndicators();
        setTimeout(() => {
          isDraggingDesktop = false;
        }, 50);
      });

      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = card.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        card.classList.remove("drag-over-top", "drag-over-bottom");
        if (e.clientY < midY) {
          card.classList.add("drag-over-top");
        } else {
          card.classList.add("drag-over-bottom");
        }
      });

      card.addEventListener("dragleave", (e) => {
        if (!card.contains(e.relatedTarget)) {
          card.classList.remove("drag-over-top", "drag-over-bottom");
        }
      });

      card.addEventListener("drop", (e) => {
        e.preventDefault();
        card.classList.remove("drag-over-top", "drag-over-bottom");
        const fromIdx =
          this._dragSourceIndex !== null && this._dragSourceIndex !== undefined
            ? this._dragSourceIndex
            : parseInt(e.dataTransfer.getData("text/plain"), 10);
        if (isNaN(fromIdx) || fromIdx === index) return;

        const rect = card.getBoundingClientRect();
        const isBottom = e.clientY >= rect.top + rect.height / 2;
        const toIdx = this.calculateInsertIndex(fromIdx, index, isBottom);
        if (toIdx !== fromIdx) {
          this.reorderTracks(fromIdx, toIdx);
        }
      });

      // 手机触摸手柄拖拽排序 (Touch Events)
      const handle = card.querySelector(".shuffle-drag-handle");
      handle?.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length !== 1) return;
          this._touchDragSourceIndex = index;
          this._touchOverIndex = null;
          this._touchIsBottom = false;
          card.classList.add("touch-dragging");
        },
        { passive: true }
      );

      handle?.addEventListener(
        "touchmove",
        (e) => {
          if (this._touchDragSourceIndex === null || this._touchDragSourceIndex === undefined) return;
          if (e.cancelable) e.preventDefault();

          const touch = e.touches[0];
          const elem = document.elementFromPoint(touch.clientX, touch.clientY);
          const targetCard = elem?.closest(".shuffle-item-card");

          this.clearDragIndicators();

          if (targetCard && targetCard !== card && targetCard.dataset.index !== undefined) {
            const targetIdx = parseInt(targetCard.dataset.index, 10);
            const rect = targetCard.getBoundingClientRect();
            const isBottom = touch.clientY >= rect.top + rect.height / 2;
            if (isBottom) {
              targetCard.classList.add("drag-over-bottom");
            } else {
              targetCard.classList.add("drag-over-top");
            }
            this._touchOverIndex = targetIdx;
            this._touchIsBottom = isBottom;
          } else {
            this._touchOverIndex = null;
          }
        },
        { passive: false }
      );

      const handleTouchEnd = () => {
        if (this._touchDragSourceIndex === null || this._touchDragSourceIndex === undefined) return;
        card.classList.remove("touch-dragging");
        this.clearDragIndicators();

        if (this._touchOverIndex !== null && this._touchOverIndex !== undefined) {
          const fromIdx = this._touchDragSourceIndex;
          const toIdx = this.calculateInsertIndex(fromIdx, this._touchOverIndex, this._touchIsBottom);
          if (toIdx !== fromIdx) {
            this.reorderTracks(fromIdx, toIdx);
          }
        }

        this._touchDragSourceIndex = null;
        this._touchOverIndex = null;
      };

      handle?.addEventListener("touchend", handleTouchEnd);
      handle?.addEventListener("touchcancel", handleTouchEnd);

      // 点击标题或封面直接查看该笔记详情与完整提取文案
      card.querySelector(".shuffle-item-title")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof openNoteDetail === "function" && track.id) {
          openNoteDetail(track.id);
        }
      });

      card.querySelector(".shuffle-item-cover")?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (typeof openNoteDetail === "function" && track.id) {
          openNoteDetail(track.id);
        }
      });

      // 点击播放 (拖拽手柄及删除按钮不触发切歌)
      card.addEventListener("click", (e) => {
        if (isDraggingDesktop) return;
        if (e.target.closest(".btn-item-remove-shuffle")) return;
        if (e.target.closest(".shuffle-drag-handle")) return;
        this.playIndex(index);
      });

      card.querySelector(".btn-item-remove-shuffle")?.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.removeTrackFromShuffle(track.id, index);
      });

      listWrap.appendChild(card);
    });
  },

  async removeTrackFromShuffle(noteId, index) {
    try {
      const res = await fetch(`/api/notes/${noteId}/shuffle`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-auth-pin": state.pin },
        body: JSON.stringify({ inShuffle: false })
      });
      if (res.ok) {
        showToast("已从随身听播放库移出");
        const wasActive = index === this.currentIndex;
        this.playlist.splice(index, 1);
        this.saveCustomOrder();
        if (wasActive) {
          if (this.playlist.length > 0) {
            this.currentIndex = Math.min(index, this.playlist.length - 1);
            this.prepareTrack(this.currentIndex, true);
          } else {
            this.stop();
          }
        } else if (index < this.currentIndex) {
          this.currentIndex--;
        }
        this.updateBadgeCounts();
        this.renderPlaylist();
        loadNotes(document.getElementById("kb-search-input")?.value || "");
      }
    } catch (err) {
      showToast(`移出失败: ${err.message}`);
    }
  },

  async cacheAllTracks() {
    if (this.playlist.length === 0) return;
    const btn = document.getElementById("btn-shuffle-cache-all");
    if (btn) btn.disabled = true;
    showToast("正在缓存全部音频至本地存储，以便断网畅听...");

    let cachedCount = 0;
    for (let i = 0; i < this.playlist.length; i++) {
      const track = this.playlist[i];
      if (track.mediaUrl) {
        try {
          await OfflineMediaManager.cacheUrl(track.mediaUrl, {
            noteId: track.id,
            title: track.title,
            coverUrl: track.coverUrl,
            transcript: track.transcript,
            tags: track.tags
          });
          this.cachedUrls.add(track.mediaUrl);
          cachedCount++;
          const curCached = document.getElementById("shuffle-cached-count");
          if (curCached) curCached.textContent = cachedCount;
        } catch (e) {
          console.warn("Failed caching:", track.title, e);
        }
      }
    }

    this.updateBadgeCounts();
    this.renderPlaylist();
    showToast(`🎉 离线缓存完毕！即使完全断网无信号也可自由拖拽播放`);
  },

  async prepareTrack(index, autoPlay = true) {
    if (index < 0 || index >= this.playlist.length) return;
    this.currentIndex = index;
    const track = this.playlist[index];

    this.renderCurrentTrackInfo(track);
    this.highlightActiveCard(index);

    if (!this.audioEl) return;

    // 获取离线 Blob 或流式 URL (支持 0 延迟拖拽快进快退与断网畅听)
    const { src, isOffline } = await OfflineMediaManager.getPlayableSource(track.mediaUrl, {
      noteId: track.id,
      title: track.title,
      coverUrl: track.coverUrl,
      transcript: track.transcript,
      tags: track.tags
    });

    this.audioEl.src = src;
    this.audioEl.playbackRate = this.playbackRate;

    const pill = document.getElementById("shuffle-offline-pill");
    if (pill) {
      if (isOffline) {
        pill.className = "shuffle-offline-pill offline";
        pill.textContent = "📥 本地离线播放 (0延迟秒切)";
      } else {
        pill.className = "shuffle-offline-pill online";
        pill.textContent = "☁️ 云端流式播放 (支持断点拖拽)";
      }
    }

    if (autoPlay) {
      this.audioEl.play().catch((err) => {
        console.warn("Audio auto-play blocked or failed:", err);
      });
    }
  },

  renderCurrentTrackInfo(track) {
    const titleEl = document.getElementById("shuffle-track-title");
    const coverEl = document.getElementById("shuffle-cover-img");
    const coverWrap = document.getElementById("shuffle-cover-wrap");
    const tagsEl = document.getElementById("shuffle-track-tags");
    const lyricsEl = document.getElementById("shuffle-lyrics-content");

    if (!track) {
      if (titleEl) {
        titleEl.textContent = "暂无播放音频";
        titleEl.classList.remove("clickable");
        titleEl.onclick = null;
      }
      if (coverWrap) {
        coverWrap.classList.remove("clickable");
        coverWrap.onclick = null;
      }
      if (coverEl) coverEl.src = "/favicon.svg";
      if (tagsEl) tagsEl.innerHTML = "";
      if (lyricsEl) {
        lyricsEl.innerHTML = `<div class="shuffle-lyrics-empty">在「📚 收藏知识库」勾选音频进入播放库后即可在此畅听并同步展现精读文案。</div>`;
      }
      return;
    }

    if (titleEl) {
      titleEl.textContent = track.title || "无标题音频";
      titleEl.classList.add("clickable");
      titleEl.title = "点击查看该笔记详情与文案";
      titleEl.onclick = () => {
        if (typeof openNoteDetail === "function" && track.id) {
          openNoteDetail(track.id);
        }
      };
    }

    if (coverWrap) {
      coverWrap.classList.add("clickable");
      coverWrap.title = "点击查看该笔记详情与文案";
      coverWrap.onclick = () => {
        if (typeof openNoteDetail === "function" && track.id) {
          openNoteDetail(track.id);
        }
      };
    }

    if (coverEl) coverEl.src = track.coverUrl || "/favicon.svg";

    if (tagsEl) {
      tagsEl.innerHTML = (track.tags || []).map((t) => `<span class="kb-chip-small">${t}</span>`).join("");
    }

    // 渲染文案 (逐句分段展示，高亮重点)
    if (lyricsEl) {
      const transcript = track.transcript || "";
      if (!transcript.trim()) {
        lyricsEl.innerHTML = `<div class="shuffle-lyrics-empty">本篇音频暂未提取文案。可在知识库中点击「🎙️ 提取语音文案」生成！</div>`;
      } else {
        // 解析句子与划词高亮
        const lines = transcript
          .split(/[\r\n]+/)
          .map((l) => l.trim())
          .filter(Boolean);

        let html = "";
        lines.forEach((line) => {
          const isHighlight = line.includes("<mark") || line.includes("font-weight: 700");
          html += `<div class="shuffle-lyrics-line ${isHighlight ? "highlight" : ""}">${line}</div>`;
        });
        lyricsEl.innerHTML = html;
      }
    }
  },

  highlightActiveCard(index) {
    const cards = document.querySelectorAll(".shuffle-item-card");
    cards.forEach((card, idx) => {
      if (idx === index) card.classList.add("active");
      else card.classList.remove("active");
    });
  },

  playIndex(index) {
    this.prepareTrack(index, true);
  },

  togglePlay() {
    if (!this.audioEl) return;
    if (this.playlist.length === 0) {
      showToast("随身听播放库暂无音频，请先在知识库中勾选！");
      return;
    }
    if (this.currentIndex === -1) {
      this.prepareTrack(0, true);
      return;
    }
    if (this.audioEl.paused) {
      this.audioEl.play().catch(() => {});
    } else {
      this.audioEl.pause();
    }
  },

  playNext() {
    if (this.playlist.length <= 1) {
      if (this.playlist.length === 1 && this.audioEl) {
        this.audioEl.currentTime = 0;
        this.audioEl.play().catch(() => {});
      }
      return;
    }

    let nextIndex;
    if (this.mode === "shuffle") {
      // 随机选取不同的曲目
      do {
        nextIndex = Math.floor(Math.random() * this.playlist.length);
      } while (nextIndex === this.currentIndex && this.playlist.length > 1);
    } else if (this.mode === "order") {
      // 顺序播放：到达末尾时停止并提示
      if (this.currentIndex >= this.playlist.length - 1) {
        showToast("已是列表最后一首");
        return;
      }
      nextIndex = this.currentIndex + 1;
    } else {
      // 列表循环模式 (loop) 或其他
      nextIndex = (this.currentIndex + 1) % this.playlist.length;
    }

    this.playIndex(nextIndex);
  },

  playPrev() {
    if (this.playlist.length <= 1) {
      if (this.playlist.length === 1 && this.audioEl) {
        this.audioEl.currentTime = 0;
        this.audioEl.play().catch(() => {});
      }
      return;
    }

    let prevIndex;
    if (this.mode === "shuffle") {
      do {
        prevIndex = Math.floor(Math.random() * this.playlist.length);
      } while (prevIndex === this.currentIndex && this.playlist.length > 1);
    } else if (this.mode === "order") {
      // 顺序播放：到达第一首时回退到开头并提示
      if (this.currentIndex <= 0) {
        if (this.audioEl) this.audioEl.currentTime = 0;
        showToast("已是列表第一首");
        return;
      }
      prevIndex = this.currentIndex - 1;
    } else {
      // 列表循环模式
      prevIndex = (this.currentIndex - 1 + this.playlist.length) % this.playlist.length;
    }

    this.playIndex(prevIndex);
  },

  stop() {
    if (this.audioEl) {
      this.audioEl.pause();
      this.audioEl.currentTime = 0;
      this.audioEl.removeAttribute("src");
    }
    this.currentIndex = -1;
    this.updatePlayStateUI(false);
    this.renderCurrentTrackInfo(null);
  }
};

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

  // 页面顶级标签页切换管理 (采集下载工具 vs 收藏知识库 vs 随身听电台)
  function switchPageTab(tabName) {
    const downloadTabBtn = document.getElementById("tab-nav-download");
    const kbTabBtn = document.getElementById("tab-nav-kb");
    const shuffleTabBtn = document.getElementById("tab-nav-shuffle");
    const downloadView = document.getElementById("view-download");
    const kbView = document.getElementById("view-kb");
    const shuffleView = document.getElementById("view-shuffle");

    if (tabName === "kb") {
      downloadTabBtn?.classList.remove("active");
      shuffleTabBtn?.classList.remove("active");
      kbTabBtn?.classList.add("active");
      if (downloadView) downloadView.style.display = "none";
      if (shuffleView) shuffleView.style.display = "none";
      if (kbView) kbView.style.display = "block";
      if (window.location.hash !== "#kb") {
        window.location.hash = "kb";
      }
      if (ExtractionDashboardManager.activeView === "tasks") {
        ExtractionDashboardManager.refresh();
      } else {
        loadTags();
        loadNotes();
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (tabName === "shuffle") {
      downloadTabBtn?.classList.remove("active");
      kbTabBtn?.classList.remove("active");
      shuffleTabBtn?.classList.add("active");
      if (downloadView) downloadView.style.display = "none";
      if (kbView) kbView.style.display = "none";
      if (shuffleView) shuffleView.style.display = "block";
      if (window.location.hash !== "#shuffle") {
        window.location.hash = "shuffle";
      }
      ShufflePlayer.loadPlaylist();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      kbTabBtn?.classList.remove("active");
      shuffleTabBtn?.classList.remove("active");
      downloadTabBtn?.classList.add("active");
      if (kbView) kbView.style.display = "none";
      if (shuffleView) shuffleView.style.display = "none";
      if (downloadView) downloadView.style.display = "block";
      if (window.location.hash === "#kb" || window.location.hash === "#shuffle") {
        window.location.hash = "download";
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  document.getElementById("tab-nav-download")?.addEventListener("click", () => switchPageTab("download"));
  document.getElementById("tab-nav-kb")?.addEventListener("click", () => switchPageTab("kb"));
  document.getElementById("tab-nav-shuffle")?.addEventListener("click", () => switchPageTab("shuffle"));
  document.getElementById("btn-shuffle-go-kb")?.addEventListener("click", () => switchPageTab("kb"));
  document.getElementById("brand-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    switchPageTab("download");
  });
  document.getElementById("btn-empty-go-download")?.addEventListener("click", () => switchPageTab("download"));

  window.addEventListener("hashchange", () => {
    if (window.location.hash === "#kb") {
      switchPageTab("kb");
    } else if (window.location.hash === "#shuffle") {
      switchPageTab("shuffle");
    } else {
      switchPageTab("download");
    }
  });

  if (window.location.hash === "#kb") {
    switchPageTab("kb");
  } else if (window.location.hash === "#shuffle") {
    switchPageTab("shuffle");
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

  // 分类模式切换：🏷️ 标签分类 vs 👤 博主分类
  document.getElementById("btn-mode-tags")?.addEventListener("click", () => setFilterMode("tags"));
  document.getElementById("btn-mode-authors")?.addEventListener("click", () => setFilterMode("authors"));
  document.getElementById("btn-clear-active-filter")?.addEventListener("click", () => {
    if (state.filterMode === "authors") {
      state.currentCategory = "__all__";
    } else {
      state.currentAuthor = "__all__";
    }
    updateActiveFilterIndicator();
    loadNotes(document.getElementById("kb-search-input")?.value || "");
  });

  // 批量补全历史已收藏笔记博主信息
  const btnBackfill = document.getElementById("btn-backfill-authors");
  const modalBackfill = document.getElementById("modal-backfill-authors");
  const btnCloseBackfill = document.getElementById("btn-close-backfill-modal");
  const btnCancelBackfill = document.getElementById("btn-cancel-backfill");
  const btnStartBackfill = document.getElementById("btn-start-backfill");
  const backfillIntro = document.getElementById("backfill-intro-text");
  const progressWrap = document.getElementById("backfill-progress-wrap");
  const progressFill = document.getElementById("backfill-progress-fill");
  const statusDesc = document.getElementById("backfill-status-desc");
  const statusNum = document.getElementById("backfill-status-num");
  const resultList = document.getElementById("backfill-result-list");

  let pendingBackfillNotes = [];

  if (btnBackfill) {
    btnBackfill.addEventListener("click", async () => {
      btnBackfill.disabled = true;
      showToast("🔍 正在扫描未识别博主的笔记...");
      try {
        const res = await fetch("/api/notes-missing-authors", {
          headers: { "x-auth-pin": state.pin }
        });
        const data = await res.json();
        if (!data.success) {
          showToast(`❌ 查询失败: ${data.message || "未知错误"}`, { isError: true });
          return;
        }

        pendingBackfillNotes = data.items || [];
        if (pendingBackfillNotes.length === 0) {
          showToast("🎉 所有已收藏笔记均已补全博主信息，无需补充！");
          return;
        }

        if (backfillIntro) {
          backfillIntro.innerHTML = `共检测到 <strong>${pendingBackfillNotes.length} 篇</strong> 未识别博主的历史笔记。<br>点击下方按钮将自动通过原始采集链接逐篇从小红书重新识别博主昵称与主页。`;
        }
        if (progressWrap) progressWrap.style.display = "none";
        if (resultList) {
          resultList.style.display = "none";
          resultList.innerHTML = "";
        }
        if (btnStartBackfill) {
          btnStartBackfill.disabled = false;
          btnStartBackfill.style.display = "inline-flex";
          btnStartBackfill.textContent = "开始自动补全";
        }
        modalBackfill?.classList.add("active");
      } catch (err) {
        showToast(`❌ 查询失败: ${err.message}`, { isError: true });
      } finally {
        btnBackfill.disabled = false;
      }
    });
  }

  const closeBackfillModal = () => {
    modalBackfill?.classList.remove("active");
  };
  btnCloseBackfill?.addEventListener("click", closeBackfillModal);
  btnCancelBackfill?.addEventListener("click", closeBackfillModal);
  modalBackfill?.addEventListener("click", (e) => {
    if (e.target === modalBackfill) closeBackfillModal();
  });

  if (btnStartBackfill) {
    btnStartBackfill.addEventListener("click", async () => {
      if (!pendingBackfillNotes.length) return;
      btnStartBackfill.disabled = true;
      if (progressWrap) progressWrap.style.display = "block";
      if (resultList) {
        resultList.style.display = "block";
        resultList.innerHTML = "";
      }

      let successCount = 0;
      let failCount = 0;
      const total = pendingBackfillNotes.length;

      for (let i = 0; i < total; i++) {
        const item = pendingBackfillNotes[i];
        const pct = Math.round(((i + 1) / total) * 100);
        if (progressFill) progressFill.style.width = `${pct}%`;
        if (statusNum) statusNum.textContent = `${pct}% (${i + 1}/${total})`;
        if (statusDesc) statusDesc.textContent = `正在识别: ${item.title?.slice(0, 16) || item.id}...`;

        try {
          const r = await fetch(`/api/notes/${encodeURIComponent(item.id)}/refresh-author`, {
            method: "POST",
            headers: { "x-auth-pin": state.pin }
          });
          const d = await r.json();
          const logItem = document.createElement("div");
          if (d.success) {
            successCount++;
            logItem.style.color = "#166534";
            logItem.textContent = `✅ [${item.title?.slice(0, 14) || item.id}] 识别成功: ${d.authorName || '博主已补齐'}`;
          } else {
            failCount++;
            logItem.style.color = "#b91c1c";
            logItem.textContent = `⚠️ [${item.title?.slice(0, 14) || item.id}] 未能识别: ${d.message || '网络或状态限制'}`;
          }
          if (resultList) {
            resultList.appendChild(logItem);
            resultList.scrollTop = resultList.scrollHeight;
          }
        } catch (e) {
          failCount++;
          const logItem = document.createElement("div");
          logItem.style.color = "#b91c1c";
          logItem.textContent = `❌ [${item.title?.slice(0, 14) || item.id}] 请求异常: ${e.message}`;
          if (resultList) {
            resultList.appendChild(logItem);
          }
        }

        // 短暂缓冲 350ms
        await new Promise(r => setTimeout(r, 350));
      }

      if (statusDesc) statusDesc.textContent = `完成！成功 ${successCount} 篇，失败 ${failCount} 篇`;
      btnStartBackfill.textContent = "已完成补全";
      showToast(`🎉 批量补全完成！成功补齐 ${successCount} 篇博主信息`);
      loadTags();
      loadAuthors();
      loadNotes();
    });
  }

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

  // ========================================================
  // 释放媒体存储空间操作 (选择删除视频 / 语音 / 两者一起删除，保留笔记与文案)
  // ========================================================
  const cleanupModal = document.getElementById("modal-media-cleanup");
  const closeCleanupModal = () => {
    cleanupModal?.classList.remove("active");
  };

  document.getElementById("btn-close-cleanup-modal")?.addEventListener("click", closeCleanupModal);
  document.getElementById("btn-cancel-cleanup")?.addEventListener("click", closeCleanupModal);
  cleanupModal?.addEventListener("click", (e) => {
    if (e.target === cleanupModal) closeCleanupModal();
  });

  const openMediaCleanupModal = (note) => {
    const targetNote = note || state.activeDetailNote;
    if (!targetNote) return;

    const btnVideoOnly = document.getElementById("btn-cleanup-video-only");
    const btnAudioOnly = document.getElementById("btn-cleanup-audio-only");
    const btnBoth = document.getElementById("btn-cleanup-both");

    const hasVideo = Array.isArray(targetNote.videos) && targetNote.videos.length > 0 && Boolean(targetNote.videos[0]?.url);
    const hasAudio = Boolean(targetNote.audioUrl);

    if (!hasVideo && !hasAudio) {
      showToast("当前笔记未包含视频或独立语音媒体，无需清理");
      return;
    }

    if (btnVideoOnly) btnVideoOnly.disabled = !hasVideo;
    if (btnAudioOnly) btnAudioOnly.disabled = !hasAudio;
    if (btnBoth) btnBoth.disabled = !hasVideo && !hasAudio;

    cleanupModal?.classList.add("active");
  };

  document.getElementById("btn-modal-cleanup-media")?.addEventListener("click", () => {
    openMediaCleanupModal(state.activeDetailNote);
  });

  document.getElementById("btn-modal-footer-cleanup")?.addEventListener("click", () => {
    openMediaCleanupModal(state.activeDetailNote);
  });

  const executeMediaCleanup = async (target) => {
    const note = state.activeDetailNote;
    if (!note) return;

    const hasVideo = Array.isArray(note.videos) && note.videos.length > 0 && Boolean(note.videos[0]?.url);
    const hasAudio = Boolean(note.audioUrl);

    try {
      if (target === "video") {
        if (!hasVideo) return;
        if (!confirm("确定要仅删除视频文件吗？\n系统将自动保留/提取纯音频，以便您之后仍可听声音并查阅文案，大幅节省云端空间。")) return;

        // 1. 如果尚未转存独立音频文件，先从视频中提取轻量纯音频并上传到 R2
        if (!hasAudio && hasVideo) {
          showToast("⏳ 正在提取轻量纯音频转存云端，以便删除大视频后保留声音...");
          try {
            const videoUrl = note.videos[0].url;
            const { blob } = await extractFullWavFromMedia(videoUrl);
            const uploadRes = await fetch(`/api/notes/${note.id}/audio`, {
              method: "POST",
              headers: {
                "x-auth-pin": state.pin,
                "Content-Type": "audio/wav"
              },
              body: blob
            });
            const uploadData = await uploadRes.json();
            if (uploadData.success && uploadData.audioUrl) {
              note.audioUrl = uploadData.audioUrl;
            }
          } catch (extractErr) {
            console.warn("提取纯音频失败:", extractErr);
            if (!confirm("提取独立音频失败，是否仍继续删除视频？（文字笔记与文案仍将完整保留）")) {
              return;
            }
          }
        }

        showToast("⏳ 正在从 Cloudflare R2 删除视频...");
        const res = await fetch(`/api/notes/${note.id}/delete-media`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({ target: "video" })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "删除视频失败");

        note.videos = [];
        showToast("🎬 视频文件已成功删除！纯音频与语音文案完整保留，已大幅腾出云端空间！");
      } else if (target === "audio") {
        if (!hasAudio) return;
        if (!confirm("确定要仅删除独立语音文件吗？视频画面、文案与笔记仍将完整保留。")) return;

        showToast("⏳ 正在从 Cloudflare R2 删除语音文件...");
        const res = await fetch(`/api/notes/${note.id}/delete-media`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({ target: "audio" })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "删除语音失败");

        note.audioUrl = "";
        showToast("🎧 语音文件已成功删除，已腾出云端空间！");
      } else if (target === "both") {
        if (!confirm("确定要同时删除视频和语音文件吗？\n当前笔记文字、感想、分类标签及【提取语音文案】将 100% 完整保留，云端大文件空间将完全释放。")) return;

        showToast("⏳ 正在从 Cloudflare R2 彻底删除音视频文件...");
        const res = await fetch(`/api/notes/${note.id}/delete-media`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-auth-pin": state.pin
          },
          body: JSON.stringify({ target: "both" })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.message || "删除音视频失败");

        note.videos = [];
        note.audioUrl = "";
        showToast("💥 音视频媒体已全部删除！文字笔记与语音文案安全留存，已最大化腾出云端空间！");
      }

      closeCleanupModal();
      openNoteDetail(note.id);
      loadStorageUsage({ forceRefresh: true });
    } catch (err) {
      showToast(`操作失败: ${err.message}`);
    }
  };

  document.getElementById("btn-cleanup-video-only")?.addEventListener("click", () => executeMediaCleanup("video"));
  document.getElementById("btn-cleanup-audio-only")?.addEventListener("click", () => executeMediaCleanup("audio"));
  document.getElementById("btn-cleanup-both")?.addEventListener("click", () => executeMediaCleanup("both"));

  // 设置弹窗
  const settingsModal = document.getElementById("modal-settings");

  function syncAiEngineSettingsUi(provider, key) {
    const radio = document.querySelector(`input[name="ai-whisper-provider"][value="${provider}"]`);
    if (radio) {
      radio.checked = true;
      document.querySelectorAll(".ai-engine-card").forEach((c) => c.classList.remove("active"));
      radio.closest(".ai-engine-card")?.classList.add("active");
    }

    const groqFields = document.getElementById("groq-config-fields");
    const customField = document.getElementById("custom-endpoint-field");
    const statusText = document.getElementById("ai-status-text");
    const statusBadge = document.getElementById("ai-active-status-badge");
    const statusDot = statusBadge?.querySelector(".status-dot");

    if (provider === "groq") {
      if (groqFields) groqFields.style.display = "block";
      if (customField) customField.style.display = "none";
      if (statusText) {
        if (key) {
          statusText.textContent = "当前选用：⚡ Groq 极速大模型 (whisper-large-v3 已配置就绪)";
          if (statusBadge) statusBadge.style.color = "#059669";
          if (statusDot) statusDot.style.background = "#10b981";
        } else {
          statusText.textContent = "当前选用：⚡ Groq 极速大模型 (请填入 API Key 即可激活)";
          if (statusBadge) statusBadge.style.color = "#d97706";
          if (statusDot) statusDot.style.background = "#f59e0b";
        }
      }
    } else if (provider === "cloudflare") {
      if (groqFields) groqFields.style.display = "block";
      if (customField) customField.style.display = "none";
      if (statusText) {
        statusText.textContent = "当前选用：☁️ Cloudflare Workers AI (内置大模型 · 免配置)";
        if (statusBadge) statusBadge.style.color = "#0284c7";
        if (statusDot) statusDot.style.background = "#0ea5e9";
      }
    } else if (provider === "custom") {
      if (groqFields) groqFields.style.display = "block";
      if (customField) customField.style.display = "block";
      if (statusText) {
        statusText.textContent = "当前选用：🤖 自定义 / OpenAI Whisper API";
        if (statusBadge) statusBadge.style.color = "#7c3aed";
        if (statusDot) statusDot.style.background = "#8b5cf6";
      }
    }
  }

  // 单选框切换与输入同步
  document.querySelectorAll('input[name="ai-whisper-provider"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const val = radio.value;
      const key = document.getElementById("settings-whisper-key")?.value.trim() || "";
      syncAiEngineSettingsUi(val, key);
    });
  });

  document.getElementById("settings-whisper-key")?.addEventListener("input", (e) => {
    const provider = document.querySelector('input[name="ai-whisper-provider"]:checked')?.value || "groq";
    syncAiEngineSettingsUi(provider, e.target.value.trim());
  });

  // 测试 Key 连通性按钮
  document.getElementById("btn-test-whisper-key")?.addEventListener("click", async () => {
    const key = document.getElementById("settings-whisper-key")?.value.trim() || "";
    const endpoint = document.getElementById("settings-whisper-endpoint")?.value.trim() || "";
    const provider = document.querySelector('input[name="ai-whisper-provider"]:checked')?.value || "groq";
    const resultEl = document.getElementById("test-whisper-result");
    if (!resultEl) return;

    if (!key) {
      resultEl.style.display = "block";
      resultEl.style.background = "#fee2e2";
      resultEl.style.color = "#b91c1c";
      resultEl.innerHTML = "⚠️ 请先在输入框中填入 Groq API Key (以 gsk_ 开头)";
      return;
    }

    resultEl.style.display = "block";
    resultEl.style.background = "#f1f5f9";
    resultEl.style.color = "#475569";
    resultEl.innerHTML = "⏳ 正在连接 Groq API 测试连通性...";

    try {
      const res = await fetch("/api/test-whisper-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, provider, endpoint })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        resultEl.style.background = "#dcfce7";
        resultEl.style.color = "#15803d";
        resultEl.innerHTML = `✅ ${data.message || "Groq API Key 验证成功！连接正常。"}`;
      } else {
        resultEl.style.background = "#fee2e2";
        resultEl.style.color = "#b91c1c";
        resultEl.innerHTML = `❌ ${data.message || "Key 验证未通过，请检查是否完整复制"}`;
      }
    } catch (err) {
      resultEl.style.background = "#fee2e2";
      resultEl.style.color = "#b91c1c";
      resultEl.innerHTML = `❌ 连接异常: ${err.message}`;
    }
  });

  document.getElementById("btn-open-settings")?.addEventListener("click", async () => {
    settingsModal?.classList.add("active");
    loadStorageUsage();
    const cookieEl = document.getElementById("settings-xhs-cookie");
    if (cookieEl) cookieEl.value = state.xhsCookie || "";
    const oldPinEl = document.getElementById("settings-old-pin");
    if (oldPinEl) oldPinEl.value = state.pin || "1987";
    const autoBgOcrEl = document.getElementById("settings-auto-bg-ocr");
    if (autoBgOcrEl) {
      autoBgOcrEl.checked = localStorage.getItem("xhs_auto_bg_ocr") !== "false";
    }
    const msg = document.getElementById("settings-msg");
    if (msg) msg.style.display = "none";
    const testResultEl = document.getElementById("test-whisper-result");
    if (testResultEl) testResultEl.style.display = "none";

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

        const whisperProvider = data.whisperProvider || (data.whisperApiKey ? "groq" : "cloudflare");
        state.whisperProvider = whisperProvider;
        syncAiEngineSettingsUi(whisperProvider, data.whisperApiKey || "");

        if (typeof data.autoBgOcr === "boolean") {
          if (autoBgOcrEl) autoBgOcrEl.checked = data.autoBgOcr;
          localStorage.setItem("xhs_auto_bg_ocr", data.autoBgOcr ? "true" : "false");
        }
        BackgroundSubtitleQueue.checkAndResumePending(false);
      }
    } catch {}
  });

  document.getElementById("btn-close-settings-modal")?.addEventListener("click", () => {
    settingsModal?.classList.remove("active");
  });

  // 保存设置（Cookie、PIN 码与 AI 引擎配置）提交
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
    const whisperProvider = document.querySelector('input[name="ai-whisper-provider"]:checked')?.value || (whisperApiKey ? "groq" : "cloudflare");
    state.whisperProvider = whisperProvider;
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
          whisperProvider,
          whisperApiKey,
          whisperApiEndpoint,
          autoBgOcr: document.getElementById("settings-auto-bg-ocr")?.checked !== false
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

        const autoBgOcrEl = document.getElementById("settings-auto-bg-ocr");
        if (autoBgOcrEl) {
          localStorage.setItem("xhs_auto_bg_ocr", autoBgOcrEl.checked ? "true" : "false");
        }

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

  // 初始化设置开关状态与实时联动
  const autoBgOcrToggle = document.getElementById("settings-auto-bg-ocr");
  if (autoBgOcrToggle) {
    autoBgOcrToggle.checked = localStorage.getItem("xhs_auto_bg_ocr") !== "false";
    autoBgOcrToggle.addEventListener("change", async () => {
      const isEnabled = autoBgOcrToggle.checked;
      localStorage.setItem("xhs_auto_bg_ocr", isEnabled ? "true" : "false");
      showToast(isEnabled ? "🐢 已开启：未提取文案的视频将自动加入后台慢速精细提取" : "已关闭自动后台字幕提取");
      if (isEnabled) {
        BackgroundSubtitleQueue.checkAndResumePending(true);
      }
      // 静默同步保存至 Cloudflare D1
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pin: state.pin,
          autoBgOcr: isEnabled
        })
      }).catch(() => {});
    });
  }

  // 绑定手动触发断点接力检查按钮 (设置弹窗中)
  document.getElementById("btn-trigger-resume-ocr")?.addEventListener("click", async () => {
    showToast("🔍 正在扫描云端所有缺少文案的视频笔记...");
    const count = await BackgroundSubtitleQueue.checkAndResumePending(true);
    if (count === 0 && !BackgroundSubtitleQueue.isProcessing) {
      showToast("🎉 云端所有视频笔记均已成功提取文案，暂无待接力任务！");
    }
  });

  // 绑定知识库工具栏中的待提取字幕快捷触发按钮
  document.getElementById("btn-kb-pending-subtitles")?.addEventListener("click", async () => {
    showToast("🐢 正在将未提取字幕的视频加入后台精细提取队列...");
    const count = await BackgroundSubtitleQueue.checkAndResumePending(true);
    if (count === 0 && !BackgroundSubtitleQueue.isProcessing) {
      showToast("🎉 云端所有视频笔记均已拥有字幕文案！");
    }
  });

  // 初始获取一次徽标计数与存储用量
  refreshNotesBadge();
  loadStorageUsage();

  // 初始化随身听播放引擎与播放库
  ShufflePlayer.init();
  ShufflePlayer.loadPlaylist();

  // 初始化慢速字幕提取看板管理器
  ExtractionDashboardManager.init();

  // 初始化多端自动断点接力检查 (延迟 2.5 秒，避开首屏高并发)
  setTimeout(() => {
    BackgroundSubtitleQueue.checkAndResumePending();
  }, 2500);

  // 页面切回可见时智能检查 (距离上次检查超过 30 秒)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (Date.now() - BackgroundSubtitleQueue.lastCheckTime > 30000) {
        BackgroundSubtitleQueue.checkAndResumePending();
      }
    }
  });

  // 挂起周期轮询检查 (每 75 秒检查一次是否有手机端新采集的待提取视频)
  setInterval(() => {
    if (!BackgroundSubtitleQueue.isProcessing && BackgroundSubtitleQueue.queue.length === 0) {
      BackgroundSubtitleQueue.checkAndResumePending();
    }
  }, 75000);
});
