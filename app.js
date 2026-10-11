import { makeZipBlob, makeNoteTextFileData } from "./lib/archive.js";
import { toPinyinFilename } from "./lib/pinyin.js";

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
  tagCounts: {}
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

    // 智能正则检测小红书特征链接
    const hasXhsLink = /https?:\/\/(?:[a-zA-Z0-9_-]+\.)?(?:xhslink\.com|xhslink\.cn|xiaohongshu\.com)\/[^\s<>'"()[\]{}，。！？、]+/i.test(text);

    if (hasXhsLink) {
      state.lastProcessedClipboard = text;
      const input = document.getElementById("input-text");
      if (input && input.value.trim() !== text) {
        input.value = text;
        const indicator = document.getElementById("auto-clip-indicator");
        if (indicator) {
          indicator.style.display = "inline-flex";
          setTimeout(() => { indicator.style.display = "none"; }, 4000);
        }
        showToast("⚡ 已自动识别剪贴板小红书链接，开始解析...");
        startParsing();
      }
    }
  } catch {
    // 浏览器权限未授权或静默拦截，不打扰用户
  }
}

// 2. 解析核心函数
async function startParsing() {
  const input = document.getElementById("input-text");
  const text = (input?.value || "").trim();
  if (!text) {
    showToast("请先输入或粘贴小红书链接");
    return;
  }

  const btnText = document.getElementById("btn-parse-text");
  const spinner = document.getElementById("btn-parse-spinner");
  const btn = document.getElementById("btn-parse");

  if (btn) btn.disabled = true;
  if (btnText) btnText.style.display = "none";
  if (spinner) spinner.style.display = "inline-block";

  document.getElementById("toast-bar")?.classList.remove("show");

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

// 渲染解析结果
function renderParseResult(note) {
  const section = document.getElementById("result-section");
  if (!section) return;
  section.style.display = "block";

  // 标题与文案
  document.getElementById("result-title").textContent = note.title || "小红书笔记";
  document.getElementById("result-content").textContent = note.content || "（无文案描述）";

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
  const qualitySelect = document.getElementById("video-quality-select");

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

    qualitySelect.onchange = () => {
      videoPlayer.src = qualitySelect.value;
      videoPlayer.play().catch(() => {});
    };
  } else {
    vidSection.style.display = "none";
    videoPlayer.removeAttribute("src");
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
      if (statusBadge) {
        statusBadge.textContent = "✅ 已永久离线保存至 Cloudflare 知识库";
        statusBadge.style.color = "var(--success)";
        statusBadge.style.background = "var(--success-bg)";
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
    document.getElementById("modal-note-content").textContent = note.content || "（无文案）";
    document.getElementById("modal-thoughts-input").value = note.thoughts || "";

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

    // 渲染视频
    const vidWrap = document.getElementById("modal-video-wrap");
    const vidPlayer = document.getElementById("modal-video-player");
    if (note.videos && note.videos.length > 0) {
      vidWrap.style.display = "block";
      vidPlayer.src = note.videos[0].url;
    } else {
      vidWrap.style.display = "none";
      vidPlayer.removeAttribute("src");
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

  // 输入操作按钮
  document.getElementById("btn-paste")?.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      const input = document.getElementById("input-text");
      if (input && text) {
        input.value = text;
        showToast("已粘贴剪贴板内容");
      }
    } catch {
      showToast("无法访问剪贴板，请手动按 Ctrl+V 粘贴");
    }
  });

  document.getElementById("btn-clear")?.addEventListener("click", () => {
    const input = document.getElementById("input-text");
    if (input) input.value = "";
  });

  document.getElementById("btn-parse")?.addEventListener("click", startParsing);

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

  // 宽屏全屏知识库管理视窗展开/关闭
  const kbModal = document.getElementById("modal-knowledge-base");
  document.getElementById("btn-open-drawer")?.addEventListener("click", () => {
    kbModal?.classList.add("active");
    loadTags();
    loadNotes();
  });

  document.getElementById("btn-close-kb-modal")?.addEventListener("click", () => {
    kbModal?.classList.remove("active");
  });

  kbModal?.addEventListener("click", (e) => {
    if (e.target === kbModal) kbModal.classList.remove("active");
  });

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
  document.getElementById("btn-close-note-modal")?.addEventListener("click", () => {
    noteModal?.classList.remove("active");
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
        noteModal?.classList.remove("active");
        loadTags();
        loadNotes(document.getElementById("kb-search-input")?.value || "");
        refreshNotesBadge();
      }
    } catch (err) {
      showToast(`删除失败: ${err.message}`);
    }
  });

  // 设置弹窗
  const settingsModal = document.getElementById("modal-settings");
  document.getElementById("btn-open-settings")?.addEventListener("click", async () => {
    settingsModal?.classList.add("active");
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
      if (data?.success && data.xhsCookie && cookieEl && !cookieEl.value) {
        cookieEl.value = data.xhsCookie;
        state.xhsCookie = data.xhsCookie;
        localStorage.setItem("xhs_cookie", data.xhsCookie);
      }
    } catch {}
  });

  document.getElementById("btn-close-settings-modal")?.addEventListener("click", () => {
    settingsModal?.classList.remove("active");
  });

  // 保存设置（Cookie 与 PIN 码）提交
  document.getElementById("btn-submit-change-pin")?.addEventListener("click", async () => {
    const oldPin = document.getElementById("settings-old-pin")?.value.trim() || state.pin;
    const newPin = document.getElementById("settings-new-pin")?.value.trim();
    const rawCookie = document.getElementById("settings-xhs-cookie")?.value || "";
    const cookieVal = normalizeCookieString(rawCookie);
    const cookieInput = document.getElementById("settings-xhs-cookie");
    if (cookieInput && cookieVal) {
      cookieInput.value = cookieVal;
    }
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
          xhsCookie: cookieVal
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

  // 初始获取一次徽标计数
  refreshNotesBadge();
});
