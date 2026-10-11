import parse from '../api/parse.js';
import image from '../api/image.js';
import video from '../api/video.js';
import packageInfo from '../package.json' with { type: 'json' };
import { parseWithFallback } from './parse-fallback.js';
import { invokeHandler } from './http-adapter.js';
import {
  initDb,
  verifyPin,
  changePin,
  archiveNote,
  listNotes,
  getNote,
  updateThoughts,
  deleteNote,
  serveMedia
} from './storage-service.js';

const NODE_ROUTES = { '/api/parse': parse, '/api/image': image, '/api/video': video };

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  });
}

export function createWorker({ nodeRoutes = NODE_ROUTES } = {}) {
  return {
    async fetch(request, env = {}, ctx) {
      const url = new URL(request.url);
      const path = url.pathname;

      try {
        // 1. 媒体静态资源代理 (来自 R2)
        if (path.startsWith('/api/media/')) {
          const key = decodeURIComponent(path.slice('/api/media/'.length));
          return await serveMedia(env.R2_BUCKET, key);
        }

        // 2. 健康检查
        if (path === '/api/health') {
          return json({
            ok: true,
            platform: 'cloudflare',
            version: packageInfo.version,
            storage: {
              d1: Boolean(env.DB),
              r2: Boolean(env.R2_BUCKET)
            }
          });
        }

        // 3. 校验 PIN 码
        if (path === '/api/verify-pin' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const valid = await verifyPin(env.DB, body.pin);
          return json({ valid });
        }

        // 4. 修改 PIN 码
        if (path === '/api/change-pin' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          await changePin(env.DB, body.oldPin, body.newPin);
          return json({ success: true, message: "PIN 码修改成功" });
        }

        // 5. 笔记检索与列表 (GET /api/notes)
        if (path === '/api/notes' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const search = url.searchParams.get('q') || '';
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

          const result = await listNotes(env.DB, { search, limit, offset });
          return json({ success: true, ...result });
        }

        // 6. 单篇笔记操作 (GET, DELETE, 更新感想)
        if (path.startsWith('/api/notes/')) {
          const subPath = path.slice('/api/notes/'.length);
          const parts = subPath.split('/');
          const noteId = decodeURIComponent(parts[0]);

          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          // 更新感想: PUT /api/notes/:id/thoughts
          if (parts[1] === 'thoughts' && request.method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const res = await updateThoughts(env.DB, noteId, body.thoughts);
            return json({ success: true, ...res });
          }

          // 删除单篇: DELETE /api/notes/:id
          if (request.method === 'DELETE') {
            const success = await deleteNote(env, noteId);
            return json({ success });
          }

          // 查看单篇: GET /api/notes/:id
          if (request.method === 'GET') {
            const note = await getNote(env.DB, noteId);
            if (!note) return json({ success: false, message: "笔记不存在" }, 404);
            return json({ success: true, note });
          }
        }

        // 7. 手动或显式转存归档 (POST /api/archive)
        if (path === '/api/archive' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const pin = request.headers.get('x-auth-pin') || body.pin;
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          if (!body.note) return json({ success: false, message: "缺少笔记数据" }, 400);
          const result = await archiveNote(env, body.note);
          return json({ success: true, result });
        }

        // 8. 核心解析与下载路由 (Node.js 引擎)
        if (Object.hasOwn(nodeRoutes, path)) {
          const resp = await parseWithFallback(request, env, nativeRequest => invokeHandler(nodeRoutes[path], nativeRequest));

          // 如果是解析成功的请求，自动后台静默转存到 R2 和 D1
          if (path === '/api/parse' && resp.status === 200 && env.DB && env.R2_BUCKET) {
            try {
              const clone = resp.clone();
              const parsed = await clone.json();
              if (parsed?.success && (parsed?.images?.length || parsed?.videos?.length)) {
                const bgTask = archiveNote(env, {
                  noteId: parsed.noteId || parsed.id || `xhs_${Date.now()}`,
                  title: parsed.title,
                  content: parsed.content,
                  sourceUrl: parsed.sourceUrl || "",
                  images: parsed.images || [],
                  videos: parsed.videos || []
                }).catch(err => console.error("Auto archive background error:", err));

                if (ctx?.waitUntil) {
                  ctx.waitUntil(bgTask);
                }
              }
            } catch (err) {
              console.warn("Parse response inspection error:", err);
            }
          }

          return resp;
        }

        // 9. 静态前端页面托管 (由 Cloudflare Assets 提供)
        if (env.ASSETS?.fetch) {
          return await env.ASSETS.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
      } catch (error) {
        console.error("Worker handler error:", error);
        return json({
          success: false,
          message: error.message || "服务发生异常，请稍后重试。"
        }, 500);
      }
    }
  };
}

export default createWorker();
