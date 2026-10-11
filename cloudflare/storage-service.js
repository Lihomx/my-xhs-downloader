/**
 * Cloudflare D1 (SQLite) 与 R2 (对象存储) 笔记知识库服务
 */

export const DEFAULT_PIN = "1987";
export const DEFAULT_TAGS = ["运动健身", "干货灵感", "好物收藏", "生活日常"];

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
      source_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run();

    // 数据库迁移：如果旧 notes 表没有 tags_json 字段则动态补充
    try {
      await db.prepare("ALTER TABLE notes ADD COLUMN tags_json TEXT DEFAULT '[]'").run();
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

  await env.DB.prepare(`
    INSERT INTO notes (id, title, content, cover_url, images_json, videos_json, thoughts, tags_json, source_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      cover_url = excluded.cover_url,
      images_json = excluded.images_json,
      videos_json = excluded.videos_json,
      tags_json = excluded.tags_json,
      source_url = excluded.source_url,
      updated_at = excluded.updated_at
  `).bind(
    noteId,
    noteData.title || "小红书笔记",
    noteData.content || "",
    coverUrl,
    JSON.stringify(storedImages),
    JSON.stringify(storedVideos),
    thoughts,
    JSON.stringify(tags),
    noteData.sourceUrl || "",
    createdAt,
    now
  ).run();

  return {
    id: noteId,
    title: noteData.title,
    coverUrl,
    tags,
    imagesCount: storedImages.length,
    videosCount: storedVideos.length,
    archivedAt: now
  };
}

/**
 * 分页与关键词、分类检索笔记列表
 */
export async function listNotes(db, { search = "", tag = "", limit = 20, offset = 0 } = {}) {
  if (!db) return { total: 0, items: [] };
  await initDb(db);

  let query = "SELECT id, title, cover_url, tags_json, SUBSTR(content, 1, 100) AS content_preview, SUBSTR(thoughts, 1, 80) AS thoughts_preview, created_at, updated_at FROM notes";
  let countQuery = "SELECT COUNT(*) AS total FROM notes";
  const conditions = [];
  const params = [];

  if (tag === '__uncategorized__') {
    conditions.push("(tags_json IS NULL OR tags_json = '[]' OR tags_json = '')");
  } else if (tag && tag !== '__all__') {
    conditions.push("tags_json LIKE ?");
    params.push(`%"${tag}"%`);
  }

  if (search.trim()) {
    const keyword = `%${search.trim()}%`;
    conditions.push("(title LIKE ? OR content LIKE ? OR thoughts LIKE ? OR tags_json LIKE ?)");
    params.push(keyword, keyword, keyword, keyword);
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
    return {
      id: r.id,
      title: r.title,
      cover_url: r.cover_url,
      tags: Array.isArray(noteTags) ? noteTags : [],
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

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    coverUrl: row.cover_url,
    images: row.images_json ? JSON.parse(row.images_json) : [],
    videos: row.videos_json ? JSON.parse(row.videos_json) : [],
    thoughts: row.thoughts || "",
    tags: Array.isArray(tags) ? tags : [],
    sourceUrl: row.source_url,
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
    if (keysToDelete.length > 0) {
      await env.R2_BUCKET.delete(keysToDelete);
    }
  }

  // 从 D1 删除记录
  await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  return true;
}

/**
 * 服务 R2 媒体文件
 */
export async function serveMedia(r2, key) {
  if (!r2) return new Response("R2 存储未绑定", { status: 503 });
  const object = await r2.get(key);
  if (!object) return new Response("文件不存在", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
}
