/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSpecificMimeType } from '../fileUtils.js';
import type { Modality, MediaProbe } from './types.js';

/**
 * P1 · Probe — deterministic identification of a media file (模型无感).
 *
 * Probe never involves the model: it establishes the facts every downstream
 * decision (capability gating, reader pick, transport, memory identity) depends
 * on. It is A-class and its output shape is stable across implementations.
 *
 * Identity (content hash), modality, mime and byte size are always derivable
 * cheaply. Duration / resolution / audio-track are filled in best-effort via
 * `ffprobe` when it is on PATH; if it is absent those fields stay undefined and
 * downstream code degrades gracefully.
 */

/** Map a mime type to the modality the media layer reasons about, or undefined. */
export function modalityOf(mimeType: string): Modality | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return undefined;
}

/** Stream a file through sha256 without loading it fully into memory. */
export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

/** sha256 of an in-memory buffer (used for content-addressing derived artifacts). */
export function hashBuffer(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

interface FfprobeFacts {
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  audioChannels?: number;
}

/** Parse an ffprobe `r_frame_rate` like "30000/1001" into fps. */
function parseFrameRate(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const [num, den] = raw.split('/');
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  const fps = n / d;
  return fps > 0 ? +fps.toFixed(3) : undefined;
}

/**
 * Best-effort ffprobe. Returns `{}` when ffprobe is unavailable or the file is
 * unreadable by it — never throws, so probe stays robust without the binary.
 */
export async function ffprobeFacts(filePath: string): Promise<FfprobeFacts> {
  const json = await new Promise<string>((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout.toString()),
    );
  });
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        channels?: number;
        r_frame_rate?: string;
        avg_frame_rate?: string;
        duration?: string;
      }>;
    };
    const streams = parsed.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video');
    const audio = streams.find((s) => s.codec_type === 'audio');
    const hasAudio = audio !== undefined;
    const durationRaw =
      parsed.format?.duration ?? video?.duration ?? audio?.duration;
    const durationSec =
      durationRaw !== undefined && Number.isFinite(Number(durationRaw))
        ? Number(durationRaw)
        : undefined;
    const fps =
      parseFrameRate(video?.avg_frame_rate) ??
      parseFrameRate(video?.r_frame_rate);
    return {
      durationSec,
      width: video?.width,
      height: video?.height,
      fps,
      hasAudio,
      audioChannels: audio?.channels,
    };
  } catch {
    return {};
  }
}

/**
 * Probe a media file. Throws if the path is missing/not a file, or the mime type
 * is not a media modality — callers translate that into a fail-closed media
 * error (path-problem / unsupported-format) via the C10 contract.
 */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const resolved = path.resolve(filePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  const mimeType = getSpecificMimeType(resolved) ?? 'application/octet-stream';
  const modality = modalityOf(mimeType);
  if (!modality) {
    throw new Error(
      `Unsupported media type "${mimeType}" for ${resolved}; probe handles image/audio/video only.`,
    );
  }
  const hash = await hashFile(resolved);
  // Duration/resolution/audio-track/fps matter for a/v decisions, and image
  // dimensions drive the downscale cap; ffprobe is cheap and best-effort.
  const facts = await ffprobeFacts(resolved);
  return {
    path: resolved,
    hash,
    modality,
    mimeType,
    sizeBytes: stat.size,
    ...(facts.durationSec !== undefined && { durationSec: facts.durationSec }),
    ...(facts.width !== undefined && { width: facts.width }),
    ...(facts.height !== undefined && { height: facts.height }),
    ...(facts.fps !== undefined && { fps: facts.fps }),
    ...(facts.hasAudio !== undefined && { hasAudio: facts.hasAudio }),
    ...(facts.audioChannels !== undefined && {
      audioChannels: facts.audioChannels,
    }),
  };
}
