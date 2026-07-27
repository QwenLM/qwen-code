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

/**
 * Sniff a media MIME type from a file's leading bytes (magic numbers), so
 * identification does NOT depend on the filename extension (方案 1.1.1 · 进入与
 * 识别: "MIME 类型以 magic bytes 判定，不依赖扩展名"). Returns undefined when the
 * signature is not a recognized image/audio/video container — callers then fall
 * back to the extension-based type. Never throws.
 */
export function sniffMimeFromBytes(head: Buffer): string | undefined {
  const b = head;
  const startsWith = (sig: number[], offset = 0): boolean =>
    b.length >= offset + sig.length &&
    sig.every((byte, i) => b[offset + i] === byte);
  const ascii = (offset: number, len: number): string =>
    b.length >= offset + len ? b.toString('latin1', offset, offset + len) : '';

  // --- Images ---
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return 'image/png';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (startsWith([0x42, 0x4d])) return 'image/bmp';
  if (
    startsWith([0x49, 0x49, 0x2a, 0x00]) ||
    startsWith([0x4d, 0x4d, 0x00, 0x2a])
  )
    return 'image/tiff';

  // --- RIFF container: WEBP (image), WAV (audio), AVI (video) ---
  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 4);
    if (form === 'WEBP') return 'image/webp';
    if (form === 'WAVE') return 'audio/wav';
    if (form.startsWith('AVI')) return 'video/x-msvideo';
  }

  // --- Audio ---
  if (ascii(0, 3) === 'ID3') return 'audio/mpeg';
  // MP3 frame sync (0xFFEx/0xFFFx) without an ID3 tag.
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
    return 'audio/mpeg';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';

  // --- ISO-BMFF (MP4/MOV/M4A): 'ftyp' box at offset 4, brand at offset 8 ---
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'audio/mp4';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }

  // --- Matroska / WebM (EBML header) ---
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';

  return undefined;
}

/**
 * Read a file's first bytes and sniff its media MIME by content. Best-effort:
 * returns undefined if the file can't be read or the signature is unknown.
 */
export async function sniffMediaMime(
  filePath: string,
): Promise<string | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return sniffMimeFromBytes(buf.subarray(0, bytesRead));
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
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
  // Identify by content first (magic bytes), not the extension: a recognized
  // signature is authoritative, so a mislabeled or extension-less media file is
  // still handled, and text files masquerading with a media extension are not.
  const sniffed = await sniffMediaMime(resolved);
  const extMime = getSpecificMimeType(resolved) ?? 'application/octet-stream';
  const mimeType = sniffed ?? extMime;
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
