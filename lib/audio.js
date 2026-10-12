/**
 * 客户端轻量音频提取与 16kHz WAV 封装模块
 * 利用浏览器原生 Web Audio API 直接从 MP4 视频解码提取纯音频轨道
 * 输出 16kHz 单声道 16-bit PCM WAV 数据，专为 Whisper 语音识别优化
 */

export async function extractAudioChunksFromMedia(mediaUrl, onProgress, chunkDurationSec = 20) {
  if (onProgress) onProgress("正在下载媒体文件...");
  const resp = await fetch(mediaUrl);
  if (!resp.ok) throw new Error(`获取媒体文件失败: HTTP ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();

  if (onProgress) onProgress("正在解析音频轨道...");
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("当前浏览器不支持 Web Audio API");
  const ctx = new AudioCtx();

  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close().catch(() => {});
  }

  const durationSec = audioBuffer.duration || 0;
  if (onProgress) onProgress(`音频解析完成 (时长: ${Math.round(durationSec)} 秒)，正在优化重采样与增益...`);

  const targetSampleRate = 16000;
  const pcm16 = resampleAndDownmixToMono(audioBuffer, targetSampleRate);
  const totalSamples = pcm16.length;

  // 辅助方法：生成指定样本区间的 WAV Blob
  function makeWavBlob(startSample, endSample) {
    const slice = pcm16.subarray(Math.max(0, startSample), Math.min(totalSamples, endSample));
    const wavBytes = encodeWav(slice, targetSampleRate);
    return new Blob([wavBytes], { type: "audio/wav" });
  }

  // 辅助方法：以秒为单位截取 WAV Blob (供客户端早停补录/自愈机制调用)
  function sliceAudioBlob(startSec, endSec) {
    const sSample = Math.max(0, Math.floor(startSec * targetSampleRate));
    const eSample = Math.min(totalSamples, Math.ceil(endSec * targetSampleRate));
    return makeWavBlob(sSample, eSample);
  }

  // 如果总时长 <= chunkDurationSec，直接作为一个单块返回
  if (durationSec <= chunkDurationSec) {
    const wavBlob = makeWavBlob(0, totalSamples);
    return {
      duration: durationSec,
      sampleRate: targetSampleRate,
      sliceAudioBlob,
      chunks: [
        {
          index: 0,
          total: 1,
          startTime: 0,
          endTime: durationSec,
          duration: durationSec,
          isSilent: computeRms(pcm16) < 0.001,
          blob: wavBlob
        }
      ]
    };
  }

  // 较长音频按 chunkDurationSec 切片 (严格 20 秒窗口，完美适配 Whisper 30 秒声学框架)
  const chunks = [];
  let currentStartSec = 0;
  let idx = 0;

  while (currentStartSec < durationSec) {
    const currentEndSec = Math.min(durationSec, currentStartSec + chunkDurationSec);
    const startSample = Math.floor(currentStartSec * targetSampleRate);
    const endSample = Math.min(totalSamples, Math.ceil(currentEndSec * targetSampleRate));

    // 如果最后一段碎片极短（小于 1.5 秒且非唯一分段），跳过
    if (endSample - startSample < targetSampleRate * 1.5 && idx > 0) {
      break;
    }

    const chunkPcm = pcm16.subarray(startSample, endSample);
    const chunkWavBytes = encodeWav(chunkPcm, targetSampleRate);
    const isSilent = computeRms(chunkPcm) < 0.001;

    chunks.push({
      index: idx,
      startTime: currentStartSec,
      endTime: currentEndSec,
      duration: currentEndSec - currentStartSec,
      isSilent,
      blob: new Blob([chunkWavBytes], { type: "audio/wav" })
    });

    idx++;
    currentStartSec += chunkDurationSec;
  }

  chunks.forEach((c) => {
    c.total = chunks.length;
  });

  return {
    duration: durationSec,
    sampleRate: targetSampleRate,
    sliceAudioBlob,
    chunks
  };
}

function computeRms(pcm16) {
  if (!pcm16 || pcm16.length === 0) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(pcm16.length / 5000));
  let count = 0;
  for (let i = 0; i < pcm16.length; i += step) {
    const val = pcm16[i] / 32768;
    sum += val * val;
    count++;
  }
  return Math.sqrt(sum / count);

}

export async function extractWavFromMedia(mediaUrl, onProgress) {
  const result = await extractAudioChunksFromMedia(mediaUrl, onProgress);
  return result.chunks[0].blob;
}

export async function extractFullWavFromMedia(mediaUrl, onProgress) {
  if (onProgress) onProgress("正在读取媒体音频流...");
  const resp = await fetch(mediaUrl);
  if (!resp.ok) throw new Error(`获取媒体文件失败: HTTP ${resp.status}`);
  const arrayBuffer = await resp.arrayBuffer();

  if (onProgress) onProgress("正在解码音频轨道...");
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("当前浏览器不支持 Web Audio API");
  const ctx = new AudioCtx();

  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  } finally {
    ctx.close().catch(() => {});
  }

  const durationSec = audioBuffer.duration || 0;
  if (onProgress) onProgress("正在编码轻量纯音频 (WAV)...");
  const targetSampleRate = 16000;
  const pcm16 = resampleAndDownmixToMono(audioBuffer, targetSampleRate);
  const wavBytes = encodeWav(pcm16, targetSampleRate);
  return {
    blob: new Blob([wavBytes], { type: "audio/wav" }),
    duration: durationSec
  };
}

function resampleAndDownmixToMono(audioBuffer, targetRate) {
  const numChannels = audioBuffer.numberOfChannels;
  const originalLength = audioBuffer.length;
  const originalRate = audioBuffer.sampleRate;

  // 1. 混合多声道为单声道浮点数
  const mono = new Float32Array(originalLength);
  for (let c = 0; c < numChannels; c++) {
    const channelData = audioBuffer.getChannelData(c);
    for (let i = 0; i < originalLength; i++) {
      mono[i] += channelData[i] / numChannels;
    }
  }

  // 2. 重采样至 targetRate (例如 16000)
  let resampled;
  if (originalRate === targetRate) {
    resampled = mono;
  } else {
    const ratio = originalRate / targetRate;
    const newLength = Math.round(originalLength / ratio);
    resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const indexLow = Math.floor(srcIndex);
      const indexHigh = Math.min(indexLow + 1, originalLength - 1);
      const fraction = srcIndex - indexLow;
      // 线性插值
      resampled[i] = mono[indexLow] * (1 - fraction) + mono[indexHigh] * fraction;
    }
  }

  // 3. 峰值音量增益归一化 (Peak Normalization):
  // 许多短视频/手机原声音量偏小 (-15dB ~ -25dB)，直接送 Whisper 极易被误判为静音早停；
  // 在此对有效人声音频进行动态拉升至 0.95 满刻度，大幅提升信噪比与转写完整度
  let maxAbs = 0;
  for (let i = 0; i < resampled.length; i++) {
    const abs = Math.abs(resampled[i]);
    if (abs > maxAbs) maxAbs = abs;
  }
  if (maxAbs > 0.005 && maxAbs < 0.90) {
    const gain = Math.min(10.0, 0.95 / maxAbs);
    for (let i = 0; i < resampled.length; i++) {
      resampled[i] *= gain;
    }
  }

  return convertFloatTo16BitPCM(resampled);
}

function convertFloatTo16BitPCM(floatSamples) {
  const pcm = new Int16Array(floatSamples.length);
  for (let i = 0; i < floatSamples.length; i++) {
    const s = Math.max(-1, Math.min(1, floatSamples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return pcm;
}

function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  // RIFF 标识
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");

  // fmt 子块
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM = 1
  view.setUint16(22, 1, true); // 单声道 = 1
  view.setUint32(24, sampleRate, true); // 采样率 16000
  view.setUint32(28, sampleRate * 2, true); // 字节率 (16000 * 2)
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 16-bit

  // data 子块
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    view.setInt16(offset, samples[i], true);
  }

  return new Uint8Array(buffer);
}

export default {
  extractWavFromMedia,
  extractFullWavFromMedia,
  extractAudioChunksFromMedia
};
