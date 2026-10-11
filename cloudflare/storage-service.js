/**
 * Cloudflare D1 (SQLite) 与 R2 (对象存储) 笔记知识库服务
 */

const DEFAULT_PIN = "1987";

/**
 * 初始化数据库表结构
 */
export async function initDb(db) {
  if (!db) return;
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT,
      cover_url TEXT,
      images_json TEXT,
      videos_json TEXT,
      thoughts TEXT DEFAULT '',
      source_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // 插入默认 PIN 码
  const existingPin = await db.prepare("SELECT value FROM settings WHERE key = 'pin_code'").first();
  if (!existingPin) {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('pin_code', ?)").bind(DEFAULT_PIN).run();
  }
}

/**
 * 校验 PIN 码
 */
export async function verifyPin(db, pin) {
  if (!db) return pin === DEFAULT_PIN;
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'pin_code'").first();
    const currentPin = row?.value || DEFAULT_PIN;
    return String(pin).trim() === currentPin;
  } catch {
    return pin === DEFAULT_PIN;
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

  // 3. 检查是否已存在已有感想，保留已有感想
  const existing = await env.DB.prepare("SELECT thoughts, created_at FROM notes WHERE id = ?").bind(noteId).first();
  const thoughts = existing?.thoughts || "";
  const createdAt = existing?.created_at || now;

  await env.DB.prepare(`
    INSERT INTO notes (id, title, content, cover_url, images_json, videos_json, thoughts, source_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      content = excluded.content,
      cover_url = excluded.cover_url,
      images_json = excluded.images_json,
      videos_json = excluded.videos_json,
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
    noteData.sourceUrl || "",
    createdAt,
    now
  ).run();

  return {
    id: noteId,
    title: noteData.title,
    coverUrl,
    imagesCount: storedImages.length,
    videosCount: storedVideos.length,
    archivedAt: now
  };
}

/**
 * 分页与关键词检索笔记列表
 */
export async function listNotes(db, { search = "", limit = 20, offset = 0 } = {}) {
  if (!db) return { total: 0, items: [] };
  await initDb(db);

  let query = "SELECT id, title, cover_url, SUBSTR(content, 1, 100) AS content_preview, SUBSTR(thoughts, 1, 80) AS thoughts_preview, created_at, updated_at FROM notes";
  let countQuery = "SELECT COUNT(*) AS total FROM notes";
  const params = [];

  if (search.trim()) {
    const keyword = `%${search.trim()}%`;
    query += " WHERE title LIKE ? OR content LIKE ? OR thoughts LIKE ?";
    countQuery += " WHERE title LIKE ? OR content LIKE ? OR thoughts LIKE ?";
    params.push(keyword, keyword, keyword);
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";

  const totalRow = await db.prepare(countQuery).bind(...params).first();
  const total = totalRow?.total || 0;

  const rows = await db.prepare(query).bind(...params, limit, offset).all();

  return {
    total,
    items: rows.results || []
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

  return {
    id: row.id,
    title: row.title,
    content: row.content,
    coverUrl: row.cover_url,
    images: row.images_json ? JSON.parse(row.images_json) : [],
    videos: row.videos_json ? JSON.parse(row.videos_json) : [],
    thoughts: row.thoughts || "",
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
