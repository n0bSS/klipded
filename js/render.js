// Draws a vertical frame (shared by live preview, thumbnails and export) and exports MP4.
import { MB } from './media.js';
import { OUT_W, OUT_H, planBoxes, boxRect, fullHeightW, PANELS } from './layout.js';
import { drawCaptions, drawHook, drawWatermark, ensureFonts } from './captions.js';
import { clamp } from './util.js';

export function makeScratch() {
  const c = document.createElement('canvas');
  c.width = 27;
  c.height = 48;
  return { blur: c, bctx: c.getContext('2d') };
}

export function captionYFor(plan, settings) {
  if (settings.captionY != null && settings.captionY !== 'auto') return Number(settings.captionY);
  switch (plan?.mode) {
    case 'split': return 0.5;
    case 'stream': return 0.4;
    default: return 0.7;
  }
}

/**
 * ctx: 2D context in 1080x1920 coordinates (may be scaled for previews)
 * drawSrc(targetCtx, sx, sy, sw, sh, dx, dy, dw, dh): draws part of the current source frame
 * W,H: source frame size; tSrc: time in the source video
 * job: { plan, chunks, settings, hook, clipStart, clipEnd }
 */
export function drawScene(ctx, drawSrc, W, H, tSrc, job, scratch) {
  const { plan, settings } = job;
  const mode = plan?.mode || 'fit';
  ctx.save();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  if (mode === 'fit') {
    const bgA = OUT_W / OUT_H;
    const r = boxRect({ x: 0.5, y: 0.5, w: fullHeightW(bgA, W, H) }, bgA, W, H);
    scratch.bctx.imageSmoothingEnabled = true;
    drawSrc(scratch.bctx, r.sx, r.sy, r.sw, r.sh, 0, 0, scratch.blur.width, scratch.blur.height);
    ctx.drawImage(scratch.blur, -40, -40, OUT_W + 80, OUT_H + 80);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(0, 0, OUT_W, OUT_H);
    const zoom = plan.zoom || 1;
    let dw = OUT_W * zoom;
    let dh = (H * dw) / W;
    if (dh > OUT_H * 0.92) { dh = OUT_H * 0.92; dw = (W * dh) / H; }
    const dx = (OUT_W - dw) / 2;
    const dy = (OUT_H - dh) / 2 - OUT_H * 0.06;
    drawSrc(ctx, 0, 0, W, H, dx, dy, dw, dh);
  } else {
    for (const p of planBoxes(plan, W, H, tSrc)) {
      const r = boxRect(p.box, p.aspect, W, H);
      const panel = PANELS[p.key];
      drawSrc(ctx, r.sx, r.sy, r.sw, r.sh, 0, panel.y, OUT_W, panel.h);
    }
    if (mode === 'split' || mode === 'stream') {
      const y = mode === 'split' ? PANELS.b.y : PANELS.game.y;
      ctx.fillStyle = '#0c0a12';
      ctx.fillRect(0, y - 3, OUT_W, 6);
    }
  }

  const tRel = tSrc - job.clipStart;
  if (settings.style !== 'none') {
    drawCaptions(ctx, job.chunks, tSrc, {
      style: settings.style, size: settings.size, y: captionYFor(plan, settings), upper: settings.upper,
    });
  }
  if (settings.showHook) drawHook(ctx, job.hook, tRel, { hookSec: settings.hookSec || 3, hookY: 0.19 });
  if (settings.watermark) drawWatermark(ctx, settings.watermark);
  if (settings.progress) {
    const dur = Math.max(0.1, job.clipEnd - job.clipStart);
    ctx.fillStyle = '#FF3D8B';
    ctx.fillRect(0, OUT_H - 12, OUT_W * clamp(tRel / dur, 0, 1), 12);
  }
  ctx.restore();
}

/** Renders one clip to an MP4 Blob. */
export async function exportClip(info, job, { onProgress, signal } = {}) {
  await ensureFonts();
  const canvas = document.createElement('canvas');
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext('2d', { alpha: false });
  const scratch = makeScratch();
  const fps = Math.min(job.settings.fps || 30, Math.max(24, Math.round(info.fps || 30)));
  const bitrate = fps > 30 ? 12e6 : 8e6;

  const vCodec = await MB.getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: OUT_W, height: OUT_H, bitrate });
  if (!vCodec) throw new Error('no_video_encoder');
  const useMp4 = ['avc', 'hevc', 'vp9', 'av1'].includes(vCodec);
  let aCodec = null;
  if (info.aTrack && info.canDecodeAudio) {
    aCodec = await MB.getFirstEncodableAudioCodec(useMp4 ? ['aac', 'opus'] : ['opus', 'vorbis'], { numberOfChannels: 2, sampleRate: 48000, bitrate: 160000 });
  }
  const output = new MB.Output({
    format: useMp4 ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat(),
    target: new MB.BufferTarget(),
  });
  const conv = await MB.Conversion.init({
    input: info.input,
    output,
    tracks: 'primary',
    trim: { start: job.clipStart, end: job.clipEnd },
    video: {
      codec: vCodec,
      quality: new MB.Quality({ bitrate }),
      frameRate: fps,
      forceTranscode: true,
      processedWidth: OUT_W,
      processedHeight: OUT_H,
      process: (sample) => {
        // In a trimmed conversion, sample timestamps start at 0 = clip start.
        const tSrc = job.clipStart + sample.timestamp;
        drawScene(ctx, (c, ...a) => sample.draw(c, ...a), sample.displayWidth, sample.displayHeight, tSrc, job, scratch);
        return canvas;
      },
    },
    audio: aCodec
      ? { codec: aCodec, numberOfChannels: 2, sampleRate: 48000, quality: new MB.Quality({ bitrate: 160000 }) }
      : { discard: true },
    showWarnings: false,
  });
  if (!conv.isValid) {
    throw new Error('export_invalid: ' + conv.discardedTracks.map((d) => d.reason).join(','));
  }
  conv.onProgress = (p) => onProgress?.(p);
  const stop = () => conv.cancel();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await conv.execute();
  } finally {
    signal?.removeEventListener('abort', stop);
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return {
    blob: new Blob([output.target.buffer], { type: useMp4 ? 'video/mp4' : 'video/webm' }),
    ext: useMp4 ? 'mp4' : 'webm',
    videoCodec: vCodec,
    audioCodec: aCodec,
  };
}
