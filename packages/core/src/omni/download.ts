/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isPrivateHost, isPermittedRedirect } from '../utils/fetch.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('omni:download');

/** Thrown for URL localization failures. Messages must stay free of
 * credentials; they may include the URL host and HTTP status. */
export class OmniDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmniDownloadError';
  }
}

export interface DownloadedMedia {
  /** Path of the fully-written temp file (inside downloads/). Caller is
   * responsible for recognition, promotion into objects/, and cleanup. */
  partPath: string;
  /** SHA-256 computed while streaming (identity of the downloaded bytes). */
  sha256: string;
  /** Total bytes written. */
  sizeBytes: number;
  /** Final URL after any permitted redirects. */
  finalUrl: string;
  /** Content-Type reported by the server (advisory only — sniff decides). */
  contentType?: string;
}

const HEADER_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;

/** Test whether an @-path is a downloadable http(s) URL. */
export function parseHttpUrlRef(pathName: string): URL | null {
  if (!/^https?:\/\//i.test(pathName)) return null;
  try {
    return new URL(pathName);
  } catch {
    return null;
  }
}

/**
 * Stream a media URL into `downloads/<id>.part`, hashing while writing.
 *
 * Policy (mirrors utils/fetch.ts fetchWithPolicy, but streaming — that
 * helper buffers whole bodies in memory and is unsuitable for GiB media):
 * - https or http; private/loopback hosts refused (SSRF);
 * - redirects followed only when same-host/protocol/port (isPermittedRedirect),
 *   bounded by MAX_REDIRECTS;
 * - `maxBytes` enforced against BOTH Content-Length and actual bytes written;
 * - two-timer model: header timeout (30s, cleared when headers arrive) plus
 *   an idle watchdog reset per chunk (60s) — a slow large body is fine, a
 *   stalled one is not;
 * - on ANY failure the `.part` file is removed (no half-download survives).
 */
export async function downloadMediaUrl(params: {
  url: string;
  downloadsDir: string;
  maxBytes: number;
  signal?: AbortSignal;
  fetchFn?: typeof fetch;
}): Promise<DownloadedMedia> {
  const { url, downloadsDir, maxBytes, signal } = params;
  const fetchFn = params.fetchFn ?? fetch;

  if (isPrivateHost(url)) {
    throw new OmniDownloadError(
      `URL host is not publicly routable (refused for safety): ${new URL(url).hostname}`,
    );
  }

  await fs.mkdir(downloadsDir, { recursive: true, mode: 0o700 });
  const partPath = path.join(
    downloadsDir,
    `${randomBytes(8).toString('hex')}.part`,
  );

  let currentUrl = url;
  try {
    for (let redirects = 0; ; redirects++) {
      const headerAbort = new AbortController();
      const headerTimer = setTimeout(
        () => headerAbort.abort(new Error('header timeout')),
        HEADER_TIMEOUT_MS,
      );
      const combined = AbortSignal.any(
        signal ? [signal, headerAbort.signal] : [headerAbort.signal],
      );
      let res: Response;
      try {
        res = await fetchFn(currentUrl, {
          redirect: 'manual',
          signal: combined,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new OmniDownloadError(
          `Download request failed for ${new URL(currentUrl).hostname}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        clearTimeout(headerTimer);
      }

      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get('location');
        if (!location || redirects >= MAX_REDIRECTS) {
          throw new OmniDownloadError(
            `Too many or invalid redirects downloading from ${new URL(currentUrl).hostname}`,
          );
        }
        const redirectUrl = new URL(location, currentUrl).toString();
        if (!isPermittedRedirect(currentUrl, redirectUrl)) {
          throw new OmniDownloadError(
            `Cross-origin redirect refused: ${new URL(currentUrl).hostname} → ${new URL(redirectUrl).hostname}`,
          );
        }
        currentUrl = redirectUrl;
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new OmniDownloadError(
          `Download failed: HTTP ${res.status} from ${new URL(currentUrl).hostname}`,
        );
      }

      const contentLength = Number(res.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new OmniDownloadError(
          `Download exceeds the omni media limit: Content-Length ${contentLength} > ${maxBytes} bytes.`,
        );
      }
      if (!res.body) {
        throw new OmniDownloadError('Download response had no body.');
      }

      // Stream to disk with hash + byte cap + idle watchdog.
      const hash = createHash('sha256');
      let written = 0;
      const idleAbort = new AbortController();
      let idleTimer = setTimeout(
        () => idleAbort.abort(new Error('idle timeout')),
        IDLE_TIMEOUT_MS,
      );
      const streamSignal = AbortSignal.any(
        signal ? [signal, idleAbort.signal] : [idleAbort.signal],
      );
      try {
        const source = Readable.fromWeb(
          res.body as import('node:stream/web').ReadableStream,
          { signal: streamSignal },
        );
        const counter = async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(
              () => idleAbort.abort(new Error('idle timeout')),
              IDLE_TIMEOUT_MS,
            );
            written += chunk.length;
            if (written > maxBytes) {
              throw new OmniDownloadError(
                `Download exceeds the omni media limit: >${maxBytes} bytes received.`,
              );
            }
            hash.update(chunk);
            yield chunk;
          }
        };
        await pipeline(
          source,
          counter,
          createWriteStream(partPath, { mode: 0o600 }),
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err instanceof OmniDownloadError) throw err;
        throw new OmniDownloadError(
          `Download interrupted from ${new URL(currentUrl).hostname}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        clearTimeout(idleTimer);
      }

      debugLogger.debug(
        `downloaded ${written} bytes from ${new URL(currentUrl).hostname}`,
      );
      return {
        partPath,
        sha256: hash.digest('hex'),
        sizeBytes: written,
        finalUrl: currentUrl,
        contentType: res.headers.get('content-type') ?? undefined,
      };
    }
  } catch (err) {
    await fs.rm(partPath, { force: true });
    throw err;
  }
}
