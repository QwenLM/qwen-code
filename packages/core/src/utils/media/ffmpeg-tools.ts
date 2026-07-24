/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffprobeFacts } from './probe.js';
import type { MediaProbe } from './types.js';

/**
 * ffmpeg transform layer — the local implementation behind the region/scale/
 * range knobs and `media_extract`. Every function is deterministic (模型无感)
 * and lossy in a *declared* way: callers must state what changed in the C10
 * precision note. No image library is bundled; ffmpeg is the one dependency and
 * failures fail closed (the caller renders a remedy).
 */

const FFMPEG_TIMEOUT_MS = 300_000;

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(
      'ffmpeg',
      args,
      { signal, timeout: FFMPEG_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(stderr?.toString().trim() || err.message));
          return;
        }
        resolve();
      },
    );
  });
}

async function withTempDir<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export interface ImageTransformParams {
  /** Crop region [x, y, width, height] in pixels, applied first. */
  region?: [number, number, number, number];
  /** Downscale factor in (0, 1]; mutually informs longEdge. */
  scale?: number;
  /** Longest-edge pixel cap applied after crop/scale. */
  maxLongEdge?: number;
  signal?: AbortSignal;
}

export interface ImageTransformResult {
  /** JPEG bytes of the transformed image. */
  buffer: Buffer;
  mimeType: 'image/jpeg';
  width?: number;
  height?: number;
  /** True when any crop/scale/cap was actually applied. */
  changed: boolean;
  /** Human-readable description of what was applied (for the precision note). */
  appliedNote: string;
}

/**
 * Crop and/or downscale an image via ffmpeg. Applies `crop` first, then `scale`
 * (an explicit factor) or a `maxLongEdge` cap (fit within a box, aspect
 * preserved). Returns JPEG bytes plus what changed so the caller can declare it.
 */
export async function transformImage(
  probe: MediaProbe,
  params: ImageTransformParams,
): Promise<ImageTransformResult> {
  const filters: string[] = [];
  const applied: string[] = [];

  if (params.region) {
    const [x, y, w, h] = params.region;
    filters.push(`crop=${w}:${h}:${x}:${y}`);
    applied.push(`cropped to [x=${x}, y=${y}, ${w}×${h}]`);
  }
  if (params.scale !== undefined && params.scale > 0 && params.scale < 1) {
    filters.push(
      `scale=trunc(iw*${params.scale}/2)*2:trunc(ih*${params.scale}/2)*2`,
    );
    applied.push(`downscaled ×${params.scale}`);
  } else if (params.maxLongEdge) {
    const cap = params.maxLongEdge;
    // Only shrinks: force_original_aspect_ratio=decrease never upscales.
    filters.push(`scale=${cap}:${cap}:force_original_aspect_ratio=decrease`);
    applied.push(`capped to ${cap}px longest edge`);
  }

  const changed = filters.length > 0;
  return withTempDir('media-img-', async (dir) => {
    const out = path.join(dir, 'out.jpg');
    const args = ['-hide_banner', '-loglevel', 'error', '-i', probe.path];
    if (filters.length > 0) args.push('-vf', filters.join(','));
    args.push('-frames:v', '1', '-q:v', '2', out);
    await runFfmpeg(args, params.signal);
    const buffer = await fs.readFile(out);
    const dims = await ffprobeFacts(out);
    return {
      buffer,
      mimeType: 'image/jpeg' as const,
      ...(dims.width !== undefined && { width: dims.width }),
      ...(dims.height !== undefined && { height: dims.height }),
      changed,
      appliedNote: changed
        ? applied.join(', ')
        : 're-encoded to JPEG, no dimension change',
    };
  });
}

export interface ClipParams {
  /** Time window [startSeconds, endSeconds]. */
  range: [number, number];
  /** Longest-edge cap for the video (audio ignores this). */
  maxLongEdge?: number;
  signal?: AbortSignal;
}

export interface ClipResult {
  buffer: Buffer;
  mimeType: string;
  ext: string;
}

/**
 * Cut a time window from an audio/video file, re-encoding so the clip starts
 * exactly at `range[0]` (a stream copy would snap to the nearest keyframe).
 * Video keeps its audio track; the clip is downscaled to `maxLongEdge`.
 */
export async function extractClip(
  probe: MediaProbe,
  params: ClipParams,
): Promise<ClipResult> {
  const [start, end] = params.range;
  const isVideo = probe.modality === 'video';
  const ext = isVideo ? 'mp4' : 'mp3';
  const mimeType = isVideo ? 'video/mp4' : 'audio/mpeg';
  return withTempDir('media-clip-', async (dir) => {
    const out = path.join(dir, `clip.${ext}`);
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(start),
      '-to',
      String(end),
      '-i',
      probe.path,
    ];
    if (isVideo) {
      const vf = params.maxLongEdge
        ? `scale=${params.maxLongEdge}:${params.maxLongEdge}:force_original_aspect_ratio=decrease`
        : undefined;
      if (vf) args.push('-vf', vf);
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
      );
    } else {
      args.push('-vn', '-c:a', 'libmp3lame', '-q:a', '4');
    }
    args.push(out);
    await runFfmpeg(args, params.signal);
    const buffer = await fs.readFile(out);
    return { buffer, mimeType, ext };
  });
}

export interface AudioTrackParams {
  /** Optional time window; whole file when omitted. */
  range?: [number, number];
  signal?: AbortSignal;
}

/** Extract (a window of) the audio track as MP3 bytes. */
export async function extractAudioTrack(
  probe: MediaProbe,
  params: AudioTrackParams = {},
): Promise<ClipResult> {
  return withTempDir('media-aud-', async (dir) => {
    const out = path.join(dir, 'audio.mp3');
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (params.range) {
      args.push('-ss', String(params.range[0]), '-to', String(params.range[1]));
    }
    args.push('-i', probe.path, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', out);
    await runFfmpeg(args, params.signal);
    const buffer = await fs.readFile(out);
    return { buffer, mimeType: 'audio/mpeg', ext: 'mp3' };
  });
}
