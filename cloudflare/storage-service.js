/**
 * Cloudflare D1 (SQLite) 与 R2 (对象存储) 笔记知识库服务
 */

export const DEFAULT_PIN = "1987";
export const DEFAULT_TAGS = ["运动健身", "干货灵感", "好物收藏", "生活日常"];

export function isGenericTitle(title) {
  if (!title || typeof title !== "string") return true;
  const t = title.trim();
  if (!t) return true;
  if (t === "小红书" || t === "小红书图片" || t === "小红书笔记" || t === "无标题" || t === "视频" || t === "笔记") return true;
  if (/^小红书[\s_·\-|—]/i.test(t)) return true;
  return false;
}

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

/**
 * 初始化数据库表结构
 */
let isDbInitialized = false;

export async function initDb(db) {
  if (!db || isDbInitialized) return;
  try {
    await db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).run();
    await db.prepare(`CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      cover_url TEXT,
      images_json TEXT,
      videos_json TEXT,
      thoughts TEXT DEFAULT '',
      tags_json TEXT DEFAULT '[]',
      transcript TEXT DEFAULT '',
      source_url TEXT,
      author_name TEXT DEFAULT '',
      author_id TEXT DEFAULT '',
      author_profile_url TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run();

    // 数据库迁移：如果旧 notes 表没有 tags_json / transcript / audio_url / audio_r2_key / author 字段则动态补充
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN tags_json TEXT DEFAULT '[]'").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN transcript TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN audio_url TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN audio_r2_key TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN in_shuffle INTEGER DEFAULT 0").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN author_name TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN author_id TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN author_profile_url TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN extraction_duration_ms INTEGER DEFAULT 0").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN extracted_at INTEGER DEFAULT 0").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN extraction_method TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN extraction_status TEXT DEFAULT 'pending'").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN extraction_fail_count INTEGER DEFAULT 0").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN extraction_last_error TEXT DEFAULT ''").run();
    } catch {}
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN extraction_error_log TEXT DEFAULT '[]'").run();
    } catch {}

    const existingPin = await db.prepare("SELECT value FROM settings WHERE key = 'pin_code'").first();
    if (!existingPin) {
      await db.prepare("INSERT INTO settings (key, value) VALUES ('pin_code', ?)").bind(DEFAULT_PIN).run();
    }

    const existingTags = await db.prepare("SELECT value FROM settings WHERE key = 'custom_tags'").first();
    if (!existingTags) {
      await db.prepare("INSERT INTO settings (key, value) VALUES ('custom_tags', ?)").bind(JSON.stringify(DEFAULT_TAGS)).run();
    }

    isDbInitialized = true;
  } catch (err) {
    console.error("initDb error:", err);
  }
}

/**
 * 校验 PIN 码
 */
export async function verifyPin(db, pin) {
  if (!db) return String(pin || "").trim() === DEFAULT_PIN;
  try {
    await initDb(db);
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'pin_code'").first();
    const currentPin = row?.value || DEFAULT_PIN;
    return String(pin || "").trim() === String(currentPin).trim();
  } catch (err) {
    console.error("verifyPin err:", err);
    return String(pin || "").trim() === DEFAULT_PIN;
  }
}

/**
 * 修改 PIN 码
 */
export async function changePin(db, oldPin, newPin) {
  if (!db) throw new Error("数据库未绑定");
  const isValid = await verifyPin(db, oldPin);
  if (!isValid) throw new Error("原 PIN 码不正确");
  if (!newPin || String(newPin).trim().length < 4) {
    throw new Error("新 PIN 码长度至少为 4 位");
  }

  await db.prepare("INSERT INTO settings (key, value) VALUES ('pin_code', ?) ON CONFLICT(key) DO UPDATE SET value = ?")
    .bind(String(newPin).trim(), String(newPin).trim())
    .run();

  return true;
}

/**
 * 读取通用系统设置
 */
export async function getSetting(db, key, defaultValue = '') {
  if (!db) return defaultValue;
  try {
    await initDb(db);
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
    return row?.value ?? defaultValue;
  } catch (err) {
    console.error("getSetting err:", err);
    return defaultValue;
  }
}

/**
 * 保存通用系统设置
 */
export async function setSetting(db, key, value) {
  if (!db) return false;
  try {
    await initDb(db);
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
      .bind(key, String(value ?? ''), String(value ?? ''))
      .run();
    return true;
  } catch (err) {
    console.error("setSetting err:", err);
    return false;
  }
}

/**
 * 获取自定义标签列表
 */
export async function getCustomTags(db) {
  if (!db) return DEFAULT_TAGS;
  await initDb(db);
  const raw = await getSetting(db, 'custom_tags', JSON.stringify(DEFAULT_TAGS));
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) && list.length > 0 ? list : DEFAULT_TAGS;
  } catch {
    return DEFAULT_TAGS;
  }
}

/**
 * 保存自定义标签列表
 */
export async function saveCustomTags(db, tags) {
  if (!db) return false;
  await initDb(db);
  const clean = Array.from(new Set((tags || []).map(t => String(t).trim()).filter(Boolean)));
  return await setSetting(db, 'custom_tags', JSON.stringify(clean));
}

/**
 * 获取所有标签及每个标签下的笔记数量统计
 */
export async function getTagsWithCounts(db) {
  if (!db) return { tags: DEFAULT_TAGS, counts: {} };
  await initDb(db);
  const tags = await getCustomTags(db);

  const totalRow = await db.prepare("SELECT COUNT(*) AS total FROM notes").first();
  const total = totalRow?.total || 0;

  const uncatRow = await db.prepare(
    "SELECT COUNT(*) AS c FROM notes WHERE tags_json IS NULL OR tags_json = '[]' OR tags_json = ''"
  ).first();
  const uncategorized = uncatRow?.c || 0;

  const counts = {
    __all__: total,
    __uncategorized__: uncategorized
  };

  for (const tag of tags) {
    const row = await db.prepare(
      "SELECT COUNT(*) AS c FROM notes WHERE tags_json LIKE ?"
    ).bind(`%"${tag}"%`).first();
    counts[tag] = row?.c || 0;
  }

  return { tags, counts };
}

/**
 * 添加单个自定义标签
 */
export async function addCustomTag(db, tag) {
  const clean = String(tag || '').trim();
  if (!clean) throw new Error("标签名称不能为空");
  const tags = await getCustomTags(db);
  if (!tags.includes(clean)) {
    tags.push(clean);
    await saveCustomTags(db, tags);
  }
  return tags;
}

/**
 * 重命名自定义标签（同时更新已有笔记打标）
 */
export async function renameCustomTag(db, oldTag, newTag) {
  const oldName = String(oldTag || '').trim();
  const newName = String(newTag || '').trim();
  if (!oldName || !newName) throw new Error("标签原名称与新名称均不能为空");
  if (oldName === newName) return await getCustomTags(db);

  const tags = await getCustomTags(db);
  const nextTags = tags.map(t => t === oldName ? newName : t);
  await saveCustomTags(db, nextTags);

  // 批量替换 notes 表中的 tags_json
  const rows = await db.prepare("SELECT id, tags_json FROM notes WHERE tags_json LIKE ?").bind(`%"${oldName}"%`).all();
  if (rows.results?.length) {
    for (const r of rows.results) {
      try {
        let noteTags = JSON.parse(r.tags_json || '[]');
        if (Array.isArray(noteTags)) {
          noteTags = noteTags.map(t => t === oldName ? newName : t);
          await db.prepare("UPDATE notes SET tags_json = ? WHERE id = ?").bind(JSON.stringify(noteTags), r.id).run();
        }
      } catch {}
    }
  }

  return nextTags;
}

/**
 * 删除自定义标签（同时从已有笔记中移除该标签）
 */
export async function deleteCustomTag(db, tag) {
  const target = String(tag || '').trim();
  if (!target) throw new Error("要删除的标签名不能为空");

  const tags = await getCustomTags(db);
  const nextTags = tags.filter(t => t !== target);
  await saveCustomTags(db, nextTags);

  // 从已有笔记中移除此标签
  const rows = await db.prepare("SELECT id, tags_json FROM notes WHERE tags_json LIKE ?").bind(`%"${target}"%`).all();
  if (rows.results?.length) {
    for (const r of rows.results) {
      try {
        let noteTags = JSON.parse(r.tags_json || '[]');
        if (Array.isArray(noteTags)) {
          noteTags = noteTags.filter(t => t !== target);
          await db.prepare("UPDATE notes SET tags_json = ? WHERE id = ?").bind(JSON.stringify(noteTags), r.id).run();
        }
      } catch {}
    }
  }

  return nextTags;
}

/**
 * 更新单篇笔记的标签
 */
export async function updateNoteTags(db, id, tags) {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const cleanTags = Array.from(new Set((tags || []).map(t => String(t).trim()).filter(Boolean)));
  const now = Date.now();
  await db.prepare("UPDATE notes SET tags_json = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(cleanTags), now, id)
    .run();
  return { id, tags: cleanTags, updatedAt: now };
}

/**
 * 抓取远程资源并存储到 Cloudflare R2
 */
async function fetchAndStoreToR2(r2, remoteUrl, key, contentType = "image/jpeg") {
  try {
    const res = await fetch(remoteUrl, {
      headers: {
        "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
        referer: "https://www.xiaohongshu.com/"
      }
    });
    if (!res.ok) {
      console.warn(`Fetch ${remoteUrl} failed: ${res.status}`);
      return null;
    }
    const blob = await res.arrayBuffer();
    const actualType = res.headers.get("content-type") || contentType;
    await r2.put(key, blob, {
      httpMetadata: {
        contentType: actualType,
        cacheControl: "public, max-age=31536000, immutable"
      }
    });
    return key;
  } catch (err) {
    console.error(`Store to R2 error for key ${key}:`, err);
    return null;
  }
}

/**
 * 自动归档笔记到 R2 和 D1
 */
export async function archiveNote(env, noteData) {
  if (!env.DB) throw new Error("D1 数据库未绑定");
  await initDb(env.DB);

  const noteId = noteData.noteId || `note_${Date.now()}`;
  const now = Date.now();

  const storedImages = [];
  const storedVideos = [];

  // 1. 转存图片到 R2
  if (env.R2_BUCKET && Array.isArray(noteData.images)) {
    for (let i = 0; i < noteData.images.length; i++) {
      const img = noteData.images[i];
      const r2Key = `images/${noteId}/${String(i + 1).padStart(2, "0")}.jpg`;
      const uploadedKey = await fetchAndStoreToR2(env.R2_BUCKET, img.url, r2Key, "image/jpeg");

      let liveVideoKey = null;
      if (img.liveVideo?.url) {
        const liveKey = `videos/${noteId}/${String(i + 1).padStart(2, "0")}_live.mp4`;
        liveVideoKey = await fetchAndStoreToR2(env.R2_BUCKET, img.liveVideo.url, liveKey, "video/mp4");
      }

      storedImages.push({
        index: i + 1,
        token: img.token,
        originalUrl: img.url,
        r2Key: uploadedKey || null,
        url: uploadedKey ? `/api/media/${uploadedKey}` : img.url,
        livePhoto: Boolean(img.livePhoto),
        liveVideoR2Key: liveVideoKey,
        liveVideoUrl: liveVideoKey ? `/api/media/${liveVideoKey}` : (img.liveVideo?.url || null)
      });
    }
  } else if (Array.isArray(noteData.images)) {
    storedImages.push(...noteData.images);
  }

  // 2. 转存首选高清视频到 R2
  if (env.R2_BUCKET && Array.isArray(noteData.videos) && noteData.videos.length > 0) {
    const primaryVideo = noteData.videos[0];
    if (primaryVideo?.url) {
      const videoKey = `videos/${noteId}/video_main.mp4`;
      const uploadedKey = await fetchAndStoreToR2(env.R2_BUCKET, primaryVideo.url, videoKey, "video/mp4");
      storedVideos.push({
        quality: primaryVideo.qualityType || primaryVideo.label || "高清",
        codec: primaryVideo.codec || "h264",
        originalUrl: primaryVideo.url,
        r2Key: uploadedKey || null,
        url: uploadedKey ? `/api/media/${uploadedKey}` : primaryVideo.url
      });
    }
  } else if (Array.isArray(noteData.videos)) {
    storedVideos.push(...noteData.videos);
  }

  const coverUrl = storedImages[0]?.url || "";

  // 3. 检查是否已存在已有感想和标签，保留已有感想与标签
  const existing = await env.DB.prepare("SELECT thoughts, tags_json, created_at FROM notes WHERE id = ?").bind(noteId).first();
  const thoughts = existing?.thoughts || "";
  let tags = [];
  if (Array.isArray(noteData.tags) && noteData.tags.length > 0) {
    tags = noteData.tags;
  } else if (existing?.tags_json) {
    try { tags = JSON.parse(existing.tags_json); } catch {}
  }
  const createdAt = existing?.created_at || now;

  let cleanTitle = (noteData.title || "").trim();
  if (isGenericTitle(cleanTitle) && noteData.content) {
    const fromContent = extractTitleFromContent(noteData.content);
    if (fromContent) cleanTitle = fromContent;
  }
  cleanTitle = cleanTitle || "小红书笔记";

  const authorName = (noteData.authorName || noteData.user?.nickname || "").trim();
  const authorId = (noteData.authorId || noteData.user?.userId || "").trim();
  const authorProfileUrl = (noteData.authorProfileUrl || (authorId ? `https://www.xiaohongshu.com/user/profile/${authorId}` : "")).trim();

  await env.DB.prepare(`
    INSERT INTO notes (id, title, content, cover_url, images_json, videos_json, thoughts, tags_json, source_url, author_name, author_id, author_profile_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      cover_url = excluded.cover_url,
      images_json = excluded.images_json,
      videos_json = excluded.videos_json,
      tags_json = excluded.tags_json,
      source_url = excluded.source_url,
      author_name = excluded.author_name,
      author_id = excluded.author_id,
      author_profile_url = excluded.author_profile_url,
      updated_at = excluded.updated_at
  `).bind(
    noteId,
    cleanTitle,
    noteData.content || "",
    coverUrl,
    JSON.stringify(storedImages),
    JSON.stringify(storedVideos),
    thoughts,
    JSON.stringify(tags),
    noteData.sourceUrl || "",
    authorName,
    authorId,
    authorProfileUrl,
    createdAt,
    now
  ).run();

  invalidateUsageCache();

  return {
    id: noteId,
    title: cleanTitle,
    coverUrl,
    tags,
    authorName,
    authorId,
    authorProfileUrl,
    imagesCount: storedImages.length,
    videosCount: storedVideos.length,
    archivedAt: now
  };
}

/**
 * 分页与关键词、分类、博主检索笔记列表
 */
export async function listNotes(db, { search = "", tag = "", author = "", limit = 20, offset = 0 } = {}) {
  if (!db) return { total: 0, items: [] };
  await initDb(db);

  let query = "SELECT id, title, cover_url, tags_json, in_shuffle, audio_url, videos_json, author_name, author_id, author_profile_url, SUBSTR(content, 1, 100) AS content_preview, SUBSTR(thoughts, 1, 80) AS thoughts_preview, created_at, updated_at FROM notes";
  let countQuery = "SELECT COUNT(*) AS total FROM notes";
  const conditions = [];
  const params = [];

  if (tag === '__uncategorized__') {
    conditions.push("(tags_json IS NULL OR tags_json = '[]' OR tags_json = '')");
  } else if (tag && tag !== '__all__') {
    conditions.push("tags_json LIKE ?");
    params.push(`%"${tag}"%`);
  }

  if (author === '__unknown__') {
    conditions.push("(author_name IS NULL OR TRIM(author_name) = '')");
  } else if (author && author !== '__all__') {
    conditions.push("author_name = ?");
    params.push(author);
  }

  if (search.trim()) {
    const keyword = `%${search.trim()}%`;
    conditions.push("(title LIKE ? OR content LIKE ? OR thoughts LIKE ? OR tags_json LIKE ? OR author_name LIKE ?)");
    params.push(keyword, keyword, keyword, keyword, keyword);
  }

  if (conditions.length > 0) {
    const whereClause = " WHERE " + conditions.join(" AND ");
    query += whereClause;
    countQuery += whereClause;
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

  const totalRow = await db.prepare(countQuery).bind(...params).first();
  const total = totalRow?.total || 0;

  const rows = await db.prepare(query).bind(...params, limit, offset).all();

  const items = (rows.results || []).map(r => {
    let noteTags = [];
    try { noteTags = JSON.parse(r.tags_json || '[]'); } catch {}
    let videos = [];
    try { videos = JSON.parse(r.videos_json || '[]'); } catch {}
    const hasAudioOrVideo = Boolean((r.audio_url && r.audio_url.trim()) || (videos.length > 0 && videos[0]?.url));
    return {
      id: r.id,
      title: r.title,
      cover_url: r.cover_url,
      author_name: r.author_name || "",
      author_id: r.author_id || "",
      author_profile_url: r.author_profile_url || (r.author_id ? `https://www.xiaohongshu.com/user/profile/${r.author_id}` : ""),
      tags: Array.isArray(noteTags) ? noteTags : [],
      inShuffle: Boolean(r.in_shuffle),
      hasAudioOrVideo,
      content_preview: r.content_preview,
      thoughts_preview: r.thoughts_preview,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  });

  return {
    total,
    items
  };
}

/**
 * 获取单篇笔记详情
 */
export async function getNote(db, id) {
  if (!db) return null;
  await initDb(db);
  const row = await db.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
  if (!row) return null;

  let tags = [];
  try { tags = JSON.parse(row.tags_json || '[]'); } catch {}

  let errorLog = [];
  try {
    errorLog = JSON.parse(row.extraction_error_log || '[]');
    if (!Array.isArray(errorLog)) errorLog = [];
  } catch {
    errorLog = [];
  }

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    coverUrl: row.cover_url,
    images: row.images_json ? JSON.parse(row.images_json) : [],
    videos: row.videos_json ? JSON.parse(row.videos_json) : [],
    audioUrl: row.audio_url || "",
    audioR2Key: row.audio_r2_key || "",
    inShuffle: Boolean(row.in_shuffle),
    thoughts: row.thoughts || "",
    tags: Array.isArray(tags) ? tags : [],
    transcript: row.transcript || "",
    sourceUrl: row.source_url,
    authorName: row.author_name || "",
    authorId: row.author_id || "",
    authorProfileUrl: row.author_profile_url || (row.author_id ? `https://www.xiaohongshu.com/user/profile/${row.author_id}` : ""),
    extractionStatus: row.extraction_status || (row.transcript ? "completed" : "pending"),
    extractionFailCount: Number(row.extraction_fail_count || 0),
    extractionLastError: row.extraction_last_error || "",
    extractionErrorLog: errorLog,
    extractionDurationMs: Number(row.extraction_duration_ms || 0),
    extractedAt: Number(row.extracted_at || 0),
    extractionMethod: row.extraction_method || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * 保存/更新笔记感想
 */
export async function updateThoughts(db, id, thoughts) {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const now = Date.now();
  await db.prepare("UPDATE notes SET thoughts = ?, updated_at = ? WHERE id = ?")
    .bind(String(thoughts ?? "").trim(), now, id)
    .run();
  return { id, thoughts, updatedAt: now };
}

/**
 * 保存/更新视频语音转写文本 (支持记录耗时、算法引擎及提取时间)
 */
export async function updateTranscript(db, id, transcript, { durationMs = null, method = null, extractedAt = null } = {}) {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const now = Date.now();
  const cleanTranscript = String(transcript ?? "").trim();
  const effExtractedAt = extractedAt ? Number(extractedAt) : (cleanTranscript ? now : 0);
  const effDurationMs = typeof durationMs === "number" ? Math.round(durationMs) : 0;
  const effMethod = typeof method === "string" ? method.trim() : "";

  if (effDurationMs > 0 || effMethod || effExtractedAt > 0) {
    await db.prepare(`
      UPDATE notes 
      SET transcript = ?, 
          updated_at = ?,
          extraction_status = CASE WHEN ? != '' THEN 'completed' ELSE extraction_status END,
          extraction_duration_ms = CASE WHEN ? > 0 THEN ? ELSE extraction_duration_ms END,
          extracted_at = CASE WHEN ? > 0 THEN ? ELSE extracted_at END,
          extraction_method = CASE WHEN ? != '' THEN ? ELSE extraction_method END
      WHERE id = ?
    `)
      .bind(
        cleanTranscript,
        now,
        cleanTranscript,
        effDurationMs, effDurationMs,
        effExtractedAt, effExtractedAt,
        effMethod, effMethod,
        id
      )
      .run();
  } else {
    await db.prepare(`
      UPDATE notes 
      SET transcript = ?, 
          updated_at = ?,
          extraction_status = CASE WHEN ? != '' THEN 'completed' ELSE extraction_status END
      WHERE id = ?
    `)
      .bind(cleanTranscript, now, cleanTranscript, id)
      .run();
  }
  return { id, transcript: cleanTranscript, updatedAt: now, durationMs: effDurationMs, method: effMethod, status: cleanTranscript ? 'completed' : 'pending' };
}

/**
 * 记录字幕提取失败原因、耗时与尝试历史
 */
export async function recordExtractionFailure(db, id, { errorMessage = "", durationMs = null, method = null } = {}) {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const now = Date.now();
  const cleanMsg = String(errorMessage || "提取未成功").trim().slice(0, 500);
  const effDurationMs = typeof durationMs === "number" ? Math.round(durationMs) : 0;
  const effMethod = typeof method === "string" ? method.trim() : "";

  // 读取现有 fail_count 与 error_log
  const row = await db.prepare("SELECT extraction_fail_count, extraction_error_log, extraction_duration_ms FROM notes WHERE id = ?").bind(id).first();
  const curCount = Number(row?.extraction_fail_count || 0) + 1;
  let log = [];
  try {
    log = JSON.parse(row?.extraction_error_log || "[]");
    if (!Array.isArray(log)) log = [];
  } catch {
    log = [];
  }

  // 追加最新的失败记录 (置顶，保留最近 15 次)
  log.unshift({
    attempt: curCount,
    time: now,
    error: cleanMsg,
    durationMs: effDurationMs,
    durationSec: Math.round(effDurationMs / 1000),
    method: effMethod
  });
  if (log.length > 15) log = log.slice(0, 15);

  await db.prepare(`
    UPDATE notes
    SET extraction_status = 'failed',
        extraction_fail_count = ?,
        extraction_last_error = ?,
        extraction_error_log = ?,
        extraction_duration_ms = CASE WHEN ? > 0 THEN ? ELSE extraction_duration_ms END,
        updated_at = ?
    WHERE id = ?
  `).bind(
    curCount,
    cleanMsg,
    JSON.stringify(log),
    effDurationMs, effDurationMs,
    now,
    id
  ).run();

  return {
    id,
    failCount: curCount,
    lastError: cleanMsg,
    errorLog: log,
    durationMs: effDurationMs,
    status: 'failed'
  };
}

/**
 * 编辑/更新笔记标题与正文描述
 */
export async function updateNoteDetail(db, id, { title, content }) {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const now = Date.now();
  const cleanTitle = typeof title === "string" ? title.trim() : "";
  const cleanContent = typeof content === "string" ? content.trim() : "";

  await db.prepare("UPDATE notes SET title = ?, content = ?, updated_at = ? WHERE id = ?")
    .bind(cleanTitle, cleanContent, now, id)
    .run();
  return { id, title: cleanTitle, content: cleanContent, updatedAt: now };
}

/**
 * 更新单篇笔记的博主信息
 */
export async function updateNoteAuthor(db, id, { authorName, authorId, authorProfileUrl } = {}) {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const now = Date.now();
  const cleanName = typeof authorName === "string" ? authorName.trim() : "";
  const cleanId = typeof authorId === "string" ? authorId.trim() : "";
  const cleanUrl = typeof authorProfileUrl === "string" ? authorProfileUrl.trim() : (cleanId ? `https://www.xiaohongshu.com/user/profile/${cleanId}` : "");

  await db.prepare("UPDATE notes SET author_name = ?, author_id = ?, author_profile_url = ?, updated_at = ? WHERE id = ?")
    .bind(cleanName, cleanId, cleanUrl, now, id)
    .run();
  return { id, authorName: cleanName, authorId: cleanId, authorProfileUrl: cleanUrl, updatedAt: now };
}

/**
 * 获取所有笔记博主列表及其笔记统计
 */
export async function getAuthorsWithCounts(db) {
  if (!db) return { total: 0, unknownCount: 0, authors: [] };
  await initDb(db);

  const totalRow = await db.prepare("SELECT COUNT(*) AS total FROM notes").first();
  const total = totalRow?.total || 0;

  const unknownRow = await db.prepare(`
    SELECT COUNT(*) AS c
    FROM notes
    WHERE author_name IS NULL OR TRIM(author_name) = ''
  `).first();
  const unknownCount = unknownRow?.c || 0;

  const rows = await db.prepare(`
    SELECT author_name, author_id, author_profile_url, COUNT(*) AS count
    FROM notes
    WHERE author_name IS NOT NULL AND TRIM(author_name) != ''
    GROUP BY author_name
    ORDER BY count DESC, author_name COLLATE NOCASE ASC
  `).all();

  return {
    total,
    unknownCount,
    authors: (rows.results || []).map(r => ({
      name: r.author_name,
      id: r.author_id,
      profileUrl: r.author_profile_url || (r.author_id ? `https://www.xiaohongshu.com/user/profile/${r.author_id}` : ""),
      count: r.count
    }))
  };
}

/**
 * 彻底删除笔记及 R2 资产
 */
export async function deleteNote(env, id) {
  if (!env.DB) throw new Error("数据库未绑定");
  await initDb(env.DB);

  const note = await getNote(env.DB, id);
  if (!note) return false;

  // 从 R2 批量删除图片和视频
  if (env.R2_BUCKET) {
    const keysToDelete = [];
    for (const img of note.images) {
      if (img.r2Key) keysToDelete.push(img.r2Key);
      if (img.liveVideoR2Key) keysToDelete.push(img.liveVideoR2Key);
    }
    for (const v of note.videos) {
      if (v.r2Key) keysToDelete.push(v.r2Key);
    }
    if (note.audioR2Key) {
      keysToDelete.push(note.audioR2Key);
    }
    if (keysToDelete.length > 0) {
      await env.R2_BUCKET.delete(keysToDelete);
    }
  }

  // 从 D1 删除记录
  await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  invalidateUsageCache();
  return true;
}

/**
 * 选择性删除笔记的媒体资产 (仅视频 / 仅音频 / 视频和音频一起删除)，腾出 R2 硬盘空间
 * 保留笔记标题、正文、标签、感想以及提取的语音文案 (transcript)
 */
export async function deleteNoteMedia(env, id, { target = 'both' } = {}) {
  if (!env.DB) throw new Error("数据库未绑定");
  await initDb(env.DB);

  const note = await getNote(env.DB, id);
  if (!note) throw new Error("笔记不存在");

  const keysToDelete = [];
  let updateVideos = false;
  let updateAudio = false;

  if (target === 'video' || target === 'both') {
    if (Array.isArray(note.videos)) {
      for (const v of note.videos) {
        if (v.r2Key) keysToDelete.push(v.r2Key);
      }
    }
    updateVideos = true;
  }

  if (target === 'audio' || target === 'both') {
    if (note.audioR2Key) {
      keysToDelete.push(note.audioR2Key);
    }
    updateAudio = true;
  }

  // 从 R2 删除指定媒体文件
  if (env.R2_BUCKET && keysToDelete.length > 0) {
    try {
      await env.R2_BUCKET.delete(keysToDelete);
    } catch (e) {
      console.warn("R2 delete media error:", e);
    }
  }

  const now = Date.now();
  if (updateVideos && updateAudio) {
    await env.DB.prepare("UPDATE notes SET videos_json = '[]', audio_url = '', audio_r2_key = '', updated_at = ? WHERE id = ?")
      .bind(now, id).run();
  } else if (updateVideos) {
    await env.DB.prepare("UPDATE notes SET videos_json = '[]', updated_at = ? WHERE id = ?")
      .bind(now, id).run();
  } else if (updateAudio) {
    await env.DB.prepare("UPDATE notes SET audio_url = '', audio_r2_key = '', updated_at = ? WHERE id = ?")
      .bind(now, id).run();
  }

  invalidateUsageCache();

  return {
    success: true,
    target,
    deletedKeys: keysToDelete,
    hasVideos: updateVideos ? false : (note.videos?.length > 0),
    hasAudio: updateAudio ? false : Boolean(note.audioUrl)
  };
}

/**
 * 保存提取的独立轻量纯音频到 R2，并关联到笔记
 */
export async function saveNoteAudio(env, id, audioBuffer, mimeType = 'audio/wav') {
  if (!env.DB) throw new Error("数据库未绑定");
  await initDb(env.DB);

  const note = await getNote(env.DB, id);
  if (!note) throw new Error("笔记不存在");

  if (!env.R2_BUCKET) throw new Error("R2 存储未绑定");

  const ext = mimeType.includes('mp3') ? 'mp3' : (mimeType.includes('m4a') ? 'm4a' : 'wav');
  const key = `audios/${id}/audio.${ext}`;

  await env.R2_BUCKET.put(key, audioBuffer, {
    httpMetadata: {
      contentType: mimeType,
      cacheControl: 'public, max-age=31536000, immutable'
    }
  });

  const audioUrl = `/api/media/${key}`;
  const now = Date.now();

  await env.DB.prepare("UPDATE notes SET audio_url = ?, audio_r2_key = ?, updated_at = ? WHERE id = ?")
    .bind(audioUrl, key, now, id).run();

  invalidateUsageCache();

  return {
    success: true,
    audioUrl,
    r2Key: key
  };
}

/**
 * 服务 R2 媒体文件（完整支持 HTTP Range 206 请求，支持视频与音频自由拖拉快进快退，支持客户端分片离线缓存）
 */
export async function serveMedia(r2, key, request) {
  if (!r2) return new Response("R2 存储未绑定", { status: 503 });

  const rangeHeader = request?.headers?.get('range');
  let object;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      const startStr = match[1];
      const endStr = match[2];

      let rangeOptions = {};
      if (startStr !== '' && endStr !== '') {
        const offset = parseInt(startStr, 10);
        const length = parseInt(endStr, 10) - offset + 1;
        rangeOptions = { offset, length };
      } else if (startStr !== '') {
        const offset = parseInt(startStr, 10);
        rangeOptions = { offset };
      } else if (endStr !== '') {
        const suffix = parseInt(endStr, 10);
        rangeOptions = { suffix };
      }

      try {
        object = await r2.get(key, { range: rangeOptions });
      } catch (e) {
        console.warn("R2 range get error:", e);
      }
    }
  }

  if (!object) {
    object = await r2.get(key);
  }

  if (!object) return new Response("文件不存在", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("accept-ranges", "bytes");

  // 如果客户端发起了 Range 请求且 R2 返回了对应切片
  if (rangeHeader && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size;
    const totalSize = object.size;
    const end = Math.min(offset + length - 1, totalSize - 1);

    headers.set("content-range", `bytes ${offset}-${end}/${totalSize}`);
    headers.set("content-length", String(length));

    return new Response(object.body, {
      status: 206,
      statusText: "Partial Content",
      headers
    });
  }

  headers.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/**
 * 切换笔记是否加入随机播放库
 */
export async function toggleNoteShuffle(db, id, inShuffle) {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const val = inShuffle ? 1 : 0;
  await db.prepare("UPDATE notes SET in_shuffle = ? WHERE id = ?").bind(val, id).run();
  return { id, inShuffle: Boolean(val) };
}

/**
 * 获取随机播放库中的全部音频笔记
 */
export async function getShuffleNotes(db) {
  if (!db) return [];
  await initDb(db);
  const rows = await db.prepare(`
    SELECT id, title, cover_url, audio_url, videos_json, transcript, tags_json, updated_at
    FROM notes
    WHERE in_shuffle = 1
    ORDER BY updated_at DESC
  `).all();

  return (rows.results || []).map(r => {
    let videos = [];
    try { videos = JSON.parse(r.videos_json || '[]'); } catch {}
    let tags = [];
    try { tags = JSON.parse(r.tags_json || '[]'); } catch {}
    const mediaUrl = r.audio_url || videos[0]?.url || "";
    return {
      id: r.id,
      title: r.title,
      coverUrl: r.cover_url,
      audioUrl: r.audio_url || "",
      videoUrl: videos[0]?.url || "",
      mediaUrl,
      transcript: r.transcript || "",
      tags
    };
  }).filter(item => Boolean(item.mediaUrl));
}

/**
 * 获取待提取画面字幕的视频笔记 (用于多端自动断点接力)
 */
export async function getPendingSubtitleNotes(db, limit = 50) {
  if (!db) return { items: [], total: 0 };
  await initDb(db);
  const countRow = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM notes
    WHERE (transcript IS NULL OR TRIM(transcript) = '')
      AND videos_json IS NOT NULL
      AND videos_json != '[]'
      AND videos_json != ''
      AND COALESCE(extraction_status, '') != 'manual'
      AND COALESCE(extraction_fail_count, 0) < 3
  `).first();
  const total = countRow?.total || 0;

  // 关键：未曾失败的任务 (fail_count = 0) 排在最前，尝试失败过的 (fail_count > 0) 移至队列末尾！
  // 手工提取模式 (extraction_status = 'manual') 直接排除，不参与后台自动队列循环
  const rows = await db.prepare(`
    SELECT id, title, cover_url, videos_json, audio_url, transcript, tags_json, created_at,
           COALESCE(extraction_status, 'pending') AS extraction_status,
           COALESCE(extraction_fail_count, 0) AS extraction_fail_count
    FROM notes
    WHERE (transcript IS NULL OR TRIM(transcript) = '')
      AND videos_json IS NOT NULL
      AND videos_json != '[]'
      AND videos_json != ''
      AND COALESCE(extraction_status, '') != 'manual'
      AND COALESCE(extraction_fail_count, 0) < 3
    ORDER BY 
      COALESCE(extraction_fail_count, 0) ASC,
      created_at DESC
    LIMIT ?
  `).bind(limit).all();

  const items = (rows.results || []).map(r => {
    let videos = [];
    try { videos = JSON.parse(r.videos_json || '[]'); } catch {}
    let tags = [];
    try { tags = JSON.parse(r.tags_json || '[]'); } catch {}
    return {
      id: r.id,
      title: r.title,
      coverUrl: r.cover_url,
      videos,
      tags,
      failCount: Number(r.extraction_fail_count || 0),
      status: r.extraction_status,
      createdAt: r.created_at
    };
  }).filter(n => Array.isArray(n.videos) && n.videos.length > 0 && Boolean(n.videos[0]?.url || n.videos[0]));

  return { items, total };
}

/**
 * 切换笔记字幕提取模式 (手工提取 'manual' vs 自动接力 'auto')
 */
export async function setExtractionMode(db, id, mode = 'manual') {
  if (!db) throw new Error("数据库未绑定");
  await initDb(db);
  const now = Date.now();
  const isAuto = mode === 'auto';
  const targetStatus = isAuto ? 'pending' : 'manual';

  if (isAuto) {
    // 恢复自动接力：重置为 pending 并清空失败计数，允许重新排入自动队列
    await db.prepare(`
      UPDATE notes 
      SET extraction_status = 'pending',
          extraction_fail_count = 0,
          updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();
  } else {
    // 切换为手工提取模式：停止后台自动队列重试
    await db.prepare(`
      UPDATE notes 
      SET extraction_status = 'manual',
          updated_at = ?
      WHERE id = ?
    `).bind(now, id).run();
  }

  return { id, mode: targetStatus, status: targetStatus, updatedAt: now };
}

/**
 * 获取字幕提取任务列表与全量看板数据 (包含待提取、已提取、耗时记录与统计)
 */
export async function getExtractionTasks(db, { limit = 100, filter = 'all' } = {}) {
  if (!db) return { items: [], total: 0, stats: { totalVideos: 0, completedCount: 0, pendingCount: 0, failedCount: 0, manualCount: 0, avgDurationSec: 0, avgDurationFormatted: '暂无' } };
  await initDb(db);

  // 1. 统计视频总数、已提取数、待提取数、提取失败数、手工提取数以及平均耗时
  const statsRow = await db.prepare(`
    SELECT 
      COUNT(*) AS total_videos,
      SUM(CASE WHEN transcript IS NOT NULL AND TRIM(transcript) != '' THEN 1 ELSE 0 END) AS completed_count,
      SUM(CASE WHEN (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_status, '') != 'manual' AND COALESCE(extraction_fail_count, 0) = 0 THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_status, '') != 'manual' AND COALESCE(extraction_fail_count, 0) > 0 THEN 1 ELSE 0 END) AS failed_count,
      SUM(CASE WHEN (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_status, '') = 'manual' THEN 1 ELSE 0 END) AS manual_count,
      AVG(CASE WHEN extraction_duration_ms > 0 THEN extraction_duration_ms ELSE NULL END) AS avg_duration_ms
    FROM notes
    WHERE videos_json IS NOT NULL AND videos_json != '[]' AND videos_json != ''
  `).first();

  const totalVideos = Number(statsRow?.total_videos || 0);
  const completedCount = Number(statsRow?.completed_count || 0);
  const pendingCount = Number(statsRow?.pending_count || 0);
  const failedCount = Number(statsRow?.failed_count || 0);
  const manualCount = Number(statsRow?.manual_count || 0);
  const avgDurationMs = Number(statsRow?.avg_duration_ms || 0);
  const avgDurationSec = Math.round(avgDurationMs / 1000);

  // 2. 构造查询条件
  let whereClause = "WHERE videos_json IS NOT NULL AND videos_json != '[]' AND videos_json != ''";
  if (filter === 'completed') {
    whereClause += " AND transcript IS NOT NULL AND TRIM(transcript) != ''";
  } else if (filter === 'pending') {
    whereClause += " AND (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_status, '') != 'manual' AND COALESCE(extraction_fail_count, 0) = 0";
  } else if (filter === 'failed') {
    whereClause += " AND (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_status, '') != 'manual' AND COALESCE(extraction_fail_count, 0) > 0";
  } else if (filter === 'manual') {
    whereClause += " AND (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_status, '') = 'manual'";
  }

  // 排序优先级：
  // 0: 未曾尝试的待提取任务 (排在最前)
  // 1: 尝试失败过的任务 (放到队列最后，避免阻挡未处理的任务)
  // 2: 切换为手工提取的任务
  // 3: 已提取完成的任务
  const rows = await db.prepare(`
    SELECT 
      id, title, cover_url, videos_json, audio_url, transcript, tags_json,
      COALESCE(extraction_status, 'pending') AS extraction_status,
      COALESCE(extraction_fail_count, 0) AS extraction_fail_count,
      COALESCE(extraction_last_error, '') AS extraction_last_error,
      COALESCE(extraction_error_log, '[]') AS extraction_error_log,
      COALESCE(extraction_duration_ms, 0) AS extraction_duration_ms,
      COALESCE(extracted_at, 0) AS extracted_at,
      COALESCE(extraction_method, '') AS extraction_method,
      created_at, updated_at
    FROM notes
    ${whereClause}
    ORDER BY 
      CASE 
        WHEN (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_status, '') != 'manual' AND COALESCE(extraction_fail_count, 0) = 0 THEN 0
        WHEN (transcript IS NULL OR TRIM(transcript) = '') AND COALESCE(extraction_fail_count, 0) > 0 THEN 1
        WHEN COALESCE(extraction_status, '') = 'manual' THEN 2
        ELSE 3 
      END,
      COALESCE(extracted_at, 0) DESC,
      created_at DESC
    LIMIT ?
  `).bind(limit).all();

  const items = (rows.results || []).map(r => {
    let videos = [];
    try { videos = JSON.parse(r.videos_json || '[]'); } catch {}
    let tags = [];
    try { tags = JSON.parse(r.tags_json || '[]'); } catch {}
    const transcriptText = String(r.transcript || '').trim();
    const isCompleted = transcriptText.length > 0;
    const isManual = r.extraction_status === 'manual';
    const durationMs = Number(r.extraction_duration_ms || 0);
    const durationSec = Math.round(durationMs / 1000);

    let durationFormatted = '未记录';
    if (durationSec > 0) {
      durationFormatted = durationSec >= 60 
        ? `${Math.floor(durationSec / 60)}分${durationSec % 60}秒` 
        : `${durationSec}秒`;
    }

    // 粗略断句计数
    let sentenceCount = 0;
    if (transcriptText) {
      const sents = transcriptText.split(/[\r\n]+|[。！？!?]+/).filter(Boolean);
      sentenceCount = sents.length;
    }

    const failCount = Number(r.extraction_fail_count || 0);
    const lastError = String(r.extraction_last_error || '').trim();
    let errorLog = [];
    try {
      errorLog = JSON.parse(r.extraction_error_log || '[]');
      if (!Array.isArray(errorLog)) errorLog = [];
    } catch {
      errorLog = [];
    }

    let status = 'pending';
    if (isCompleted) {
      status = 'completed';
    } else if (isManual) {
      status = 'manual';
    } else if (failCount > 0 || r.extraction_status === 'failed') {
      status = 'failed';
    }

    return {
      id: r.id,
      title: r.title,
      coverUrl: r.cover_url,
      videos,
      tags,
      isCompleted,
      isManual,
      status,
      failCount,
      lastError,
      errorLog,
      transcript: transcriptText,
      charCount: transcriptText.length,
      sentenceCount,
      durationMs,
      durationSec,
      durationFormatted,
      extractedAt: r.extracted_at || 0,
      extractedAtFormatted: r.extracted_at ? new Date(r.extracted_at).toLocaleString('zh-CN', { hour12: false }) : '',
      method: r.extraction_method || (isCompleted ? 'speech_whisper' : ''),
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }).filter(n => Array.isArray(n.videos) && n.videos.length > 0 && Boolean(n.videos[0]?.url || n.videos[0]));

  return {
    items,
    stats: {
      totalVideos,
      completedCount,
      pendingCount,
      failedCount,
      manualCount,
      avgDurationSec,
      avgDurationFormatted: avgDurationSec > 0 
        ? (avgDurationSec >= 60 ? `${Math.floor(avgDurationSec / 60)}分${avgDurationSec % 60}秒` : `${avgDurationSec}秒`)
        : '暂无'
    }
  };
}


/**
 * 体积大小格式化工具
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (!bytes || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 缓存机制：避免高频调用 R2 list 消耗操作配额
 */
let usageCache = {
  timestamp: 0,
  data: null
};

export function invalidateUsageCache() {
  usageCache.timestamp = 0;
  usageCache.data = null;
}

/**
 * 统计 Cloudflare R2、D1 与免费版资源用量
 */
export async function getStorageUsage(env, { forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && usageCache.data && (now - usageCache.timestamp < 300000)) {
    return { ...usageCache.data, cached: true, cachedAt: usageCache.timestamp };
  }

  const R2_FREE_QUOTA_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
  const D1_FREE_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;  // 5 GB

  let r2Stats = {
    bound: Boolean(env.R2_BUCKET),
    bucketName: 'xhs-media',
    totalBytes: 0,
    totalBytesFormatted: '0 B',
    quotaBytes: R2_FREE_QUOTA_BYTES,
    quotaFormatted: '10 GB',
    usedPercent: 0,
    remainingBytes: R2_FREE_QUOTA_BYTES,
    remainingFormatted: '10 GB',
    totalFiles: 0,
    imageCount: 0,
    videoCount: 0,
    otherCount: 0,
    classAQuota: '1,000,000 次 / 月',
    classBQuota: '10,000,000 次 / 月',
    egressFee: '$0 (永久免费无流量费)'
  };

  if (env.R2_BUCKET) {
    try {
      let totalSizeBytes = 0;
      let totalFiles = 0;
      let imageCount = 0;
      let videoCount = 0;
      let otherCount = 0;
      let truncated = true;
      let cursor = undefined;
      let pages = 0;
      const maxPages = 20;

      while (truncated && pages < maxPages) {
        pages++;
        const list = await env.R2_BUCKET.list({ limit: 1000, cursor });
        for (const obj of (list.objects || [])) {
          totalFiles++;
          totalSizeBytes += (obj.size || 0);
          const k = (obj.key || '').toLowerCase();
          if (k.endsWith('.mp4') || k.endsWith('.mov') || k.endsWith('.webm')) {
            videoCount++;
          } else if (k.endsWith('.jpg') || k.endsWith('.jpeg') || k.endsWith('.png') || k.endsWith('.webp') || k.endsWith('.gif')) {
            imageCount++;
          } else {
            otherCount++;
          }
        }
        truncated = Boolean(list.truncated);
        cursor = list.cursor;
      }

      const percent = Number(((totalSizeBytes / R2_FREE_QUOTA_BYTES) * 100).toFixed(2));
      const remaining = Math.max(0, R2_FREE_QUOTA_BYTES - totalSizeBytes);

      r2Stats = {
        ...r2Stats,
        totalBytes: totalSizeBytes,
        totalBytesFormatted: formatBytes(totalSizeBytes),
        usedPercent: percent,
        remainingBytes: remaining,
        remainingFormatted: formatBytes(remaining),
        totalFiles,
        imageCount,
        videoCount,
        otherCount
      };
    } catch (err) {
      console.error('R2 getStorageUsage error:', err);
    }
  }

  let d1Stats = {
    bound: Boolean(env.DB),
    dbName: 'xhs-db',
    noteCount: 0,
    approxBytes: 0,
    approxBytesFormatted: '0 B',
    quotaBytes: D1_FREE_QUOTA_BYTES,
    quotaFormatted: '5 GB',
    usedPercent: 0,
    remainingBytes: D1_FREE_QUOTA_BYTES,
    remainingFormatted: '5 GB',
    dailyReadsQuota: '5,000,000 行 / 天',
    dailyWritesQuota: '100,000 行 / 天'
  };

  if (env.DB) {
    try {
      await initDb(env.DB);
      const row = await env.DB.prepare(`
        SELECT 
          COUNT(*) as total_notes,
          COALESCE(SUM(LENGTH(COALESCE(title, '')) + LENGTH(COALESCE(content, '')) + LENGTH(COALESCE(images_json, '')) + LENGTH(COALESCE(videos_json, '')) + LENGTH(COALESCE(thoughts, '')) + LENGTH(COALESCE(tags_json, '')) + LENGTH(COALESCE(transcript, '')) + LENGTH(COALESCE(source_url, ''))), 0) as total_bytes
        FROM notes
      `).first();

      const noteCount = Number(row?.total_notes || 0);
      const approxBytes = Number(row?.total_bytes || 0);
      const percent = Number(((approxBytes / D1_FREE_QUOTA_BYTES) * 100).toFixed(4));
      const remaining = Math.max(0, D1_FREE_QUOTA_BYTES - approxBytes);

      d1Stats = {
        ...d1Stats,
        noteCount,
        approxBytes,
        approxBytesFormatted: formatBytes(approxBytes),
        usedPercent: percent,
        remainingBytes: remaining,
        remainingFormatted: formatBytes(remaining)
      };
    } catch (err) {
      console.error('D1 getStorageUsage error:', err);
    }
  }

  let status = 'safe';
  let statusText = '额度非常充裕，放心使用';
  if (r2Stats.usedPercent >= 90 || d1Stats.usedPercent >= 90) {
    status = 'danger';
    statusText = '已达配额预警临界点，建议清理空间';
  } else if (r2Stats.usedPercent >= 70 || d1Stats.usedPercent >= 70) {
    status = 'warning';
    statusText = '存储空间已使用过半，注意监控';
  }

  let hasCustomWhisperKey = false;
  if (env.DB) {
    try {
      const key = await getSetting(env.DB, 'whisper_api_key', '');
      hasCustomWhisperKey = Boolean(key);
    } catch {}
  }

  const result = {
    cached: false,
    cachedAt: now,
    status,
    statusText,
    r2: r2Stats,
    d1: d1Stats,
    workers: {
      dailyRequestsQuota: '100,000 次 / 天',
      egressTraffic: '永久免费'
    },
    ai: {
      bound: Boolean(env.AI),
      dailyQuota: '10,000 Neurons / 天 (Workers AI Whisper)',
      hasCustomWhisperKey
    },
    protectionInfo: {
      noAutoBilling: '在 Cloudflare 未绑定信用卡时，超出免费配额会自动拒绝新写入，官方绝不会强制扣费。',
      freeEgress: 'Cloudflare R2 不收取任何出网流量费 (Egress $0)，图片与视频访问无限量免费流量。',
      cleanMethod: '若需释放 R2 硬盘，可直接在知识库中点击笔记详情底部的「彻底删除本篇」，系统会自动同步彻底删除云端文件。'
    }
  };

  usageCache = {
    timestamp: now,
    data: result
  };

  return result;
}
