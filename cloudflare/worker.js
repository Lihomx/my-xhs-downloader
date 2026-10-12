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
  updateNoteDetail,
  deleteNoteMedia,
  saveNoteAudio,
  toggleNoteShuffle,
  getShuffleNotes,
  getStorageUsage
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
            const effectiveProvider = whisperProvider || (whisperApiKey ? 'groq' : 'cloudflare');
            return json({
              success: true,
              hasCookie: Boolean(xhsCookie),
              xhsCookie,
              whisperProvider: effectiveProvider,
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
            if (typeof body.whisperProvider === 'string') {
              await setSetting(env.DB, 'whisper_provider', body.whisperProvider.trim());
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

          // 自动判断生效引擎
          const effectiveProvider = whisperProvider || (thirdPartyKey ? 'groq' : 'cloudflare');

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
              const formData = new FormData();
              
              // 构造标准 WAV 文件体
              const audioFile = typeof File !== 'undefined'
                ? new File([audioBuffer], 'audio.wav', { type: 'audio/wav' })
                : new Blob([audioBuffer], { type: 'audio/wav' });
              formData.append('file', audioFile, 'audio.wav');
              
              // Groq 官方推荐：优先使用 whisper-large-v3 (32层完整解码器，15.5亿参数，抗噪与中文防死循环能力远优于4层蒸馏版turbo)
              formData.append('model', isGroq ? 'whisper-large-v3' : 'whisper-1');
              formData.append('language', 'zh');
              formData.append('temperature', '0');
              formData.append('response_format', 'verbose_json');
              formData.append('prompt', '普通话，口语，对话，简体中文。');

              const aiRes = await fetch(endpoint, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${thirdPartyKey.trim()}`
                },
                body: formData
              });

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
                console.warn("Third-party Whisper API response not ok:", errText);
                let parsedErr = errText;
                try { parsedErr = JSON.parse(errText).error?.message || errText; } catch {}
                return json({
                  success: false,
                  message: `${isGroq ? 'Groq' : '第三方'} 语音识别失败 (HTTP ${aiRes.status}): ${parsedErr}`
                }, 502);
              }
            } catch (err) {
              console.warn("Third-party Whisper API call error:", err);
              return json({
                success: false,
                message: `${effectiveProvider === 'groq' ? 'Groq' : '第三方'} 服务连接出错: ${err.message}`
              }, 502);
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


        // 智能标点符号恢复与排版接口: POST /api/punctuate
        if (path === '/api/punctuate' && request.method === 'POST') {
          const pin = request.headers.get('x-auth-pin');
          const isAuthed = await verifyPin(env.DB, pin);
          if (!isAuthed) return json({ success: false, message: "PIN 码验证失败" }, 401);

          const body = await request.json().catch(() => ({}));
          const rawText = String(body.text || '').trim();
          if (!rawText) return json({ success: false, message: "文本不能为空" }, 400);

          let punctuatedText = '';
          const systemPrompt = "你是一个专业的中文口语整理、对话听写断句与语音识别（ASR）错别字纠错大师。你将接收一段由语音识别生成的口语文本，其中可能缺少标点符号、断句混乱（或多句话连续堆砌在一起），并且可能包含发音相近的同音错别字、口误以及背景音乐诱发的重复复读词句。\n\n你的核心任务：\n1. 【对话与短句精细断句】：遇到人物对话、陈述或一句话说完，必须准确添加全角中文句号「。」；遇到疑问或反问语气（如多少钱、能优惠不、行不、好不、为啥、怎么）必须使用全角问号「？」；遇到强烈感叹或应答（如好嘞、行、太厉害了、错）使用感叹号「！」；\n2. 【逗号自然停顿】：句子内部较长或有语意短暂停顿时，合理补充中文逗号「，」，使阅读节奏极其舒适；\n3. 【核心排版：一个完整句子独立成一段】：每一个以句号「。」、问号「？」或感叹号「！」结尾的完整句子，必须单独换行独立成一个自然段！严禁将两句或多句话堆在同一段中；\n4. 【消除异常复读死循环】：如果输入中包含连续重复的无意义复读片段（如同一句话重复出现多次），请自动将其去重过滤，只保留合理语义内容；\n5. 【纠正同音字与口语错别字】：结合上下文语境（如生活对话、商业买卖、职场管理等），智能将口语误识别词纠正为标准字词或规范成语；\n6. 【严禁多余废话】：严禁输出任何开场白、解释说明、前言、总结或 markdown 标记，直接输出分段整理后的纯文本：";

          // 优先策略 1: 如果配置了 Groq API Key，使用 Groq 极速大模型 (llama-3.1-8b-instant，0.2 秒神速响应)
          let thirdPartyKey = '';
          if (env.DB) {
            thirdPartyKey = await getSetting(env.DB, 'whisper_api_key', '');
          }

          if (thirdPartyKey) {
            try {
              const groqChatRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${thirdPartyKey.trim()}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  model: 'llama-3.1-8b-instant',
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
                // 严格校验完整度：长度不得低于 85%，防止长文本被截断截尾
                if (reply && reply.length >= rawText.length * 0.85) {
                  punctuatedText = reply;
                }
              }
            } catch (err) {
              console.warn("Groq LLM punctuate call error:", err);
            }
          }

          // 策略 2: 降级使用 Cloudflare Workers AI 原生大语言模型
          if (!punctuatedText && env.AI) {
            const candidateModels = [
              '@cf/meta/llama-3.2-3b-instruct',
              '@cf/meta/llama-3.2-1b-instruct',
              '@cf/qwen/qwen3-30b-a3b-fp8'
            ];
            for (const model of candidateModels) {
              try {
                const aiRes = await env.AI.run(model, {
                  messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: rawText }
                  ],
                  max_tokens: 2500,
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
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

          const result = await listNotes(env.DB, { search, tag, limit, offset });
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
            const res = await updateTranscript(env.DB, noteId, body.transcript);
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
