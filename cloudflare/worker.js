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
  updateTranscript,
  updateAiSummary,
  recordExtractionFailure,
  updateNoteDetail,
  deleteNoteMedia,
  saveNoteAudio,
  toggleNoteShuffle,
  getShuffleNotes,
  getPendingSubtitleNotes,
  getExtractionTasks,
  setExtractionMode,
  updateNoteAuthor,
  getAuthorsWithCounts,
  getStorageUsage,
  importFlashcardsFromNote,
  getFlashcardStats,
  getDueFlashcards,
  getFlashcardsList,
  reviewFlashcard,
  updateFlashcard,
  splitFlashcard,
  deleteFlashcard,
  generateAiClozeSuggestions
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
        // 1. 媒体静态资源代理 (来自 R2，支持 Range 206 自由拖拽和离线缓存)
        if (path.startsWith('/api/media/')) {
          const key = decodeURIComponent(path.slice('/api/media/'.length));
          return await serveMedia(env.R2_BUCKET, key, request);
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
        // 4. 读取 / 保存通用设置 (包括 PIN 码、小红书 Cookie 与 AI 语音引擎配置)
        if (path === '/api/settings') {
          if (request.method === 'GET') {
            const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
            const isAuthed = await verifyPin(env.DB, pin);
            if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);
            const xhsCookie = await getSetting(env.DB, 'xhs_cookie', '');
            const whisperProvider = await getSetting(env.DB, 'whisper_provider', '');
            const whisperApiKey = await getSetting(env.DB, 'whisper_api_key', '');
            const whisperApiEndpoint = await getSetting(env.DB, 'whisper_api_endpoint', '');
            const autoBgOcr = await getSetting(env.DB, 'auto_bg_ocr', 'true');
            const effectiveProvider = whisperProvider || (whisperApiKey ? 'groq' : 'cloudflare');
            return json({
              success: true,
              hasCookie: Boolean(xhsCookie),
              xhsCookie,
              whisperProvider: effectiveProvider,
              whisperApiKey,
              whisperApiEndpoint,
              autoBgOcr: autoBgOcr !== 'false',
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
            if (typeof body.whisperProvider === 'string') {
              await setSetting(env.DB, 'whisper_provider', body.whisperProvider.trim());
            }
            if (typeof body.whisperApiKey === 'string') {
              await setSetting(env.DB, 'whisper_api_key', body.whisperApiKey.trim());
            }
            if (typeof body.whisperApiEndpoint === 'string') {
              await setSetting(env.DB, 'whisper_api_endpoint', body.whisperApiEndpoint.trim());
            }
            if (typeof body.autoBgOcr === 'boolean' || typeof body.autoBgOcr === 'string') {
              await setSetting(env.DB, 'auto_bg_ocr', String(body.autoBgOcr) === 'false' ? 'false' : 'true');
            }
            return json({ success: true, message: "设置已保存成功" });
          }
        }

        // 4.0.1 测试第三方 Whisper API Key 连通性 (POST /api/test-whisper-key)
        if (path === '/api/test-whisper-key' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const key = (body.key || '').trim();
          const provider = body.provider || 'groq';
          const endpoint = (body.endpoint || '').trim();

          if (!key) {
            return json({ success: false, message: "请输入 API Key 后再进行测试" }, 400);
          }

          try {
            const testUrl = (provider === 'custom' && endpoint)
              ? (endpoint.includes('/audio/transcriptions') ? endpoint.replace('/audio/transcriptions', '/models') : endpoint)
              : 'https://api.groq.com/openai/v1/models';

            const testRes = await fetch(testUrl, {
              headers: {
                Authorization: `Bearer ${key}`
              }
            });

            if (testRes.ok) {
              return json({
                success: true,
                message: provider === 'groq'
                  ? "Groq API Key 验证通过！LPU 极速芯片已就绪连接。"
                  : "API Key 验证通过！模型接口连接正常。"
              });
            } else {
              const errData = await testRes.json().catch(() => ({}));
              const errMsg = errData.error?.message || `HTTP ${testRes.status} 验证未通过`;
              return json({ success: false, message: `验证未通过: ${errMsg}` }, 400);
            }
          } catch (err) {
            return json({ success: false, message: `网络连接异常: ${err.message}` }, 500);
          }
        }

        // 辅助方法：过滤 Whisper 幻觉（如提示词复读、YouTube 片尾字幕、重复死循环等）
        function cleanWhisperHallucinations(text) {
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

          // 连续相同短语重复死循环消除 (Whisper 重复循环幻觉)
          cleaned = cleaned.replace(/(.{2,40}?)\1{2,}/g, (match, g1) => {
            if (match.length >= g1.length * 4) return "";
            return g1;
          });

          return cleaned.trim();
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

          let whisperProvider = '';
          let thirdPartyKey = '';
          let thirdPartyEndpoint = '';
          if (env.DB) {
            whisperProvider = await getSetting(env.DB, 'whisper_provider', '');
            thirdPartyKey = await getSetting(env.DB, 'whisper_api_key', '');
            thirdPartyEndpoint = await getSetting(env.DB, 'whisper_api_endpoint', '');
          }

          // 自动判断生效引擎：只要配置了有效 Groq Key，优先选用极速高准确率的 Groq Large-v3 引擎
          const effectiveProvider = (whisperProvider === 'custom')
            ? 'custom'
            : (thirdPartyKey ? 'groq' : (whisperProvider || 'cloudflare'));

          // 接收客户端可选传递的上下文参数与调优配置
          const rawPrompt = request.headers.get('x-whisper-prompt');
          let clientPrompt = '';
          if (rawPrompt) {
            try { clientPrompt = decodeURIComponent(rawPrompt); } catch { clientPrompt = rawPrompt; }
          }
          const clientTemp = request.headers.get('x-whisper-temperature') || '0.2';
          const clientModel = request.headers.get('x-whisper-model');

          // 分支 A: 选用 Groq 或 自定义第三方
          if (effectiveProvider === 'groq' || effectiveProvider === 'custom') {
            if (!thirdPartyKey) {
              return json({
                success: false,
                message: `已选用 ${effectiveProvider === 'groq' ? 'Groq' : '第三方'} 语音引擎，但未检测到有效 API Key。请在系统设置中填入 Key，或选择 Cloudflare 内置模型。`
              }, 400);
            }

            try {
              const endpoint = thirdPartyEndpoint || 'https://api.groq.com/openai/v1/audio/transcriptions';
              const isGroq = endpoint.includes('groq') || effectiveProvider === 'groq';
              const targetModel = clientModel || (isGroq ? 'whisper-large-v3' : 'whisper-1');
              const formData = new FormData();
              
              // 构造标准 WAV 文件体
              const audioFile = typeof File !== 'undefined'
                ? new File([audioBuffer], 'audio.wav', { type: 'audio/wav' })
                : new Blob([audioBuffer], { type: 'audio/wav' });
              formData.append('file', audioFile, 'audio.wav');
              
              formData.append('model', targetModel);
              formData.append('language', 'zh');
              formData.append('temperature', clientTemp);
              formData.append('response_format', 'verbose_json');
              if (clientPrompt) {
                formData.append('prompt', clientPrompt);
              } else {
                formData.append('prompt', '普通话视频对话录音，请完整转写所有口述内容。');
              }

              let aiRes = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${thirdPartyKey.trim()}`
                },
                body: formData
              });

              // 如果 Groq whisper-large-v3 遇到偶发异常且不是 401，自动切换至 whisper-large-v3-turbo 快速兜底
              if (!aiRes.ok && isGroq && targetModel === 'whisper-large-v3' && aiRes.status !== 401) {
                try {
                  const retryFormData = new FormData();
                  retryFormData.append('file', audioFile, 'audio.wav');
                  retryFormData.append('model', 'whisper-large-v3-turbo');
                  retryFormData.append('language', 'zh');
                  retryFormData.append('temperature', clientTemp);
                  retryFormData.append('response_format', 'verbose_json');
                  if (clientPrompt) retryFormData.append('prompt', clientPrompt);

                  const turboRes = await fetch(endpoint, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${thirdPartyKey.trim()}` },
                    body: retryFormData
                  });
                  if (turboRes.ok) {
                    aiRes = turboRes;
                  }
                } catch (retryErr) {
                  console.warn("Groq whisper-large-v3-turbo retry error:", retryErr);
                }
              }

              if (aiRes.ok) {
                const aiData = await aiRes.json();
                const rawRecognized = aiData.text || '';
                const cleanedText = cleanWhisperHallucinations(rawRecognized);
                const segments = (aiData.segments || []).map(s => ({
                  start: typeof s.start === 'number' ? s.start : 0,
                  end: typeof s.end === 'number' ? s.end : 0,
                  text: cleanWhisperHallucinations(s.text || '')
                })).filter(s => Boolean(s.text.trim()));

                return json({
                  success: true,
                  text: cleanedText,
                  segments,
                  provider: isGroq ? 'groq' : 'custom',
                  model: isGroq ? 'whisper-large-v3' : 'whisper-1'
                });
              } else {
                const errText = await aiRes.text();
                console.warn("Third-party Whisper API response not ok (will fallback if env.AI exists):", errText);
                if (!env.AI) {
                  let parsedErr = errText;
                  try { parsedErr = JSON.parse(errText).error?.message || errText; } catch {}
                  return json({
                    success: false,
                    message: `${isGroq ? 'Groq' : '第三方'} 语音识别失败 (HTTP ${aiRes.status}): ${parsedErr}`
                  }, 502);
                }
              }
            } catch (err) {
              console.warn("Third-party Whisper API call error (will fallback if env.AI exists):", err);
              if (!env.AI) {
                return json({
                  success: false,
                  message: `${effectiveProvider === 'groq' ? 'Groq' : '第三方'} 服务连接出错: ${err.message}`
                }, 502);
              }
            }
          }

          // 分支 B: 选用 Cloudflare Workers AI 原生 Whisper 模型
          if (env.AI) {
            const errors = [];
            const uint8 = new Uint8Array(audioBuffer);

            // 策略 1: 优先使用 @cf/openai/whisper-large-v3-turbo (800M 大模型)
            try {
              const aiResp = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
                audio: uint8
              });
              if (aiResp && typeof aiResp.text === 'string') {
                return json({ success: true, text: cleanWhisperHallucinations(aiResp.text || ''), provider: 'cloudflare', model: 'whisper-large-v3-turbo' });
              }
            } catch (err) {
              errors.push(`turbo-uint8: ${err.message}`);
            }

            // 策略 2: 降级使用 @cf/openai/whisper (轻量基础模型)
            try {
              const aiResp = await env.AI.run('@cf/openai/whisper', {
                audio: uint8
              });
              if (aiResp && typeof aiResp.text === 'string') {
                return json({ success: true, text: cleanWhisperHallucinations(aiResp.text || ''), provider: 'cloudflare', model: 'whisper-base' });
              }
            } catch (err) {
              errors.push(`whisper-uint8: ${err.message}`);
            }

            // 策略 3: 如果音频体积较小 (<= 1.5MB)，降级使用 number[] 数组
            if (audioBuffer.byteLength <= 1.5 * 1024 * 1024) {
              try {
                const aiResp = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
                  audio: Array.from(uint8)
                });
                if (aiResp && typeof aiResp.text === 'string') {
                  return json({ success: true, text: cleanWhisperHallucinations(aiResp.text || ''), provider: 'cloudflare', model: 'whisper-large-v3-turbo' });
                }
              } catch (err) {
                errors.push(`turbo-array: ${err.message}`);
              }
            }

            // 策略 4: Base64 编码方式 (适用于 turbo 模型的 Base64 规范)
            if (audioBuffer.byteLength <= 4 * 1024 * 1024) {
              try {
                let binary = '';
                const len = uint8.byteLength;
                for (let i = 0; i < len; i += 8192) {
                  binary += String.fromCharCode.apply(null, uint8.subarray(i, Math.min(i + 8192, len)));
                }
                const base64Audio = btoa(binary);

                const aiResp = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
                  audio: base64Audio
                });
                if (aiResp && typeof aiResp.text === 'string') {
                  return json({ success: true, text: cleanWhisperHallucinations(aiResp.text || ''), provider: 'cloudflare', model: 'whisper-large-v3-turbo' });
                }
              } catch (err) {
                errors.push(`turbo-base64: ${err.message}`);
              }
            }

            return json({ success: false, message: `Cloudflare AI 转写出错: ${errors.join(' | ')}` }, 500);
          }

          return json({
            success: false,
            message: "未检测到可用的 AI 语音转写服务。请在设置中配置 Groq API Key，或开启 Cloudflare Workers AI 绑定。"
          }, 503);
        }


        // 智能标点符号恢复与 AI 错别字校对接口: POST /api/punctuate
        if (path === '/api/punctuate' && request.method === 'POST') {
          const pin = request.headers.get('x-auth-pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const body = await request.json().catch(() => ({}));
          const rawText = String(body.text || '').trim();
          if (!rawText) return json({ success: false, message: "文本不能为空" }, 400);

          let punctuatedText = '';
          const systemPrompt = `你是一个专业的中文口语整理、短视频字幕精修与语音识别（ASR）深度纠错大师。
你将接收一段由短视频语音识别生成的口语文本，其中可能包含发音相近的同音错别字（如将“狗狗雨衣”误识别为“狗狗羽衣”、“第一个品”误识别为“第一、的”）、语序口语化混乱、缺少标点或多余口语填充词（如“呀/但是”）。

核心规则与任务：
1. 【严格保留时间戳标记】：若输入的每一行开头带有形如 [00:50] 或 [⏱ 00:50] 的时间戳标记，你必须原原本本地为该行保留原时间戳前缀，严禁篡改、错位、重排或删除任何时间戳！
2. 【强力纠正同音错别字与行业词】：结合上下文商业、生活、电商卖货、创业、宠物、职场、知识等语境，智能将口语同音字误识（例如“羽衣”->“雨衣”、“气权”->“弃权”、“打薄”->“赌博”）自动纠正为准确的标准中文词汇。
3. 【精细标点与自然断句】：疑问句务必补充全角问号「？」，陈述句补充全角句号「。」，短暂停顿补充逗号「，」，使语句通顺、阅读节奏极佳。
4. 【消除口吃复读与死循环】：自动清理无意义的卡顿复读词，理顺倒装口语。
5. 【核心排版】：每一个带时间戳的完整句子单独成一行。
6. 【严禁多余废话】：严禁输出任何前言、解释说明、自我介绍或 markdown 标记，直接输出整理纠正后的纯文本：`;

          // 优先策略 1: 如果配置了 Groq API Key，使用 Groq 极速大模型 (优先 70B 大模型 llama-3.3-70b-versatile，兜底 llama-3.1-8b-instant)
          let thirdPartyKey = '';
          if (env.DB) {
            thirdPartyKey = await getSetting(env.DB, 'whisper_api_key', '');
          }

          if (thirdPartyKey) {
            const modelsToTry = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
            for (const model of modelsToTry) {
              try {
                const groqChatRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${thirdPartyKey.trim()}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    model,
                    messages: [
                      { role: 'system', content: systemPrompt },
                      { role: 'user', content: rawText }
                    ],
                    temperature: 0.1,
                    max_tokens: 8192
                  })
                });
                if (groqChatRes.ok) {
                  const groqData = await groqChatRes.json();
                  const reply = groqData.choices?.[0]?.message?.content?.trim();
                  if (reply && reply.length >= rawText.length * 0.7) {
                    punctuatedText = reply;
                    break;
                  }
                }
              } catch (err) {
                console.warn(`Groq LLM model ${model} error:`, err);
              }
            }
          }

          // 策略 2: 降级使用 Cloudflare Workers AI 原生大语言模型
          if (!punctuatedText && env.AI) {
            const candidateModels = [
              '@cf/meta/llama-3.3-70b-instruct',
              '@cf/meta/llama-3.2-3b-instruct',
              '@cf/qwen/qwen3-30b-a3b-fp8'
            ];
            for (const model of candidateModels) {
              try {
                const aiRes = await env.AI.run(model, {
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: rawText }
                  ],
                  max_tokens: 4096,
                  temperature: 0.1
                });
                const reply = (aiRes && (aiRes.response || aiRes.text || ''))?.trim();
                if (reply && reply.length >= rawText.length * 0.6) {
                  punctuatedText = reply;
                  break;
                }
              } catch (e) {
                console.warn(`Punctuate model ${model} error:`, e.message);
              }
            }
          }

          if (body.noteId && env.DB && punctuatedText) {
            try {
              await updateTranscript(env.DB, body.noteId, punctuatedText);
            } catch (e) {
              console.warn("Auto update transcript in db failed:", e);
            }
          }

          return json({
            success: true,
            text: punctuatedText || rawText
          });
        }

        // 4.2.1 AI 深度精读总结接口: POST /api/ai-summarize 或 POST /api/notes/:id/ai-summary
        if ((path === '/api/ai-summarize' || /^\/api\/notes\/[^\/]+\/ai-summary$/.test(path)) && request.method === 'POST') {
          const pin = request.headers.get('x-auth-pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const body = await request.json().catch(() => ({}));
          const noteIdMatch = path.match(/^\/api\/notes\/([^\/]+)\/ai-summary$/);
          const noteId = noteIdMatch ? noteIdMatch[1] : (body.noteId || "");

          let title = body.title || "";
          let content = body.content || "";
          let transcript = body.transcript || "";
          let tags = Array.isArray(body.tags) ? body.tags : [];

          // 若缺少部分字段且有 noteId，从数据库补全
          if (noteId && env.DB && (!title || !transcript)) {
            try {
              const row = await env.DB.prepare("SELECT title, content, transcript, tags_json FROM notes WHERE id = ?").bind(noteId).first();
              if (row) {
                if (!title) title = row.title || "";
                if (!content) content = row.content || "";
                if (!transcript) transcript = row.transcript || "";
                if (!tags.length && row.tags_json) {
                  try { tags = JSON.parse(row.tags_json); } catch {}
                }
              }
            } catch (e) {
              console.warn("Load note for summary failed:", e);
            }
          }

          // 净化逐字稿文本（去除内部 HTML 标签、时间戳与多余空行）
          const cleanTranscript = (transcript || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, "")
            .replace(/⏱️\s*\d{1,2}:\d{2}/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 12000);

          if (!title && !content && !cleanTranscript) {
            return json({ success: false, message: "缺少笔记正文或语音文案" }, 400);
          }

          const systemPrompt = `你是一位世界顶级的知识萃取与思维模型专家（类似小红书“点点”官方精读助手的强化进化版）。
你的任务是对用户提供的笔记标题、正文及音视频逐字稿进行“深度脱水与结构化萃取”。

请严格遵循以下输出规范，输出高信息密度、逻辑极强、排版优美优雅的 Markdown：

### 💡 核心观点
- 用 1~2 句话直接点出本质认知与核心论点，直击本质，拒绝废话。

### 📌 核心知识框架与公式拆解
- 提炼出内容中的核心方法论、公式模型、思维步骤或关键维度（如：1. SCQA 汇报法、2. FAB 说服法、3. BACC 反馈法、4. PREP 表达法 等）。
- 每个要点均必须包含：【名称 + 适用场景】、【核心逻辑链条（如 A→B→C）】、【关键实操要领】。
- 格式统一使用标准编号列表（1. 2. 3. ...），要点名称使用加粗 **名称**，务必条理分明，方便读者理解与一键转为复习闪卡。

### 🎯 实操落地建议与避坑复盘
- 给出 2~3 条可直接落地执行的行动清单、注意事项或刻意练习复盘法则。
`;

          const userPrompt = `【笔记标题】：${title || '未命名笔记'}
${tags && tags.length ? `【标签分类】：${tags.join('、')}\n` : ''}【正文描述】：
${content || '（无附带正文）'}

【视频/音频完整文案逐字稿】：
${cleanTranscript || '（暂无音频文案，请基于正文与标题提炼）'}

请为我进行深度知识萃取，生成高品质结构化总结。`;

          let summaryText = "";
          let modelUsed = "";

          // 策略 1: 优先使用 Groq 70B 大模型 (速度极快，知识整理能力顶级)
          let thirdPartyKey = '';
          if (env.DB) thirdPartyKey = await getSetting(env.DB, 'whisper_api_key', '');

          if (thirdPartyKey) {
            const modelsToTry = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];
            for (const m of modelsToTry) {
              try {
                const groqChatRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${thirdPartyKey.trim()}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    model: m,
                    messages: [
                      { role: 'system', content: systemPrompt },
                      { role: 'user', content: userPrompt }
                    ],
                    temperature: 0.2,
                    max_tokens: 3500
                  })
                });
                if (groqChatRes.ok) {
                  const groqData = await groqChatRes.json();
                  const reply = groqData.choices?.[0]?.message?.content?.trim();
                  if (reply && reply.length >= 30) {
                    summaryText = reply;
                    modelUsed = `Groq (${m})`;
                    break;
                  }
                }
              } catch (err) {
                console.warn(`Groq summary model ${m} error:`, err);
              }
            }
          }

          // 策略 2: 降级使用 Cloudflare Workers AI 原生大语言模型
          if (!summaryText && env.AI) {
            const cfModels = [
              '@cf/meta/llama-3.3-70b-instruct',
              '@cf/qwen/qwen3-30b-a3b-fp8',
              '@cf/meta/llama-3.2-3b-instruct'
            ];
            for (const cfM of cfModels) {
              try {
                const aiRes = await env.AI.run(cfM, {
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                  ],
                  max_tokens: 3000,
                  temperature: 0.2
                });
                const reply = (aiRes && (aiRes.response || aiRes.text || ''))?.trim();
                if (reply && reply.length >= 30) {
                  summaryText = reply;
                  modelUsed = `Cloudflare AI (${cfM.split('/').pop()})`;
                  break;
                }
              } catch (e) {
                console.warn(`CF summary model ${cfM} error:`, e.message);
              }
            }
          }

          if (!summaryText) {
            return json({ success: false, message: "AI 总结服务生成超时或未响应，请稍后重试" }, 500);
          }

          // 持久化缓存至数据库
          if (noteId && env.DB) {
            try {
              await updateAiSummary(env.DB, noteId, summaryText);
            } catch (e) {
              console.warn("Save ai_summary failed:", e);
            }
          }

          return json({
            success: true,
            summary: summaryText,
            provider: modelUsed
          });
        }

        // 4.3 视频画面硬字幕视觉识别接口: POST /api/ocr-subtitle
        if (path === '/api/ocr-subtitle' && request.method === 'POST') {
          const pin = request.headers.get('x-auth-pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const body = await request.json().catch(() => ({}));
          const imageDataUrl = body.image || ''; // data:image/jpeg;base64,...
          if (!imageDataUrl) return json({ success: false, message: "缺少图像数据" }, 400);

          let thirdPartyKey = '';
          if (env.DB) thirdPartyKey = await getSetting(env.DB, 'whisper_api_key', '');

          let lastOcrError = '';

          // 策略 1: 优先使用 Groq 多模态视觉模型 (优先 qwen/qwen3.8-27b，次级回退 llama-3.2 系列)
          if (thirdPartyKey) {
            const groqVisionModels = [
              'qwen/qwen3.8-27b',
              'llama-3.2-90b-vision-preview',
              'meta-llama/llama-3.2-11b-vision-instruct',
              'llama-3.2-11b-vision-preview'
            ];

            for (const model of groqVisionModels) {
              try {
                const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${thirdPartyKey.trim()}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    model,
                    messages: [
                      {
                        role: 'user',
                        content: [
                          {
                            type: 'text',
                            text: '请仔细识别图片中显示的视频中文字幕。如果图片包含带时间戳标签如 [00:10] 的条目，请严格按行输出：[时间戳] 字幕文字。严禁输出数字列表编号（不要以 1. 2. 开头），严禁使用加粗符（不要使用 **），直接输出原文字幕。如果画面中没有制作字幕或只有背景，直接回复 NONE。严禁输出任何多余废话或解释说明。'
                          },
                          {
                            type: 'image_url',
                            image_url: { url: imageDataUrl }
                          }
                        ]
                      }
                    ],
                    temperature: 0.1,
                    max_tokens: 180
                  })
                });

                if (groqRes.ok) {
                  const groqData = await groqRes.json();
                  let text = (groqData.choices?.[0]?.message?.content || '').trim();
                  // 剥离可能生成的 markdown 数字列表前缀与加粗符号
                  text = text.replace(/^\d+[\.、\s\-*#:]+/gm, '').replace(/\*\*/g, '').trim();
                  const cleaned = (text.includes('NONE') || text.includes('无字幕')) && text.length < 15 ? '' : text;
                  return json({
                    success: true,
                    text: cleaned,
                    provider: `groq-vision (${model})`
                  });
                } else {
                  const errText = await groqRes.text().catch(() => '');
                  lastOcrError = `Groq ${model} (${groqRes.status}): ${errText.slice(0, 100)}`;
                  console.warn(lastOcrError);
                  if (groqRes.status === 429) {
                    // 遇到 429 频率限制时，跳过 Groq 后续模型，立刻尝试 Cloudflare Workers AI 降级
                    break;
                  }
                }
              } catch (err) {
                lastOcrError = `Groq ${model} network error: ${err.message}`;
                console.warn(lastOcrError);
              }
            }
          }

          // 策略 2: 降级使用 Cloudflare Workers AI 视觉模型 (仅保留具有视觉指令能力的真实大模型，坚决剔除 llava/moondream 等仅输出画面描述词的非 OCR 模型)
          if (env.AI) {
            const cfVisionModels = [
              '@cf/meta/llama-3.2-11b-vision-instruct'
            ];

            const pureBase64 = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
            const binary = atob(pureBase64);
            const uint8 = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);
            const imageBytes = Array.from(uint8);

            for (const cfModel of cfVisionModels) {
              try {
                let aiRes;
                try {
                  aiRes = await env.AI.run(cfModel, {
                    image: imageBytes,
                    prompt: '仔细识别图片中的所有中文字幕，按行输出字幕内容。不要输出数字列表编号，不要使用加粗符号。如果画面没有字幕文字请回复 NONE。不要输出多余解释。'
                  });
                } catch (firstErr) {
                  // 针对 Meta Llama 3.2 首次调用需授权 'agree' 握手的错误码 5016 自动处理
                  if (String(firstErr.message).includes('5016') || String(firstErr.message).includes('agree')) {
                    console.log(`Submitting license agree prompt for ${cfModel}...`);
                    await env.AI.run(cfModel, { prompt: 'agree' }).catch(() => {});
                    aiRes = await env.AI.run(cfModel, {
                      image: imageBytes,
                      prompt: '仔细识别图片中的所有中文字幕，按行输出字幕内容。不要输出数字列表编号，不要使用加粗符号。如果画面没有字幕文字请回复 NONE。不要输出多余解释。'
                    });
                  } else {
                    throw firstErr;
                  }
                }

                let text = (aiRes && (aiRes.response || aiRes.description || ''))?.trim();
                if (!text) continue;
                text = text.replace(/^\d+[\.、\s\-*#:]+/gm, '').replace(/\*\*/g, '').trim();
                // 过滤画面描述类幻觉（如“女性在台上发言”、“握手的女孩”、“红色礼服”等非字幕内容）
                if (/(?:女性在|她在|身穿|握手的|红色礼服|图[片中]是|一[位名]人)/.test(text)) {
                  console.warn("Filtered out image caption hallucination:", text);
                  continue;
                }
                const cleaned = (text.includes('NONE') || text === '无' || text.includes('无字幕')) && text.length < 15 ? '' : text;
                return json({
                  success: true,
                  text: cleaned,
                  provider: `cloudflare-vision (${cfModel.split('/').pop()})`
                });
              } catch (e) {
                lastOcrError = `CF Vision ${cfModel}: ${e.message}`;
                console.warn(lastOcrError);
              }
            }
          }

          const isRateLimit = lastOcrError.includes("429") || lastOcrError.includes("Rate limit");
          const friendlyMessage = isRateLimit
            ? "视觉模型接口已达单日调用上限 (Rate Limit)，建议使用语音识别"
            : (lastOcrError.includes("5016") ? "视觉模型授权中，建议使用语音识别" : (lastOcrError ? lastOcrError.slice(0, 120) : "未配置可用视觉模型"));

          return json({
            success: false,
            isRateLimit,
            message: friendlyMessage
          }, isRateLimit ? 429 : 500);
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

        // 4.6. Cloudflare 资源用量与免费额度监控 (GET /api/usage)
        if (path === '/api/usage' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const forceRefresh = url.searchParams.get('refresh') === '1' || url.searchParams.get('force') === 'true';
          const usage = await getStorageUsage(env, { forceRefresh });
          return json({ success: true, ...usage });
        }

        // 5. 笔记检索与列表 (GET /api/notes)
        if (path === '/api/notes' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const search = url.searchParams.get('q') || '';
          const tag = url.searchParams.get('tag') || '';
          const author = url.searchParams.get('author') || '';
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

          const result = await listNotes(env.DB, { search, tag, author, limit, offset });
          return json({ success: true, ...result });
        }

        // 5.1 获取随机播放库中的全部音频笔记: GET /api/shuffle-notes
        if (path === '/api/shuffle-notes' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const items = await getShuffleNotes(env.DB);
          return json({ success: true, items });
        }

        // 5.2 获取所有笔记博主分类及统计: GET /api/authors
        if (path === '/api/authors' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const data = await getAuthorsWithCounts(env.DB);
          return json({ success: true, ...data });
        }

        // 5.3 获取未识别博主的笔记列表 (用于批量补全): GET /api/notes-missing-authors
        if (path === '/api/notes-missing-authors' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const rows = await env.DB.prepare(`
            SELECT id, title, source_url
            FROM notes
            WHERE (author_name IS NULL OR TRIM(author_name) = '')
              AND source_url IS NOT NULL
              AND TRIM(source_url) != ''
            ORDER BY created_at DESC
            LIMIT 100
          `).all();

          return json({ success: true, count: rows.results?.length || 0, items: rows.results || [] });
        }

        // 5.4 获取待提取字幕的视频笔记列表 (多端自动断点接力): GET /api/notes-pending-subtitles
        if (path === '/api/notes-pending-subtitles' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '60', 10), 1), 200);
          const result = await getPendingSubtitleNotes(env.DB, limit);
          return json({ success: true, count: result.items.length, total: result.total, items: result.items });
        }

        // 5.5 获取字幕提取看板任务记录与统计: GET /api/notes-extraction-tasks
        if (path === '/api/notes-extraction-tasks' && request.method === 'GET') {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '100', 10), 1), 500);
          const filter = url.searchParams.get('filter') || 'all';
          const tasksData = await getExtractionTasks(env.DB, { limit, filter });
          return json({ success: true, ...tasksData });
        }

        // 6. 单篇笔记操作 (GET, DELETE, 更新感想, 更新标签)
        if (path.startsWith('/api/notes/')) {
          const subPath = path.slice('/api/notes/'.length);
          const parts = subPath.split('/');
          const noteId = decodeURIComponent(parts[0]);

          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          // 编辑标题和正文: PUT /api/notes/:id
          if (!parts[1] && request.method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const res = await updateNoteDetail(env.DB, noteId, {
              title: body.title,
              content: body.content
            });
            return json({ success: true, ...res });
          }

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
            const res = await updateTranscript(env.DB, noteId, body.transcript, {
              durationMs: body.durationMs,
              method: body.method,
              extractedAt: body.extractedAt
            });
            return json({ success: true, ...res });
          }

          // 记录字幕提取失败原因、耗时与尝试历史: POST /api/notes/:id/extraction-failure
          if (parts[1] === 'extraction-failure' && request.method === 'POST') {
            const body = await request.json().catch(() => ({}));
            const res = await recordExtractionFailure(env.DB, noteId, {
              errorMessage: body.errorMessage || body.error || '未知提取异常',
              durationMs: body.durationMs,
              method: body.method
            });
            return json({ success: true, ...res });
          }

          // 切换提取模式 (手动提取 / 自动接力): POST /api/notes/:id/extraction-mode
          if (parts[1] === 'extraction-mode' && request.method === 'POST') {
            const body = await request.json().catch(() => ({}));
            const res = await setExtractionMode(env.DB, noteId, body.mode || 'manual');
            return json({ success: true, ...res });
          }

          // 释放媒体存储空间 (仅删除视频 / 仅删除语音 / 视频和语音一起删除): POST /api/notes/:id/delete-media
          if (parts[1] === 'delete-media' && request.method === 'POST') {
            const body = await request.json().catch(() => ({}));
            const res = await deleteNoteMedia(env, noteId, { target: body.target });
            return json({ success: true, ...res });
          }

          // 上传/保存轻量纯音频: POST /api/notes/:id/audio
          if (parts[1] === 'audio' && request.method === 'POST') {
            const audioBuffer = await request.arrayBuffer();
            if (!audioBuffer || audioBuffer.byteLength === 0) {
              return json({ success: false, message: "音频数据不能为空" }, 400);
            }
            const contentType = request.headers.get('content-type') || 'audio/wav';
            const res = await saveNoteAudio(env, noteId, audioBuffer, contentType);
            return json({ success: true, ...res });
          }

          // 切换加入/移出随机播放库: PUT /api/notes/:id/shuffle
          if (parts[1] === 'shuffle' && request.method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const res = await toggleNoteShuffle(env.DB, noteId, body.inShuffle);
            return json({ success: true, ...res });
          }

          // 重新识别/补全单篇笔记博主信息: POST /api/notes/:id/refresh-author
          if (parts[1] === 'refresh-author' && request.method === 'POST') {
            const note = await getNote(env.DB, noteId);
            if (!note) return json({ success: false, message: "笔记不存在" }, 404);
            if (!note.sourceUrl) return json({ success: false, message: "该笔记缺少原始采集链接，无法自动补全" }, 400);

            let savedCookie = '';
            if (env.DB) {
              savedCookie = await getSetting(env.DB, 'xhs_cookie', '');
            }

            const parseReq = new Request(new URL('/api/parse', request.url), {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(savedCookie ? { 'x-xhs-cookie': savedCookie } : {})
              },
              body: JSON.stringify({ text: note.sourceUrl })
            });

            const parseResp = await parseWithFallback(parseReq, env, nativeRequest => invokeHandler(nodeRoutes['/api/parse'], nativeRequest));
            const parsedData = await parseResp.json();

            if (!parseResp.ok || !parsedData?.success) {
              return json({
                success: false,
                message: parsedData?.message || "从小红书重新获取博主信息失败，笔记可能已下架或需要配置 Cookie"
              }, 422);
            }

            const authorName = (parsedData.authorName || parsedData.user?.nickname || "").trim();
            const authorId = (parsedData.authorId || parsedData.user?.userId || "").trim();
            const authorProfileUrl = (parsedData.authorProfileUrl || parsedData.user?.profileUrl || "").trim();

            const updated = await updateNoteAuthor(env.DB, noteId, { authorName, authorId, authorProfileUrl });
            return json({ success: true, ...updated });
          }

          // 手动修改博主信息: PUT /api/notes/:id/author
          if (parts[1] === 'author' && request.method === 'PUT') {
            const body = await request.json().catch(() => ({}));
            const res = await updateNoteAuthor(env.DB, noteId, {
              authorName: body.authorName,
              authorId: body.authorId,
              authorProfileUrl: body.authorProfileUrl
            });
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

        // ========================================================
        // 🗂️ 记忆闪卡系统路由 (Flashcards & SRS)
        // ========================================================
        if (path.startsWith('/api/flashcards')) {
          const pin = request.headers.get('x-auth-pin') || url.searchParams.get('pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          // 1. 从笔记导入闪卡
          if (path === '/api/flashcards/import-from-note' && request.method === 'POST') {
            const body = await request.json().catch(() => ({}));
            const result = await importFlashcardsFromNote(env.DB, body);
            return json(result);
          }

          // 2. 获取统计数据看板与卡包列表
          if (path === '/api/flashcards/stats' && request.method === 'GET') {
            const stats = await getFlashcardStats(env.DB);
            return json({ success: true, stats });
          }

          // 3. 获取今日待复习卡片
          if (path === '/api/flashcards/due' && request.method === 'GET') {
            const deckName = url.searchParams.get('deckName') || '';
            const limit = parseInt(url.searchParams.get('limit') || '100', 10);
            const cards = await getDueFlashcards(env.DB, { deckName, limit });
            return json({ success: true, count: cards.length, cards });
          }

          // 4. 获取闪卡管理列表 (分页、筛选、搜索)
          if (path === '/api/flashcards/list' && request.method === 'GET') {
            const deckName = url.searchParams.get('deckName') || '';
            const noteId = url.searchParams.get('noteId') || '';
            const search = url.searchParams.get('search') || '';
            const filter = url.searchParams.get('filter') || 'all';
            const page = parseInt(url.searchParams.get('page') || '1', 10);
            const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10);
            const result = await getFlashcardsList(env.DB, { deckName, noteId, search, filter, page, pageSize });
            return json({ success: true, ...result });
          }

          // 5. 提交单张卡片复习打卡 (SRS 算法推进)
          if (path.startsWith('/api/flashcards/') && path.endsWith('/review') && request.method === 'POST') {
            const cardId = path.slice('/api/flashcards/'.length, -'/review'.length);
            const body = await request.json().catch(() => ({}));
            const result = await reviewFlashcard(env.DB, { cardId, rating: body.rating });
            return json(result);
          }

          // 6. 拆分卡片 (POST /api/flashcards/:id/split)
          if (path.startsWith('/api/flashcards/') && path.endsWith('/split') && request.method === 'POST') {
            const cardId = path.slice('/api/flashcards/'.length, -'/split'.length);
            const body = await request.json().catch(() => ({}));
            const result = await splitFlashcard(env.DB, cardId, { newCards: body.newCards });
            return json(result);
          }

          // 7. AI 提炼智能挖空建议词 (POST /api/flashcards/ai-cloze)
          if (path === '/api/flashcards/ai-cloze' && request.method === 'POST') {
            const body = await request.json().catch(() => ({}));
            const result = await generateAiClozeSuggestions(env, body.text);
            return json({ success: true, ...result });
          }

          // 8. 修改单张卡片 (PUT /api/flashcards/:id)
          if (path.startsWith('/api/flashcards/') && request.method === 'PUT') {
            const cardId = path.slice('/api/flashcards/'.length);
            const body = await request.json().catch(() => ({}));
            const result = await updateFlashcard(env.DB, cardId, body);
            return json(result);
          }

          // 9. 删除单张卡片 (DELETE /api/flashcards/:id)
          if (path.startsWith('/api/flashcards/') && request.method === 'DELETE') {
            const cardId = path.slice('/api/flashcards/'.length);
            const result = await deleteFlashcard(env.DB, cardId);
            return json(result);
          }
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
                  authorName: parsed.authorName || parsed.user?.nickname || "",
                  authorId: parsed.authorId || parsed.user?.userId || "",
                  authorProfileUrl: parsed.authorProfileUrl || parsed.user?.profileUrl || "",
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
          const assetResp = await env.ASSETS.fetch(request);
          // 针对 HTML、JS 与 CSS，强制禁用客户端与 CDN 强缓存，确保用户实时获得最新功能
          if (path === '/' || path === '/index.html' || path.endsWith('.html') || path.endsWith('.js') || path.endsWith('.css')) {
            const newHeaders = new Headers(assetResp.headers);
            newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
            newHeaders.set('Pragma', 'no-cache');
            newHeaders.set('Expires', '0');
            return new Response(assetResp.body, {
              status: assetResp.status,
              statusText: assetResp.statusText,
              headers: newHeaders
            });
          }
          return assetResp;
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
