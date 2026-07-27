/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { getMediaMemoryRoot } from '../../memory/media/media-paths.js';
import { MediaReadError } from './reader-registry.js';
import { modalityOf, probeMedia } from './probe.js';
import { getSpecificMimeType } from '../fileUtils.js';
import type { Modality, MediaProbe } from './types.js';

/**
 * Media source resolution — accept an http(s) URL (or a file:// URL) as media
 * input, not only a local path (方案 1.1.1: 字节形态由共享核心决定，模型不可见).
 *
 * The whole read trunk (probe → reader → ffprobe/ffmpeg) is built around a local
 * file. Rather than teach every stage to speak URLs, we materialize a remote URL
 * to a content-addressed local cache once, then run the existing local pipeline
 * unchanged. The cache is keyed by the URL's origin+pathname (NOT the query), so
 * a re-signed URL for the same object is a cache hit and is not re-downloaded.
 */

/** Default ceiling on a single remote media download (guards disk/DoS). 1 GiB. */
export const DEFAULT_MAX_REMOTE_MEDIA_BYTES = 1024 * 1024 * 1024;

/** Resolve the remote-download byte ceiling (env-overridable). */
export function getMaxRemoteMediaBytes(): number {
  const raw = process.env['QWEN_CODE_MAX_REMOTE_MEDIA_BYTES'];
  if (raw === undefined || raw.trim() === '')
    return DEFAULT_MAX_REMOTE_MEDIA_BYTES;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_REMOTE_MEDIA_BYTES;
}

/** True for an http(s) URL (a remote media source), vs a local filesystem path. */
export function isRemoteMediaUrl(src: string): boolean {
  return /^https?:\/\//i.test(src.trim());
}

/** True for a file:// URL (a local file expressed as a URL). */
export function isFileUrl(src: string): boolean {
  return /^file:\/\//i.test(src.trim());
}

/** True for any media source the tools accept besides a bare absolute path. */
export function isMediaUrl(src: string): boolean {
  return isRemoteMediaUrl(src) || isFileUrl(src);
}

/** Directory holding downloaded remote media (alongside the media memory store). */
export function getMediaRemoteDir(): string {
  return path.join(getMediaMemoryRoot(), 'remote');
}

/**
 * Describe a remote URL WITHOUT fetching it: infer modality + mime from the URL
 * path extension (query string ignored). Used by the direct-passthrough path to
 * decide whether the provider can fetch the URL itself (no download needed).
 */
export function describeRemoteUrl(url: string): {
  modality?: Modality;
  mimeType: string;
} {
  try {
    const u = new URL(url);
    const mimeType =
      getSpecificMimeType(u.pathname) ?? 'application/octet-stream';
    return { modality: modalityOf(mimeType), mimeType };
  } catch {
    return { mimeType: 'application/octet-stream' };
  }
}

/** Stable identity for a remote URL (origin+pathname, ignoring the query). */
export function hashRemoteUrl(url: string): string {
  try {
    const u = new URL(url);
    return createHash('sha256')
      .update(u.origin + u.pathname)
      .digest('hex');
  } catch {
    return createHash('sha256').update(url).digest('hex');
  }
}

function extFromUrl(u: URL): string {
  const ext = path.extname(u.pathname);
  // Only trust a short, alnum extension; otherwise let probe sniff by content.
  return /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : '';
}

export interface ResolvedMediaSource {
  /** Local filesystem path the pipeline should read. */
  path: string;
  /** Present when the input was remote — the original URL (原件位置). */
  sourceUrl?: string;
}

/**
 * Resolve a media source to a local path. Local paths and file:// URLs are
 * returned resolved (no download); remote http(s) URLs are downloaded (once) to
 * the content-addressed remote cache, subject to a size ceiling. Fails closed
 * with a MediaReadError carrying a remedy on fetch/size problems.
 */
export async function materializeMediaSource(
  src: string,
  signal: AbortSignal,
): Promise<ResolvedMediaSource> {
  if (isFileUrl(src)) {
    try {
      return { path: fileURLToPath(src.trim()) };
    } catch {
      throw new MediaReadError(
        'path-problem',
        `Not a valid file URL: ${src}`,
        'Provide a well-formed file:// URL or a local absolute path.',
      );
    }
  }
  if (!isRemoteMediaUrl(src)) {
    return { path: path.resolve(src) };
  }

  let u: URL;
  try {
    u = new URL(src);
  } catch {
    throw new MediaReadError(
      'path-problem',
      `Not a valid media URL: ${src}`,
      'Provide a well-formed http(s) URL or a local absolute path.',
    );
  }

  const key = createHash('sha256')
    .update(u.origin + u.pathname)
    .digest('hex');
  const dir = getMediaRemoteDir();
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, key + extFromUrl(u));

  // Cache hit: same object (ignoring the volatile query/signature) already local.
  try {
    const stat = await fs.stat(dest);
    if (stat.isFile() && stat.size > 0) return { path: dest, sourceUrl: src };
  } catch {
    // fall through to download
  }

  let res: Response;
  try {
    res = await fetch(src, { signal });
  } catch (err) {
    throw new MediaReadError(
      'path-problem',
      `Failed to fetch ${src}: ${err instanceof Error ? err.message : String(err)}`,
      'Check the URL is reachable (and, for signed URLs, not expired).',
    );
  }
  if (!res.ok || !res.body) {
    throw new MediaReadError(
      'path-problem',
      `Failed to fetch ${src}: HTTP ${res.status} ${res.statusText}`,
      'Check the URL is reachable and, for signed URLs, that it has not expired.',
    );
  }

  const maxBytes = getMaxRemoteMediaBytes();
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new MediaReadError(
      'over-budget',
      `Remote media ${src} is ${declared}B, over the ${maxBytes}B download limit.`,
      'Download a smaller file, raise QWEN_CODE_MAX_REMOTE_MEDIA_BYTES, or pass a local clipped copy.',
    );
  }

  const tmp = `${dest}.part`;
  let seen = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        cb(new Error(`exceeds ${maxBytes}B remote media download limit`));
        return;
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      cap,
      createWriteStream(tmp),
    );
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new MediaReadError(
      msg.includes('remote media download limit')
        ? 'over-budget'
        : 'path-problem',
      `Failed to download ${src}: ${msg}`,
      'Retry, use a smaller file / raise QWEN_CODE_MAX_REMOTE_MEDIA_BYTES, or pass a local path.',
    );
  }
  return { path: dest, sourceUrl: src };
}

/**
 * Resolve a media source to a local path and probe it — the single entry every
 * read path (readMedia, media_dispatch, media_extract) shares, so URL/file://
 * resolution and identification happen in exactly one place.
 */
export async function resolveAndProbe(
  filePath: string,
  signal: AbortSignal,
): Promise<{ probe: MediaProbe; sourceUrl?: string }> {
  const source = await materializeMediaSource(filePath, signal);
  const probe = await probeMedia(source.path);
  return source.sourceUrl !== undefined
    ? { probe, sourceUrl: source.sourceUrl }
    : { probe };
}
