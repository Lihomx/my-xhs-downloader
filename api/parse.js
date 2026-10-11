import {
  XhsError,
  buildNoWatermarkUrl,
  extractInputUrl,
  extractNoteId,
  extractOriginalAssetToken,
  fetchNotePage,
  isDirectImageUrl,
  isGenericTitle,
  extractTitleFromContent,
  normalizeCookieString,
  parseNoteHtml,
  validateAssetToken
} from "../lib/xhs.js";
import { publicPlaybackVideo } from "../lib/video-policy.js";

function readJsonBody(req) {
  try {
    const body = req.body;
    if (typeof body === "string") return JSON.parse(body);
    return body && typeof body === "object" ? body : {};
  } catch {
    throw Object.assign(new XhsError("请求 JSON 格式无效。", 400), { code: "INVALID_JSON" });
  }
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ success: false, message: "只支持 POST 请求。" });
  }

  try {
    const body = readJsonBody(req);
    const rawText = String(body.text ?? "").trim();

    if (!rawText) throw new XhsError("请粘贴小红书分享文案或链接。");
    if (rawText.length > 3000) throw new XhsError("输入内容过长。", 413);

    const inputUrl = extractInputUrl(rawText);

    if (isDirectImageUrl(inputUrl)) {
      const token = extractOriginalAssetToken(inputUrl);
      if (!token || !validateAssetToken(token)) {
        throw new XhsError("无法从图片地址中提取原始资源标识。");
      }

      return res.status(200).json({
        success: true,
        engine: "node",
        title: "小红书图片",
        content: "",
        type: "image",
        count: 1,
        livePhotoCount: 0,
        videoCount: 0,
        images: [{
          index: 1,
          token,
          url: buildNoWatermarkUrl(token),
          livePhoto: false,
          liveVideo: null
        }],
        videos: []
      });
    }

    const rawCookie = req.headers?.["x-xhs-cookie"] || body.cookie || "";
    const cookie = normalizeCookieString(rawCookie);
    const { finalUrl, html } = await fetchNotePage(inputUrl, { cookie });
    let noteId = extractNoteId(finalUrl) || extractNoteId(inputUrl);

    if (!noteId) {
      const shareLinkMatch = html.match(/shareLink["']\s*:\s*["']([^"']+)["']/i)
        || html.match(/<meta[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
      if (shareLinkMatch?.[1]) {
        const unescaped = shareLinkMatch[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
        noteId = extractNoteId(unescaped);
      }
    }

    if (!noteId) {
      const rawIdMatch = html.match(/["'](?:firstNoteId|currentNoteId|noteId|note_id)["']\s*:\s*["']([A-Za-z0-9_-]{12,64})["']/i);
      if (rawIdMatch?.[1]) {
        noteId = rawIdMatch[1];
      }
    }

    if (!noteId) {
      throw new XhsError("无法从分享链接中识别当前笔记 ID。链接可能已失效或被删除。", 422);
    }

    const parsed = parseNoteHtml(html, { noteId });
    const publicImages = parsed.images.map(image => ({ ...image, liveVideo: publicPlaybackVideo(image.liveVideo) }));
    const publicVideos = parsed.videos.map(publicPlaybackVideo).filter(Boolean);

    if (publicImages.length === 0 && publicVideos.length === 0 && !parsed.originalVideos?.length) {
      throw new XhsError(
        "没有解析到图片或视频。笔记可能已删除、需要登录，或者小红书页面结构已更新。",
        422
      );
    }

    const images = publicImages.map((image, index) => ({
      index: index + 1,
      token: image.token,
      url: image.url,
      livePhoto: Boolean(image.livePhoto),
      liveVideo: image.liveVideo
        ? {
            url: image.liveVideo.url,
            backupUrls: Array.isArray(image.liveVideo.backupUrls)
              ? image.liveVideo.backupUrls
              : [],
            codec: image.liveVideo.codec,
            width: image.liveVideo.width,
            height: image.liveVideo.height,
            bitrate: image.liveVideo.bitrate,
            size: image.liveVideo.size,
            duration: image.liveVideo.duration,
            qualityType: image.liveVideo.qualityType
          }
        : null
    }));
    const videos = publicVideos.map((video, index) => ({
      index: index + 1,
      url: video.url,
      backupUrls: Array.isArray(video.backupUrls) ? video.backupUrls : [],
      codec: video.codec,
      width: video.width,
      height: video.height,
      bitrate: video.bitrate,
      size: video.size,
      hasAudio: video.hasAudio,
      audioCodec: video.audioCodec,
      audioChannels: video.audioChannels,
      audioBitrate: video.audioBitrate,
      qualityType: video.qualityType,
      label: video.label,
      isDefault: index === 0
    }));

    let finalTitle = parsed.title;
    if (isGenericTitle(finalTitle) && parsed.content) {
      const fromContent = extractTitleFromContent(parsed.content);
      if (fromContent) finalTitle = fromContent;
    }
    finalTitle = finalTitle || "小红书笔记";

    return res.status(200).json({
      success: true,
      engine: "node",
      title: finalTitle,
      content: parsed.content,
      noteId,
      sourceUrl: inputUrl,
      strategy: parsed.strategy,
      type: videos.length > 0 || parsed.originalVideos?.length > 0 ? (images.length > 0 ? "mixed" : "video") : "image",
      count: images.length,
      livePhotoCount: images.filter((image) => image.liveVideo).length,
      videoCount: videos.length,
      originalVideoCount: parsed.originalVideos?.length || 0,
      hasOriginalVideo: Boolean(parsed.originalVideos?.length),
      images,
      videos
    });
  } catch (error) {
    const statusCode = error instanceof XhsError ? error.statusCode : 500;
    const message = error instanceof XhsError
      ? error.message
      : "服务器解析失败，请稍后重试。";

    console.error("parse error", error);
    return res.status(statusCode).json({ success: false, engine: "node", message, ...(error.code === "INVALID_JSON" ? { code: "INVALID_JSON" } : {}) });
  }
}
