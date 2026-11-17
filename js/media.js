// Media helpers built on Mediabunny (WebCodecs): open a video file, extract compact audio
// chunks for speech-to-text, measure loudness, and grab still frames.
import * as MB from '../lib/mediabunny.min.mjs';

export { MB };

/** src: a File/Blob, or a URL string (e.g. a file served by the local helper). */
export async function openVideo(src) {
  const source = typeof src === 'string' ? new MB.UrlSource(src) : new MB.BlobSource(src);
  const input = new MB.Input({ source, formats: MB.ALL_FORMATS });
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error('no_video');
  const aTrack = await input.getPrimaryAudioTrack();
  const duration = await input.computeDuration();
  const width = await vTrack.getDisplayWidth();
  const height = await vTrack.getDisplayHeight();
  const canDecodeVideo = await vTrack.canDecode();
  const canDecodeAudio = aTrack ? await aTrack.canDecode() : false;
  let fps = 30;
  try {
    const m = await vTrack.computeFrameRateMetrics?.();
    if (m && m.averageFrameRate) fps = m.averageFrameRate;
  } catch {}
  return {
    src, input, vTrack, aTrack, duration, width, height, fps,
    videoCodec: await vTrack.getCodec(), audioCodec: aTrack ? await aTrack.getCodec() : null,
    canDecodeVideo, canDecodeAudio,
  };
}

const ENERGY_BIN = 0.5; // seconds

/**
 * Splits the audio into overlapping chunks (mono 16 kHz Opus in Ogg, ~3 KB/s) and calls
 * onChunk for each one. Also measures loudness (RMS per 0.5 s) for "loud moment" hints.
 */
export async function extractAudioChunks(info, { chunkSec = 300, overlap = 2, ranges = null, onChunk, onProgress, signal } = {}) {
  if (!info.aTrack) throw new Error('no_audio');
  if (!info.canDecodeAudio) throw new Error('audio_not_decodable');
  const D = info.duration;
  const plan = [];
  if (ranges && ranges.length) {
    // Only the given [start,end] ranges (used after the AI picked clips from the video itself)
    for (const [a, b] of ranges) plan.push({ s: Math.max(0, a), e: Math.min(D, b), own: [Math.max(0, a), Math.min(D, b)] });
  } else {
    const n = Math.max(1, Math.ceil((D - 0.5) / chunkSec));
    for (let i = 0; i < n; i++) {
      const own0 = i * chunkSec;
      const own1 = i === n - 1 ? D : (i + 1) * chunkSec;
      plan.push({ s: Math.max(0, own0 - (i ? overlap : 0)), e: Math.min(D, own1 + overlap), own: [own0, i === n - 1 ? Infinity : own1] });
    }
  }
  const n = plan.length;
  const sums = new Float64Array(Math.ceil(D / ENERGY_BIN) + 4);
  const counts = new Float64Array(sums.length);

  for (let i = 0; i < n; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const { s, e, own } = plan[i];
    if (e - s < 0.5) continue;
    const output = new MB.Output({ format: new MB.OggOutputFormat(), target: new MB.BufferTarget() });
    let offset = null;
    const conv = await MB.Conversion.init({
      input: info.input,
      output,
      tracks: 'primary',
      trim: { start: s, end: e },
      video: { discard: true },
      audio: {
        codec: 'opus',
        numberOfChannels: 1,
        sampleRate: 16000,
        quality: new MB.Quality({ bitrate: 24000 }),
        forceTranscode: true,
        process: (sample) => {
          // Timestamps may be relative to the trim start; detect once per chunk.
          if (offset === null) offset = sample.timestamp < s - 0.5 ? s : 0;
          accumulate(sample, offset, sums, counts);
          return sample;
        },
      },
      showWarnings: false,
    });
    if (!conv.isValid) throw new Error('audio_conversion_invalid');
    conv.onProgress = (p) => onProgress?.((i + p) / n);
    const stop = () => conv.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await conv.execute();
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const blob = new Blob([output.target.buffer], { type: 'audio/ogg' });
    await onChunk?.({ index: i, count: n, start: s, end: e, own, blob, seconds: e - s });
  }
  onProgress?.(1);
  const energy = new Float32Array(sums.length);
  for (let i = 0; i < sums.length; i++) energy[i] = counts[i] ? Math.sqrt(sums[i] / counts[i]) : 0;
  return { energy: Array.from(energy, (v) => Math.round(v * 10000) / 10000), bin: ENERGY_BIN };
}

function accumulate(sample, offset, sums, counts) {
  const n = sample.numberOfFrames;
  if (!n) return;
  const buf = new Float32Array(n);
  try {
    sample.copyTo(buf, { planeIndex: 0, format: 'f32-planar' });
  } catch {
    return;
  }
  const sr = sample.sampleRate;
  const t0 = sample.timestamp + offset;
  const binLen = sr * ENERGY_BIN;
  let i = 0;
  while (i < n) {
    const b = Math.floor((t0 + i / sr) / ENERGY_BIN);
    const binEndFrame = Math.min(n, Math.ceil(((b + 1) * ENERGY_BIN - t0) * sr));
    const stop = Math.max(i + 1, Math.min(binEndFrame, i + binLen));
    let acc = 0;
    for (let j = i; j < stop; j++) acc += buf[j] * buf[j];
    if (b >= 0 && b < sums.length) { sums[b] += acc; counts[b] += stop - i; }
    i = stop;
  }
}

/** Returns a canvas with the frame at time t (display orientation), scaled to width w. */
export async function grabFrame(info, t, w = 640) {
  const h = Math.round((w * info.height) / info.width);
  const sink = new MB.CanvasSink(info.vTrack, { width: w, height: h, fit: 'fill', poolSize: 0 });
  const wc = await sink.getCanvas(Math.max(0, Math.min(t, info.duration - 0.05)));
  return wc ? wc.canvas : null;
}

/** Iterates frames at the given timestamps (seconds) at analysis size. */
export async function* framesAt(info, times, w = 960) {
  const h = Math.round((w * info.height) / info.width);
  const sink = new MB.CanvasSink(info.vTrack, { width: w, height: h, fit: 'fill', poolSize: 1 });
  let k = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    yield { t: times[k++], canvas: wc ? wc.canvas : null };
  }
}
