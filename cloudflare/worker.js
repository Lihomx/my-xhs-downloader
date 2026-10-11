import parse from '../api/parse.js';
import image from '../api/image.js';
import video from '../api/video.js';
import packageInfo from '../package.json' with { type: 'json' };
import { parseWithFallback } from './parse-fallback.js';
import { invokeHandler } from './http-adapter.js';
import { normalizeCookieString } from '../lib/xhs.js';
import {
  initDb,
  verifyPin,
  changePin,
  getSetting,
  setSetting,
  archiveNote,
  listNotes,
  getNote,
  updateThoughts,
  deleteNote,
  serveMedia,
  getTagsWithCounts,
  addCustomTag,
  renameCustomTag,
  deleteCustomTag,
  updateNoteTags,
  updateTranscript
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

        // 4. 读取 / 保存通用设置 (包括 PIN 码、小红书 Cookie 与第三方 AI Key)
        if (path === '/api/settings') {
          if (request.method === 'GET') {
            const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
            const isAuthed = await verifyPin(env.DB, pin);
            if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);
            const xhsCookie = await getSetting(env.DB, 'xhs_cookie', '');
            const whisperApiKey = await getSetting(env.DB, 'whisper_api_key', '');
            const whisperApiEndpoint = await getSetting(env.DB, 'whisper_api_endpoint', '');
            return json({
              success: true,
              hasCookie: Boolean(xhsCookie),
              xhsCookie,
              whisperApiKey,
              whisperApiEndpoint,
              hasCloudflareAi: Boolean(env.AI)
            });
          }

          if (request.method === 'POST') {
            const body = await request.json().catch(() => ({}));
            const pin = request.headers.get('x-auth-pin') || body.pin || body.oldPin;
            const isAuthed = await verifyPin(env.DB, pin);
            if (!isAuthed) return json({ success: false, message: "原 PIN 码验证失败" }, 401);

            if (body.newPin) {
              await changePin(env.DB, pin, body.newPin);
            }
            if (typeof body.xhsCookie === 'string') {
              const cleanCookie = normalizeCookieString(body.xhsCookie);
              await setSetting(env.DB, 'xhs_cookie', cleanCookie);
            }
            if (typeof body.whisperApiKey === 'string') {
              await setSetting(env.DB, 'whisper_api_key', body.whisperApiKey.trim());
            }
            if (typeof body.whisperApiEndpoint === 'string') {
              await setSetting(env.DB, 'whisper_api_endpoint', body.whisperApiEndpoint.trim());
            }
            return json({ success: true, message: "设置已保存成功" });
          }
        }

        // 4.1 视频语音转写文本 (POST /api/transcribe)
        if (path === '/api/transcribe' && request.method === 'POST') {
          const pin = request.headers.get('x-auth-pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const audioBuffer = await request.arrayBuffer();
          if (!audioBuffer || audioBuffer.byteLength === 0) {
            return json({ success: false, message: "未接收到音频数据" }, 400);
          }

          // 优先检查第三方 Whisper API Key (如 Groq / OpenAI)
          let thirdPartyKey = '';
          let thirdPartyEndpoint = '';
          if (env.DB) {
            thirdPartyKey = await getSetting(env.DB, 'whisper_api_key', '');
            thirdPartyEndpoint = await getSetting(env.DB, 'whisper_api_endpoint', '');
          }

          if (thirdPartyKey) {
            try {
              const endpoint = thirdPartyEndpoint || 'https://api.groq.com/openai/v1/audio/transcriptions';
              const formData = new FormData();
              formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
              formData.append('model', endpoint.includes('groq') ? 'whisper-large-v3' : 'whisper-1');
              formData.append('language', 'zh');
              formData.append('response_format', 'json');

              const aiRes = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${thirdPartyKey.trim()}`
                },
                body: formData
              });

              if (aiRes.ok) {
                const aiData = await aiRes.json();
                return json({ success: true, text: aiData.text || '', provider: 'third-party' });
              } else {
                const errText = await aiRes.text();
                console.warn("Third-party Whisper API response not ok:", errText);
              }
            } catch (err) {
              console.warn("Third-party Whisper API call error:", err);
            }
          }

          // 默认使用 Cloudflare Workers AI 原生 Whisper-large-v3-turbo 模型
          if (env.AI) {
            try {
              const aiResp = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
                audio: [...new Uint8Array(audioBuffer)],
                task: 'transcribe',
                language: 'zh'
              });
              return json({ success: true, text: aiResp.text || '', provider: 'cloudflare-ai' });
            } catch (err) {
              console.error("Cloudflare Workers AI run error:", err);
              return json({ success: false, message: `Cloudflare AI 转写出错: ${err.message}` }, 500);
            }
          }

          return json({
            success: false,
            message: "未检测到可用的 AI 语音转写服务。请在设置中配置第三方 Whisper API Key (如 Groq / OpenAI)，或开启 Cloudflare Workers AI 绑定。"
          }, 503);
        }

        // 兼容旧接口：修改 PIN 码
        if (path === '/api/change-pin' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          await changePin(env.DB, body.oldPin, body.newPin);
          return json({ success: true, message: "PIN 码修改成功" });
        }

        // 4.5. 分类标签体系 (GET /api/tags, POST /api/tags)
        if (path === '/api/tags' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const result = await getTagsWithCounts(env.DB);
          return json({ success: true, ...result });
        }

        if (path === '/api/tags' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const pin = request.headers.get('x-auth-pin') || body.pin;
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const action = body.action || 'add';
          if (action === 'add') {
            const tags = await addCustomTag(env.DB, body.tag);
            return json({ success: true, tags });
          } else if (action === 'rename') {
            const tags = await renameCustomTag(env.DB, body.tag, body.newTag);
            return json({ success: true, tags });
          } else if (action === 'delete') {
            const tags = await deleteCustomTag(env.DB, body.tag);
            return json({ success: true, tags });
          }
          return json({ success: false, message: "未知标签操作" }, 400);
        }

        // 5. 笔记检索与列表 (GET /api/notes)
        if (path === '/api/notes' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const search = url.searchParams.get('q') || '';
          const tag = url.searchParams.get('tag') || '';
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

          const result = await listNotes(env.DB, { search, tag, limit, offset });
          return json({ success: true, ...result });
        }

        // 6. 单篇笔记操作 (GET, DELETE, 更新感想, 更新标签)
        if (path.startsWith('/api/notes/')) {
          const subPath = path.slice('/api/notes/'.length);
          const parts = subPath.split('/');
          const noteId = decodeURIComponent(parts[0]);

          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          // 更新标签: PUT /api/notes/:id/tags
          if (parts[1] === 'tags' && request.method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const res = await updateNoteTags(env.DB, noteId, body.tags || []);
            return json({ success: true, ...res });
          }

          // 更新感想: PUT /api/notes/:id/thoughts
          if (parts[1] === 'thoughts' && request.method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const res = await updateThoughts(env.DB, noteId, body.thoughts);
            return json({ success: true, ...res });
          }

          // 更新语音文案: PUT /api/notes/:id/transcript
          if (parts[1] === 'transcript' && request.method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const res = await updateTranscript(env.DB, noteId, body.transcript);
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
          let reqToProcess = request;
          if (path === '/api/parse' && !request.headers.get('x-xhs-cookie') && env.DB) {
            const savedCookie = await getSetting(env.DB, 'xhs_cookie', '');
            if (savedCookie) {
              const headers = new Headers(request.headers);
              headers.set('x-xhs-cookie', savedCookie);
              reqToProcess = new Request(request, { headers });
            }
          }

          const resp = await parseWithFallback(reqToProcess, env, nativeRequest => invokeHandler(nodeRoutes[path], nativeRequest));

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
