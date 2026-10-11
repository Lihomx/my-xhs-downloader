const URL_PATTERN = /https?:\/\/[^\s<>'"()[\]{}，。！？、]+/gi;
const MARKDOWN_URL_PATTERN = /\]\(\s*(https?:\/\/[^)\s<>]+)\s*\)/gi;

const XHS_IMAGE_PATTERN = /https?:(?:\\u002[fF]|\\\/|\/){2}[^"'<>\\\s]+?(?:xhscdn\.com|ci\.xiaohongshu\.com)[^"'<>\\\s]*/gi;

const HIGH_QUALITY_PATTERN = /!nd_dft_wlteh_(?:webp|jpg|jpeg|png)_3(?:$|[?#])/i;

const PAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 " +
    "Mobile/15E148 Safari/604.1",
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
  "cache-control": "no-cache",
  pragma: "no-cache"
};

const DIRECT_IMAGE_HOSTS = new Set([
  "sns-webpic-qc.xhscdn.com",
  "sns-webpic.xhscdn.com",
  "sns-img-hw.xhscdn.com",
  "sns-img-bd.xhscdn.com",
  "sns-img-al.xhscdn.com",
  "ci.xiaohongshu.com"
]);

const VIDEO_STREAM_KEYS = ["h264", "h265", "h266", "av1"];
const VIDEO_META_KEYS = new Set([
  "og:video",
  "og:video:url",
  "og:video:secure_url",
  "twitter:player:stream"
]);

const IMAGE_LIST_KEYS = ["imageList", "image_list", "images"];
const NOTE_WRAPPER_KEYS = ["note", "noteData", "note_data", "data"];

export class XhsError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "XhsError";
    this.statusCode = statusCode;
  }
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function normalizeImageUrl(raw) {
  let value = decodeHtmlEntities(String(raw ?? "").trim().replace(/^["']|["']$/g, ""));

  value = value
    .replace(/\\u002F/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003D/gi, "=")
    .replace(/\\x26/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/\\+$/g, "");

  if (value.startsWith("//")) value = `https:${value}`;
  if (value.startsWith("http://")) value = `https://${value.slice("http://".length)}`;

  return value;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isXhsImageUrl(value) {
  const normalized = normalizeImageUrl(value);
  const parsed = parseUrl(normalized);
  if (
    !parsed
    || parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
  ) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return (
    host === "xhscdn.com"
    || host.endsWith(".xhscdn.com")
    || host === "ci.xiaohongshu.com"
  );
}

export function isDirectImageUrl(value) {
  const normalized = normalizeImageUrl(value);
  const parsed = parseUrl(normalized);
  return Boolean(
    parsed
    && isXhsImageUrl(normalized)
    && DIRECT_IMAGE_HOSTS.has(parsed.hostname.toLowerCase())
  );
}

export function isXhsVideoUrl(value) {
  const parsed = parseUrl(normalizeImageUrl(value));
  if (
    !parsed
    || parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || (parsed.port && parsed.port !== "443")
  ) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return (host === "xhscdn.com" || host.endsWith(".xhscdn.com")) && parsed.pathname.length > 1;
}

function isAllowedPageHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return (
    host === "xhslink.com" ||
    host.endsWith(".xhslink.com") ||
    host === "xhslink.cn" ||
    host.endsWith(".xhslink.cn") ||
    host === "xiaohongshu.com" ||
    host.endsWith(".xiaohongshu.com")
  );
}

function isAllowedPageUrl(value) {
  const parsed = value instanceof URL ? value : parseUrl(value);
  return Boolean(
    parsed &&
    parsed.protocol === "https:" &&
    !parsed.username &&
    !parsed.password &&
    (!parsed.port || parsed.port === "443") &&
    isAllowedPageHost(parsed.hostname)
  );
}

export function extractInputUrl(text) {
  const input = String(text ?? "").trim();
  const candidates = [
    ...[...input.matchAll(MARKDOWN_URL_PATTERN)].map((match) => match[1]),
    ...[...input.matchAll(URL_PATTERN)].map((match) => match[0])
  ];
  if (candidates.length === 0) {
    throw new XhsError("没有检测到有效链接，请粘贴小红书分享文案或链接。");
  }

  let foundParsedUrl = false;
  for (const candidate of new Set(candidates)) {
    const markdownUnescaped = candidate.replace(/\\([^A-Za-z0-9\s])/g, "$1");
    const value = normalizeImageUrl(
      markdownUnescaped.replace(/[.,;:!?\])}，。！？；：）】》]+$/g, "")
    );
    const parsed = parseUrl(value);
    if (!parsed) continue;
    foundParsedUrl = true;

    if (isAllowedPageUrl(parsed) || isXhsImageUrl(value)) return value;
  }

  if (!foundParsedUrl) throw new XhsError("链接格式无效。");
  throw new XhsError("只支持小红书分享链接或小红书图片链接。");
}

/**
 * 从小红书页面 URL 中提取当前笔记 ID。
 * 支持 /discovery/item/<id>、/explore/<id>、/item/<id>、/note/<id> 以及 query 参数。
 */
export function extractNoteId(value) {
  const parsed = parseUrl(value);
  if (!parsed) return null;

  const match = parsed.pathname.match(
    /\/(?:discovery\/item|explore|item|note|notes)\/([A-Za-z0-9_-]{12,64})(?:\/|$)/i
  );
  if (match?.[1]) return match[1];

  const searchParamId = parsed.searchParams.get("note_id")
    || parsed.searchParams.get("noteId")
    || parsed.searchParams.get("id");
  if (searchParamId && /^[A-Za-z0-9_-]{12,64}$/.test(searchParamId)) {
    return searchParamId;
  }

  return null;
}

function uniqueKeepOrder(values) {
  const result = [];
  const seen = new Set();

  for (const item of values) {
    const normalized = normalizeImageUrl(item).split("#", 1)[0];
    if (!isXhsImageUrl(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function imageQualityScore(url) {
  const lower = normalizeImageUrl(url).toLowerCase();
  let score = 0;

  if (HIGH_QUALITY_PATTERN.test(lower)) score += 10000;
  if (lower.includes("!nd_dft_")) score += 5000;
  if (lower.includes("_wlteh_webp_3")) score += 3000;
  if (/_(?:webp|jpg|jpeg|png)_3(?:$|[?#])/.test(lower)) score += 1500;
  if (lower.includes("sns-webpic-qc.xhscdn.com")) score += 600;
  if (lower.includes("sns-img-") || lower.includes("ci.xiaohongshu.com")) score += 500;

  const penalties = new Map([
    ["!nd_prv_", 7000],
    ["preview", 5000],
    ["thumbnail", 5000],
    ["thumb", 4000],
    ["_mw_1", 4500],
    ["_webp_1", 3500],
    ["_webp_2", 2500],
    ["/avatar/", 10000],
    ["avatar", 8000],
    ["/head/", 8000]
  ]);

  for (const [token, penalty] of penalties) {
    if (lower.includes(token)) score -= penalty;
  }

  return score;
}

function collectUrls(value) {
  const found = [];

  if (typeof value === "string") {
    if (isXhsImageUrl(value)) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) found.push(...collectUrls(item));
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) found.push(...collectUrls(item));
  }

  return found;
}

function collectUrlsForKeys(value, keys) {
  const found = [];

  if (Array.isArray(value)) {
    for (const item of value) found.push(...collectUrlsForKeys(item, keys));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (keys.has(key)) found.push(...collectUrls(item));
    }

    for (const item of Object.values(value)) {
      if (item && typeof item === "object") {
        found.push(...collectUrlsForKeys(item, keys));
      }
    }
  }

  return found;
}

function imageUrlCandidates(item) {
  const imageOnlyItem = item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(
        Object.entries(item).filter(([key]) => ![
          "stream",
          "livePhotoStream",
          "live_photo_stream"
        ].includes(key))
      )
    : item;
  const defaultKeys = new Set([
    "urlDefault",
    "url_default",
    "defaultUrl",
    "default_url",
    "originUrl",
    "origin_url",
    "original",
    "originalUrl",
    "original_url"
  ]);
  const normalKeys = new Set(["url", "imageUrl", "image_url", "fileUrl", "file_url"]);
  const previewKeys = new Set([
    "urlPre",
    "url_pre",
    "previewUrl",
    "preview_url",
    "thumbnail",
    "thumbnailUrl",
    "thumbnail_url"
  ]);

  const defaults = uniqueKeepOrder(collectUrlsForKeys(imageOnlyItem, defaultKeys));
  const normals = uniqueKeepOrder(collectUrlsForKeys(imageOnlyItem, normalKeys));
  const previews = uniqueKeepOrder(collectUrlsForKeys(imageOnlyItem, previewKeys));
  const all = uniqueKeepOrder(collectUrls(imageOnlyItem));
  const candidates = uniqueKeepOrder([...defaults, ...normals, ...all, ...previews]);
  candidates.sort((a, b) => imageQualityScore(b) - imageQualityScore(a));
  return candidates;
}

function isLivePhotoItem(item) {
  if (!item || typeof item !== "object") return false;
  return [
    item.livePhoto,
    item.live_photo,
    item.isLivePhoto,
    item.is_live_photo
  ].some((value) => {
    if (value === true || value === 1) return true;
    if (typeof value !== "string") return false;
    return ["1", "true"].includes(value.trim().toLowerCase());
  });
}

function chooseImageAssets(imageList) {
  if (!Array.isArray(imageList)) return [];

  const selected = [];

  for (const item of imageList) {
    const sourceUrl = imageUrlCandidates(item)[0];
    if (!sourceUrl) continue;

    const streamRoot = [
      item?.stream,
      item?.livePhotoStream,
      item?.live_photo_stream
    ].find((value) => value && typeof value === "object" && Object.keys(value).length > 0);
    const liveStreams = extractStreamsFromRoot(streamRoot, "live-photo-stream");
    selected.push({
      sourceUrl,
      livePhoto: isLivePhotoItem(item) || liveStreams.length > 0,
      liveVideo: liveStreams[0] ?? null
    });
  }

  // imageList 的每个元素本身就代表一张图；即使静态 URL 重复，也必须保留同项实况配对。
  return selected;
}


function normalizeNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function collectVideoUrlsFromStream(stream) {
  if (!stream || typeof stream !== "object") return [];

  const values = [
    stream.masterUrl,
    stream.master_url,
    stream.url,
    ...(Array.isArray(stream.masterUrls) ? stream.masterUrls : []),
    ...(Array.isArray(stream.master_urls) ? stream.master_urls : []),
    ...(Array.isArray(stream.backupUrls) ? stream.backupUrls : []),
    ...(Array.isArray(stream.backup_urls) ? stream.backup_urls : [])
  ];

  const urls = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizeImageUrl(value).split("#", 1)[0];
    if (!isXhsVideoUrl(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

function codecPriority(codec) {
  const normalized = String(codec ?? "").toLowerCase();
  if (normalized.includes("264") || normalized === "avc") return 4;
  if (normalized.includes("265") || normalized.includes("hevc")) return 3;
  if (normalized.includes("266") || normalized.includes("vvc")) return 2;
  if (normalized.includes("av1")) return 1;
  return 0;
}

function videoQualityScore(video) {
  return (
    (video.hasAudio === true ? 2 : video.hasAudio === false ? 0 : 1) * 10 ** 18 +
    codecPriority(video.codec) * 10 ** 15 +
    normalizeNumber(video.width) * normalizeNumber(video.height) * 10 ** 6 +
    normalizeNumber(video.bitrate) * 10 +
    normalizeNumber(video.size)
  );
}

function streamAudioMetadata(item) {
  const audioCodec = String(item?.audioCodec ?? item?.audio_codec ?? '').toLowerCase();
  const audioChannels = normalizeNumber(item?.audioChannels ?? item?.audio_channels);
  const audioBitrate = normalizeNumber(item?.audioBitrate ?? item?.audio_bitrate);
  const explicit = item?.hasAudio ?? item?.has_audio;
  const audioKeys = ['audioCodec', 'audio_codec', 'audioChannels', 'audio_channels', 'audioBitrate', 'audio_bitrate'];
  const hasAudio = typeof explicit === 'boolean' ? explicit
    : audioChannels > 0 || audioBitrate > 0 || (audioCodec && !['none', 'null', 'unknown', '0'].includes(audioCodec)) ? true
      : audioKeys.some(key => Object.prototype.hasOwnProperty.call(item || {}, key)) ? false : null;
  return { hasAudio, audioCodec, audioChannels, audioBitrate };
}

function extractStreamsFromRoot(streamRoot, source = "media-stream") {
  if (!streamRoot || typeof streamRoot !== "object") return [];

  const streams = [];
  for (const streamKey of VIDEO_STREAM_KEYS) {
    const rawList = streamRoot[streamKey];
    const list = Array.isArray(rawList)
      ? rawList
      : rawList && typeof rawList === "object"
        ? [rawList]
        : [];

    for (const item of list) {
      const codec = item?.videoCodec ?? item?.video_codec ?? item?.codec ?? streamKey;
      const urls = collectVideoUrlsFromStream(item);
      if (urls.length === 0) continue;

      streams.push({
        url: urls[0],
        backupUrls: urls.slice(1),
        codec: String(codec || streamKey).toLowerCase(),
        width: normalizeNumber(item?.width),
        height: normalizeNumber(item?.height),
        bitrate: normalizeNumber(item?.videoBitrate ?? item?.video_bitrate ?? item?.bitrate),
        size: normalizeNumber(item?.size ?? item?.fileSize ?? item?.file_size),
        duration: normalizeNumber(
          item?.videoDuration ?? item?.video_duration ?? item?.duration
        ),
        qualityType: String(item?.qualityType ?? item?.quality_type ?? ""),
        ...streamAudioMetadata(item),
        sourceWatermark: "unknown",
        source
      });
    }
  }

  const deduped = new Map();
  for (const stream of streams) {
    const existing = deduped.get(stream.url);
    if (!existing || videoQualityScore(stream) > videoQualityScore(existing)) {
      deduped.set(stream.url, stream);
    }
  }

  return [...deduped.values()].sort((a, b) => videoQualityScore(b) - videoQualityScore(a));
}

function originalVideoUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) return null;
  if (/[\u0000-\u0020\u007f]/.test(value.trim())) return null;
  const normalized = normalizeImageUrl(value).split("#", 1)[0];
  // Preserve the document's complete signed URL. Never prepend a CDN host to a URL.
  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(value.trim()) || normalized.startsWith("https://")) {
    if (/^http:/i.test(value.trim()) || normalized.includes("\\") || !isXhsVideoUrl(normalized)) return null;
    return normalized;
  }
  const key = normalized.replace(/^\/+/, "");
  if (!/^[A-Za-z0-9/_~.\-]+$/.test(key) || key.split("/").some(part => part === "." || part === "..")) return null;
  return `https://sns-video-bd.xhscdn.com/${key}`;
}

function declaredOriginalVideoFields(note) {
  const video = note?.video;
  if (!video || typeof video !== "object") return [];
  return [
    [video.consumer?.originVideoKey, "video.consumer.originVideoKey"],
    [video.consumer?.origin_video_key, "video.consumer.origin_video_key"],
    [video.originVideoKey, "video.originVideoKey"],
    [video.origin_video_key, "video.origin_video_key"]
  ].map(([value, sourceField]) => ({ url: originalVideoUrl(value), sourceField })).filter(item => item.url);
}

function supportedOriginalVideoUrl(url) {
  try { return !decodeURIComponent(new URL(url).pathname).startsWith('/stream/'); }
  catch { return false; }
}

/** Read only explicitly published original keys on the selected note. Origin does not prove absence of a watermark. */
function extractOriginalVideosFromNote(note) {
  const video = note?.video;
  if (!video || typeof video !== "object") return [];
  // mediaV2 is a JSON-encoded object on current public pages. Its video metadata
  // describes the upload; stream dimensions and audio metadata describe transcodes.
  let mediaV2 = video.mediaV2;
  if (typeof mediaV2 === "string") {
    try { mediaV2 = mediaV2.length <= 1024 * 1024 ? JSON.parse(mediaV2) : null; }
    catch { mediaV2 = null; }
  }
  const originalMetadata = mediaV2 && typeof mediaV2 === "object" && !Array.isArray(mediaV2)
    && mediaV2.video && typeof mediaV2.video === "object" && !Array.isArray(mediaV2.video) ? mediaV2.video : {};
  const declaredMd5 = typeof originalMetadata.md5 === "string" && /^[a-f0-9]{32}$/i.test(originalMetadata.md5)
    ? originalMetadata.md5.toLowerCase() : "";
  const sources = [];
  const seen = new Set();
  for (const { url, sourceField } of declaredOriginalVideoFields(note)) {
    if (!supportedOriginalVideoUrl(url) || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      url, backupUrls: [], codec: "", width: normalizeNumber(originalMetadata.width),
      height: normalizeNumber(originalMetadata.height), bitrate: 0, size: 0,
      duration: normalizeNumber(originalMetadata.duration) * 1000, declaredMd5,
      metadataSource: Object.keys(originalMetadata).length ? "video.mediaV2.video" : "",
      qualityType: "origin", hasAudio: null,
      source: "origin-video-key", sourceField, sourceWatermark: "unknown"
    });
  }
  return sources;
}

function excludeOriginalVideoUrls(streams, originals) {
  const identity = url => new URL(normalizeImageUrl(url)).href.split("#", 1)[0];
  const originalUrls = new Set(originals.map(video => identity(video.url)));
  return streams.flatMap(stream => {
    const urls = [stream.url, ...(stream.backupUrls ?? [])].filter(url => !originalUrls.has(identity(url)));
    return urls.length ? [{ ...stream, url: urls[0], backupUrls: urls.slice(1) }] : [];
  });
}

/** Ordinary playback streams are kept separate from member-only original candidates. */
function extractVideoStreamsFromNote(note) {
  return excludeOriginalVideoUrls(
    extractStreamsFromRoot(note?.video?.media?.stream, "media-stream"),
    declaredOriginalVideoFields(note)
  );
}

function excludeOriginalLiveVideos(images, originals) {
  return images.map(image => image.liveVideo
    ? { ...image, liveVideo: excludeOriginalVideoUrls([image.liveVideo], originals)[0] ?? null }
    : image);
}

function prepareOriginalVideoResults(videos) {
  return videos.slice(0, 12).map((video, index) => ({
    ...video, label: `${video.width && video.height ? `${video.width}×${video.height} · ` : ""}平台原文件 · 水印状态未核验 · 线路 ${index + 1}`,
    isDefault: index === 0
  }));
}

function formatVideoLabel(video, index) {
  const resolution = video.width && video.height ? `${video.width}×${video.height}` : "原始清晰度";
  const codec = String(video.codec || "video").toUpperCase();
  const bitrate = video.bitrate ? ` · ${Math.round(video.bitrate / 1000)} kbps` : "";
  return `${resolution} · ${codec}${bitrate} · 线路 ${index + 1}`;
}

function prepareVideoResults(videos) {
  const sorted = [...videos].sort((a, b) => videoQualityScore(b) - videoQualityScore(a));
  return sorted.slice(0, 12).map((video, index) => ({
    ...video,
    label: formatVideoLabel(video, index),
    isDefault: index === 0
  }));
}

function extractBalancedStructure(text, start, openChar, closeChar) {
  if (text[start] !== openChar) return null;

  let depth = 0;
  let inString = false;
  let quote = "";
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === openChar) {
      depth += 1;
    } else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          text: text.slice(start, index + 1),
          end: index + 1
        };
      }
    }
  }

  return null;
}

function replaceBareJsValues(text) {
  // 只替换字符串外的 undefined / NaN / Infinity，避免破坏正文。
  let output = "";
  let index = 0;
  let inString = false;
  let quote = "";
  let escape = false;

  while (index < text.length) {
    const char = text[index];

    if (inString) {
      output += char;
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    const rest = text.slice(index);
    const match = rest.match(/^(?:undefined|NaN|-?Infinity)\b/);
    if (match) {
      output += "null";
      index += match[0].length;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function parseJsonLike(text) {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(replaceBareJsValues(text));
    } catch {
      return null;
    }
  }
}

function extractInitialStates(html) {
  const states = [];
  const seenRanges = new Set();

  // 常见形式：window.__INITIAL_STATE__ = {...}
  const assignmentPattern = /(?:window\.)?__INITIAL_STATE__\s*=\s*/g;
  for (const match of html.matchAll(assignmentPattern)) {
    const start = html.indexOf("{", match.index + match[0].length);
    if (start < 0) continue;

    const balanced = extractBalancedStructure(html, start, "{", "}");
    if (!balanced) continue;

    const rangeKey = `${start}:${balanced.end}`;
    if (seenRanges.has(rangeKey)) continue;
    seenRanges.add(rangeKey);

    const parsed = parseJsonLike(balanced.text);
    if (parsed && typeof parsed === "object") states.push(parsed);
  }

  // 兼容 <script id="__INITIAL_STATE__" type="application/json">...</script>
  const scriptPattern = /<script\b[^>]*\bid=["']__INITIAL_STATE__["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const parsed = parseJsonLike(decodeHtmlEntities(match[1].trim()));
    if (parsed && typeof parsed === "object") states.push(parsed);
  }

  return states;
}

function objectHasTargetId(value, noteId) {
  if (!value || typeof value !== "object") return false;
  const identifiers = [
    value.noteId,
    value.note_id,
    value.id,
    value.itemId,
    value.item_id
  ];
  return identifiers.some((identifier) => String(identifier ?? "") === noteId);
}

function directImageList(value) {
  if (!value || typeof value !== "object") return null;

  for (const key of IMAGE_LIST_KEYS) {
    if (Array.isArray(value[key])) return value[key];
  }

  return null;
}

function unwrapNoteCandidates(value, noteId, fromExactMapKey = false) {
  const candidates = [];
  if (!value || typeof value !== "object") return candidates;

  if (fromExactMapKey || objectHasTargetId(value, noteId)) candidates.push(value);

  for (const key of NOTE_WRAPPER_KEYS) {
    const wrapped = value[key];
    if (!wrapped || typeof wrapped !== "object") continue;
    if (fromExactMapKey || objectHasTargetId(wrapped, noteId)) candidates.push(wrapped);
  }

  return candidates;
}

function getPath(root, path) {
  let current = root;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function findExactNoteCandidates(state, noteId) {
  const candidates = [];
  const maps = [
    getPath(state, ["note", "noteDetailMap"]),
    getPath(state, ["note", "noteDetailMapV2"]),
    getPath(state, ["noteDetailMap"]),
    getPath(state, ["data", "noteDetailMap"])
  ];

  // 最可靠路径：noteDetailMap[当前笔记 ID]
  for (const map of maps) {
    if (!map || typeof map !== "object" || !(noteId in map)) continue;
    candidates.push(...unwrapNoteCandidates(map[noteId], noteId, true));
  }

  // 兼容页面结构变化：递归查找 noteId 精确相等的对象，绝不按图片数量猜帖子。
  const visited = new WeakSet();
  let visitedCount = 0;
  const MAX_VISITED = 120000;

  function walk(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 24) return;
    if (visited.has(value) || visitedCount >= MAX_VISITED) return;

    visited.add(value);
    visitedCount += 1;

    if (objectHasTargetId(value, noteId)) {
      candidates.push(...unwrapNoteCandidates(value, noteId, false));
    }

    if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, noteId)) {
      candidates.push(...unwrapNoteCandidates(value[noteId], noteId, true));
    }

    for (const child of Object.values(value)) walk(child, depth + 1);
  }

  walk(state);

  return candidates;
}

function extractTitleFromNoteObject(value) {
  if (!value || typeof value !== "object") return "";
  const title = value.title ?? value.displayTitle ?? value.display_title ?? "";
  return typeof title === "string" ? title.trim().slice(0, 120) : "";
}

function extractContentFromNoteObject(value) {
  if (!value || typeof value !== "object") return "";

  // 文案必须和已经锁定的当前笔记对象同源，不能递归扫描相关推荐。
  for (const key of ["desc", "description"]) {
    const content = value[key];
    if (typeof content !== "string" || !content.trim()) continue;
    const normalized = content.replace(/\r\n?/g, "\n").trim();
    return Array.from(normalized).slice(0, 10000).join("");
  }

  return "";
}

function selectExactNoteFromStates(html, noteId) {
  const matches = [];

  for (const state of extractInitialStates(html)) {
    for (const candidate of findExactNoteCandidates(state, noteId)) {
      const imageList = directImageList(candidate);
      const originalVideos = extractOriginalVideosFromNote(candidate);
      const declaredOriginals = declaredOriginalVideoFields(candidate);
      const images = excludeOriginalLiveVideos(imageList ? chooseImageAssets(imageList) : [], declaredOriginals);
      const videos = extractVideoStreamsFromNote(candidate);
      if (images.length === 0 && videos.length === 0 && originalVideos.length === 0 && declaredOriginals.length === 0) continue;

      matches.push({
        images,
        videos,
        originalVideos,
        title: extractTitleFromNoteObject(candidate),
        content: extractContentFromNoteObject(candidate),
        noteType: String(candidate.type || ''),
        exactId: objectHasTargetId(candidate, noteId)
      });
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    // 保持旧版图片选择逻辑：优先对象自身包含 noteId，再选媒体信息更完整的副本。
    const aLive = a.images.filter((image) => image.liveVideo).length;
    const bLive = b.images.filter((image) => image.liveVideo).length;
    const aMedia = a.images.length + a.videos.length + a.originalVideos.length + aLive;
    const bMedia = b.images.length + b.videos.length + b.originalVideos.length + bLive;
    return Number(b.exactId) - Number(a.exactId)
      || bMedia - aMedia
      || b.images.length - a.images.length;
  });

  return matches[0];
}

function findImageListArraysWithPositions(text) {
  const arrays = [];
  const pattern = /["']imageList["']\s*:\s*\[/g;

  for (const match of text.matchAll(pattern)) {
    const start = text.indexOf("[", match.index);
    if (start < 0) continue;
    const balanced = extractBalancedStructure(text, start, "[", "]");
    if (balanced) {
      arrays.push({
        keyStart: match.index,
        start,
        end: balanced.end,
        text: balanced.text
      });
    }
  }

  return arrays;
}

function objectRangesAtPositions(text, positions) {
  const requested = [...new Set(positions.filter(Number.isInteger))].sort((a, b) => a - b);
  const ownerStarts = new Map();
  const objectEnds = new Map();
  const objectStack = [];
  let requestedIndex = 0;
  let inString = false;
  let quote = "";
  let escape = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    while (requestedIndex < requested.length && requested[requestedIndex] < index) {
      requestedIndex += 1;
    }
    while (requestedIndex < requested.length && requested[requestedIndex] === index) {
      if (!inString && objectStack.length > 0) {
        ownerStarts.set(index, objectStack.at(-1));
      }
      requestedIndex += 1;
    }

    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
    } else if (char === "{") {
      objectStack.push(index);
    } else if (char === "}") {
      const start = objectStack.pop();
      if (Number.isInteger(start)) objectEnds.set(start, index + 1);
    }
  }

  const ranges = new Map();
  for (const [position, start] of ownerStarts) {
    const end = objectEnds.get(start);
    if (Number.isInteger(end) && end > position) {
      ranges.set(position, { start, end });
    }
  }
  return ranges;
}

function targetNoteObjectRanges(text, noteId) {
  const ranges = [];
  const seen = new Set();
  const pattern = /["'](?:noteId|note_id)["']\s*:\s*(["'])([A-Za-z0-9_-]{12,64})\1/g;

  const anchors = [...text.matchAll(pattern)]
    .filter((match) => match[2] === noteId)
    .map((match) => match.index);
  const rangeByAnchor = objectRangesAtPositions(text, anchors);

  for (const anchor of anchors) {
    const range = rangeByAnchor.get(anchor);
    if (!range) continue;
    const key = `${range.start}:${range.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranges.push({ ...range, anchor });
  }
  return ranges;
}

function targetOwnerAnchors(ranges) {
  const owners = new Map();
  for (const range of ranges) {
    const key = `${range.start}:${range.end}`;
    const anchors = owners.get(key) ?? [];
    anchors.push(range.anchor);
    owners.set(key, anchors);
  }
  return owners;
}

/**
 * 初始状态解析失败时的保守降级方案：
 * 只选择距离“当前 noteId”最近的 imageList，绝不扫描整页后按数量选最大图集。
 */
function extractTargetLocalImageList(html, noteId) {
  const noteRanges = targetNoteObjectRanges(html, noteId);
  if (noteRanges.length === 0) return null;

  const arrays = findImageListArraysWithPositions(html);
  const ownerRanges = objectRangesAtPositions(
    html,
    arrays.map((array) => array.keyStart)
  );
  const ownerAnchors = targetOwnerAnchors(noteRanges);
  const candidates = [];
  for (const array of arrays) {
    const owner = ownerRanges.get(array.keyStart);
    const anchors = owner
      ? ownerAnchors.get(`${owner.start}:${owner.end}`)
      : null;
    if (!anchors?.length) continue;
    const distance = Math.min(...anchors.map((anchor) => Math.abs(array.start - anchor)));

    const parsed = parseJsonLike(array.text);
    let images = [];

    if (Array.isArray(parsed)) {
      images = chooseImageAssets(parsed);
    } else {
      // 只对这个局部 imageList 做 URL 兜底，不扫描整个 HTML。
      images = uniqueKeepOrder(array.text.match(XHS_IMAGE_PATTERN) ?? [])
        .filter(isDirectImageUrl)
        .map((sourceUrl) => ({ sourceUrl, livePhoto: false, liveVideo: null }));
    }

    if (images.length > 0) candidates.push({ distance, images });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.distance - b.distance || b.images.length - a.images.length);
  return { images: candidates[0].images, title: "" };
}


function findVideoObjectsWithPositions(text) {
  const objects = [];
  const pattern = /["']video["']\s*:\s*\{/g;

  for (const match of text.matchAll(pattern)) {
    const start = text.indexOf("{", match.index);
    if (start < 0) continue;
    const balanced = extractBalancedStructure(text, start, "{", "}");
    if (balanced) {
      objects.push({
        keyStart: match.index,
        start,
        end: balanced.end,
        text: balanced.text
      });
    }
  }
  return objects;
}

function extractTargetLocalVideoAssets(html, noteId) {
  const noteRanges = targetNoteObjectRanges(html, noteId);
  if (noteRanges.length === 0) return { videos: [], originalVideos: [] };

  const objects = findVideoObjectsWithPositions(html);
  const ownerRanges = objectRangesAtPositions(
    html,
    objects.map((object) => object.keyStart)
  );
  const ownerAnchors = targetOwnerAnchors(noteRanges);
  const candidates = [];
  for (const object of objects) {
    const owner = ownerRanges.get(object.keyStart);
    const anchors = owner
      ? ownerAnchors.get(`${owner.start}:${owner.end}`)
      : null;
    if (!anchors?.length) continue;
    const distance = Math.min(...anchors.map((anchor) => Math.abs(object.start - anchor)));

    const parsed = parseJsonLike(object.text);
    if (!parsed || typeof parsed !== "object") continue;
    const videos = extractVideoStreamsFromNote({ video: parsed });
    const originalVideos = extractOriginalVideosFromNote({ video: parsed });
    const declaredOriginals = declaredOriginalVideoFields({ video: parsed });
    if (videos.length > 0 || originalVideos.length > 0 || declaredOriginals.length > 0) candidates.push({ distance, videos, originalVideos, declaredOriginals });
  }

  if (candidates.length === 0) return { videos: [], originalVideos: [] };
  candidates.sort((a, b) => a.distance - b.distance
    || b.videos.length + b.originalVideos.length - a.videos.length - a.originalVideos.length);
  return candidates[0];
}

function extractPrimaryMetaVideo(html) {
  const metaPattern = /<meta\b[^>]*>/gi;
  const contentPattern = /\bcontent\s*=\s*(["'])(.*?)\1/i;
  const keyPattern = /\b(?:property|name)\s*=\s*(["'])(.*?)\1/i;

  for (const tagMatch of html.matchAll(metaPattern)) {
    const tag = tagMatch[0];
    const content = tag.match(contentPattern)?.[2] ?? "";
    const key = (tag.match(keyPattern)?.[2] ?? "").toLowerCase();
    if (!VIDEO_META_KEYS.has(key)) continue;

    const normalized = normalizeImageUrl(content);
    if (isXhsVideoUrl(normalized)) {
      return {
        url: normalized,
        backupUrls: [],
        codec: "h264",
        width: 0,
        height: 0,
        bitrate: 0,
        size: 0,
        qualityType: "meta",
        sourceWatermark: "unknown",
        source: "primary-meta"
      };
    }
  }
  return null;
}

function extractPrimaryMetaImage(html) {
  const metaPattern = /<meta\b[^>]*>/gi;
  const contentPattern = /\bcontent\s*=\s*(["'])(.*?)\1/i;
  const keyPattern = /\b(?:property|name)\s*=\s*(["'])(.*?)\1/i;

  for (const tagMatch of html.matchAll(metaPattern)) {
    const tag = tagMatch[0];
    const content = tag.match(contentPattern)?.[2] ?? "";
    const key = (tag.match(keyPattern)?.[2] ?? "").toLowerCase();

    if (!["og:image", "twitter:image", "twitter:image:src"].includes(key)) continue;
    const normalized = normalizeImageUrl(content);
    if (isXhsImageUrl(normalized)) return normalized;
  }

  return null;
}

export function extractOriginalAssetToken(url) {
  const normalized = normalizeImageUrl(url);
  const parsed = parseUrl(normalized);
  if (!parsed || !isXhsImageUrl(normalized)) return null;

  let parts = [];
  for (const part of parsed.pathname.split("/").filter(Boolean)) {
    try {
      parts.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }

  if (parts.length === 0) return null;

  if (parsed.hostname.toLowerCase() === "ci.xiaohongshu.com") {
    parts[parts.length - 1] = parts.at(-1).split("!", 1)[0];
    return parts.join("/").replace(/^\/+|\/+$/g, "") || null;
  }

  if (parts.length >= 3 && /^\d{10,14}$/.test(parts[0])) {
    parts = parts.slice(2);
  }

  if (parts.length === 0) return null;
  parts[parts.length - 1] = parts.at(-1).split("!", 1)[0];

  return parts.join("/").replace(/^\/+|\/+$/g, "") || null;
}

export function validateAssetToken(token) {
  if (typeof token !== "string" || token.length < 1 || token.length > 400) return false;
  if (token.startsWith("/") || token.includes("..") || token.includes("\\")) return false;
  return /^[A-Za-z0-9/_~.\-]+$/.test(token);
}

export function buildNoWatermarkUrl(token) {
  if (!validateAssetToken(token)) throw new XhsError("图片资源标识无效。");

  const encoded = token
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");

  return `https://ci.xiaohongshu.com/${encoded}?imageView2/format/jpg`;
}

function extractPageTitle(html) {
  const patterns = [
    /<meta\b[^>]*(?:property|name)=["']og:title["'][^>]*content=["'](.*?)["'][^>]*>/i,
    /<meta\b[^>]*content=["'](.*?)["'][^>]*(?:property|name)=["']og:title["'][^>]*>/i,
    /<title[^>]*>(.*?)<\/title>/is
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "").trim()).slice(0, 120);
    }
  }

  return "小红书图片";
}

function convertImageAssets(imageAssets) {
  const images = [];

  for (const asset of imageAssets) {
    const sourceUrl = typeof asset === "string" ? asset : asset?.sourceUrl;
    const token = extractOriginalAssetToken(sourceUrl);
    if (!token || !validateAssetToken(token)) continue;

    images.push({
      token,
      url: buildNoWatermarkUrl(token),
      livePhoto: Boolean(asset?.livePhoto),
      liveVideo: asset?.liveVideo ?? null
    });
  }

  return images;
}

/**
 * 只解析指定 noteId 对应的图片和视频。
 * 不扫描整页推荐内容，因此不会混入其他帖子的媒体资源。
 */
export function parseNoteHtml(html, options = {}) {
  const noteId = String(options.noteId ?? "").trim();
  if (!noteId) {
    return {
      title: extractPageTitle(html),
      content: "",
      images: [],
      videos: [],
      originalVideos: [],
      strategy: "missing-note-id"
    };
  }

  const exact = selectExactNoteFromStates(html, noteId);
  if (exact) {
    return {
      title: exact.title || extractPageTitle(html),
      content: exact.content,
      noteType: exact.noteType,
      images: convertImageAssets(exact.images).slice(0, 50),
      videos: prepareVideoResults(exact.videos),
      originalVideos: prepareOriginalVideoResults(exact.originalVideos),
      strategy: "exact-initial-state"
    };
  }

  const localImages = extractTargetLocalImageList(html, noteId);
  const localVideoAssets = extractTargetLocalVideoAssets(html, noteId);
  const localVideos = localVideoAssets.videos;
  const localOriginalVideos = localVideoAssets.originalVideos;
  const hasLocalVideo = localVideos.length > 0 || localOriginalVideos.length > 0 || Boolean(localVideoAssets.declaredOriginals?.length);
  if (localImages || hasLocalVideo) {
    return {
      title: localImages?.title || extractPageTitle(html),
      content: "",
      images: convertImageAssets(excludeOriginalLiveVideos(localImages?.images ?? [], localVideoAssets.declaredOriginals ?? [])).slice(0, 50),
      videos: prepareVideoResults(localVideos),
      originalVideos: prepareOriginalVideoResults(localOriginalVideos),
      strategy: localImages && hasLocalVideo
        ? "note-id-local-media"
        : localImages
          ? "note-id-local-image-list"
          : "note-id-local-video"
    };
  }

  // 最后的保守兜底只读取当前页面主媒体 meta，不全局扫描。
  const primaryImage = extractPrimaryMetaImage(html);
  const primaryVideo = extractPrimaryMetaVideo(html);
  return {
    title: extractPageTitle(html),
    content: "",
    images: primaryImage ? convertImageAssets([primaryImage]) : [],
    videos: primaryVideo ? prepareVideoResults([primaryVideo]) : [],
    originalVideos: [],
    strategy: primaryImage && primaryVideo
      ? "primary-meta-media"
      : primaryImage
        ? "primary-meta-cover"
        : primaryVideo
          ? "primary-meta-video"
          : "not-found"
  };
}

async function readTextWithLimit(response, maxBytes = 6 * 1024 * 1024) {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new XhsError("页面内容过大，已停止解析。", 413);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8").decode(merged);
}

function isShortLinkHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === "xhslink.com" || host.endsWith(".xhslink.com") || host === "xhslink.cn" || host.endsWith(".xhslink.cn");
}

function extractShortCodeFromUrl(url) {
  if (!isShortLinkHost(url.hostname)) return null;
  const match = url.pathname.match(/\/(?:o|a|b|c|d|e)\/([A-Za-z0-9_-]+)/i)
    || url.pathname.match(/^\/([A-Za-z0-9_-]{4,32})$/);
  return match?.[1] || null;
}

function generateShortCodeCandidates(code) {
  const map = {
    'l': ['I', '1'],
    'I': ['l', '1'],
    '1': ['l', 'I'],
    '0': ['O'],
    'O': ['0']
  };

  const positions = [];
  for (let i = 0; i < code.length; i++) {
    if (map[code[i]]) {
      positions.push(i);
    }
  }

  if (positions.length === 0 || positions.length > 3) return [];

  const candidates = new Set();
  
  function backtrack(idx, currentChars) {
    if (idx === positions.length) {
      const str = currentChars.join('');
      if (str !== code) candidates.add(str);
      return;
    }
    const pos = positions[idx];
    const orig = currentChars[pos];
    const alternatives = [orig, ...map[orig]];
    for (const alt of alternatives) {
      currentChars[pos] = alt;
      backtrack(idx + 1, currentChars);
    }
    currentChars[pos] = orig;
  }

  backtrack(0, code.split(''));
  return Array.from(candidates);
}

async function rescueAmbiguousShortLink(currentUrl, shortCode, { signal, fetchImpl = globalThis.fetch } = {}) {
  const candidates = generateShortCodeCandidates(shortCode);
  if (candidates.length === 0) return null;

  const basePath = currentUrl.pathname.slice(0, currentUrl.pathname.lastIndexOf(shortCode));

  const probeCandidate = async (candidate) => {
    try {
      const candUrl = new URL(basePath + candidate + currentUrl.search, currentUrl);
      const res = await fetchImpl(candUrl, {
        method: "GET",
        headers: PAGE_HEADERS,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000)
      });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        await res.body?.cancel();
        if (loc) {
          const target = new URL(loc, candUrl);
          if (extractNoteId(target.href)) {
            return target;
          }
        }
      } else {
        await res.body?.cancel();
      }
    } catch {}
    return null;
  };

  const results = await Promise.all(candidates.map(probeCandidate));
  return results.find(Boolean) || null;
}

export async function fetchNotePage(inputUrl, { signal, fetchImpl = globalThis.fetch } = {}) {
  let current = new URL(inputUrl);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    signal?.throwIfAborted();
    if (!isAllowedPageUrl(current)) {
      throw new XhsError("分享链接跳转到了不受支持的地址。", 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        headers: PAGE_HEADERS,
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      });
    } catch (error) {
      clearTimeout(timer);
      if (signal?.aborted) throw signal.reason || error;
      if (error?.name === "AbortError") {
        throw new XhsError("访问小红书页面超时，请稍后重试。", 504);
      }
      throw new XhsError(`访问小红书页面失败：${error.message}`, 502);
    }

    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new XhsError("分享链接跳转响应缺少目标地址。", 502);
        
        let nextUrl;
        try {
          nextUrl = new URL(location, current);
        } catch {
          throw new XhsError("分享链接跳转地址无效。", 502);
        }

        const isRootHomepage = (nextUrl.hostname === 'xiaohongshu.com' || nextUrl.hostname.endsWith('.xiaohongshu.com'))
          && (nextUrl.pathname === '/' || nextUrl.pathname === '' || nextUrl.pathname === '/index.html')
          && !extractNoteId(nextUrl.href);

        if (isRootHomepage) {
          const shortCode = extractShortCodeFromUrl(current);
          if (shortCode) {
            const rescued = await rescueAmbiguousShortLink(current, shortCode, { signal, fetchImpl });
            if (rescued) {
              current = rescued;
              continue;
            }
          }
          throw new XhsError("分享链接已失效或未找到对应笔记（小红书跳转至首页）。请检查链接是否正确。", 422);
        }

        current = nextUrl;
        continue;
      }

      if (!response.ok) {
        const hint = response.status === 403 || response.status === 461
          ? "小红书拒绝了服务器访问，可能触发了风控，请稍后重试。"
          : `小红书页面返回 HTTP ${response.status}。`;
        await response.body?.cancel();
        const error = new XhsError(hint, response.status >= 500 ? 502 : 400);
        if ([403, 429, 461, 471].includes(response.status)) error.code = 'RATE_LIMITED';
        if (response.status === 401) error.code = 'AUTH_REQUIRED';
        throw error;
      }

      const html = await readTextWithLimit(response);
      if (!html.trim()) throw new XhsError("小红书页面返回内容为空。", 502);

      return { finalUrl: current.toString(), html };
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (controller.signal.aborted) throw new XhsError("访问小红书页面超时，请稍后重试。", 504);
      throw error;
    } finally { clearTimeout(timer); }
  }

  throw new XhsError("分享链接跳转次数过多。", 400);
}
