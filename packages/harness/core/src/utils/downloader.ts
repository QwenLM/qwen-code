/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP file downloader for environment preparation.
 *
 * Uses the global `fetch()` (backed by undici, already configured with
 * proxy / timeout via the existing fetch.ts infrastructure) to download
 * files to disk via streaming.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { once } from 'node:events';
import { BRAND_CLI_BIN, BRAND_WEBSITE_URL } from '../config/brand.js';
import { getErrorMessage } from './errors.js';
import { runLogger } from './runLogger.js';

export interface DownloadConfig {
  /** Download timeout in ms. Default: 10 minutes. */
  timeout: number;
  /** Maximum acceptable response size in bytes. Default: 1 GB. */
  maxSize: number;
}

const DEFAULT_CONFIG: DownloadConfig = {
  timeout: 10 * 60 * 1000, // 10 min
  maxSize: 1024 * 1024 * 1024, // 1 GB
};

/** User-Agent header sent with download requests. */
const USER_AGENT = `${BRAND_CLI_BIN}-envprep (${BRAND_WEBSITE_URL})`;

/** Progress logging interval in bytes (every 5 MB). */
const PROGRESS_LOG_INTERVAL = 5 * 1024 * 1024;

export class Downloader {
  private readonly config: DownloadConfig;

  constructor(config?: Partial<DownloadConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Downloads a file from `url` to `destPath`.
   *
   * - Creates parent directories automatically.
   * - Cleans up the destination file on failure.
   * - Supports cancellation via an optional `AbortSignal`.
   */
  async download(
    url: string,
    destPath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const partPath = destPath + '.part';
    runLogger.log(
      `[envprep/downloader] Starting download: ${url} → ${destPath}`,
    );

    // Ensure parent dir exists
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    const downloadSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;

    let response: Response;
    try {
      response = await fetch(url, {
        signal: downloadSignal,
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      throw new Error(`Failed to fetch ${url}: ${getErrorMessage(err)}`);
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      runLogger.warn(
        `[envprep/downloader] HTTP ${response.status} ${response.statusText} for ${url}`,
      );
      throw new Error(
        `Download failed with HTTP ${response.status}: ${response.statusText}`,
      );
    }

    // Size guard
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > this.config.maxSize) {
      clearTimeout(timeoutId);
      runLogger.warn(
        `[envprep/downloader] File too large: ${contentLength} bytes (max: ${this.config.maxSize}) for ${url}`,
      );
      throw new Error(
        `File too large: ${contentLength} bytes (max: ${this.config.maxSize})`,
      );
    }

    if (!response.body) {
      clearTimeout(timeoutId);
      throw new Error('Response body is null');
    }

    // Stream to disk with progress logging
    const fileStream = fs.createWriteStream(partPath, {
      mode: 0o644,
      flags: 'w',
    });
    const closed = new Promise<void>((resolve) => fileStream.once('close', resolve));

    // Attach error handler immediately to avoid unhandled 'error' events
    // during the write loop (e.g. ENOSPC). Store for later re-throw.
    let streamError: Error | undefined;
    fileStream.once('error', (err) => {
      streamError = err;
    });

    try {
      const reader = response.body.getReader();
      let totalBytes = 0;
      let lastLoggedMB = 0;
      const startTime = Date.now();

      for (;;) {
        downloadSignal.throwIfAborted();
        if (streamError) throw streamError;

        const { done, value } = await reader.read();
        if (done) break;

        // Hard cap: enforce maxSize on the actual streamed bytes, not just the
        // (optional, untrusted) Content-Length header. Checked before writing so
        // an oversized chunk is never persisted. Throwing routes to the catch
        // block below, which destroys the stream and removes .part.
        if (totalBytes + value.byteLength > this.config.maxSize) {
          throw new Error(
            `File too large: exceeded max size of ${this.config.maxSize} bytes`,
          );
        }

        const drained = fileStream.write(value);
        totalBytes += value.byteLength;

        const currentMB = Math.floor(totalBytes / PROGRESS_LOG_INTERVAL);
        if (currentMB > lastLoggedMB) {
          lastLoggedMB = currentMB;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          runLogger.debug(
            `[envprep/downloader] Downloaded ${currentMB * 5} MB in ${elapsed}s`,
          );
        }

        // Respect backpressure — pause reading until the stream drains
        if (!drained) {
          await once(fileStream, 'drain', { signal: downloadSignal });
        }
      }

      // Wait for the write stream to finish and flush to disk
      await new Promise<void>((resolve, reject) => {
        fileStream.end(() => {
          if (streamError) {
            reject(streamError);
            return;
          }
          // fsync ensures data is flushed to persistent storage before
          // the caller performs an atomic rename.
          const fd = (fileStream as unknown as { fd: number | null }).fd;
          if (fd !== null) {
            try {
              fs.fsyncSync(fd);
            } catch {
              runLogger.warn(
                '[envprep/downloader] fsync warning: could not sync file',
              );
            }
          }
          resolve();
        });
        fileStream.once('error', reject);
      });
      await closed;
      downloadSignal.throwIfAborted();
    } catch (err) {
      // Clean up partial file
      fileStream.destroy();
      await closed;
      try {
        fs.unlinkSync(partPath);
      } catch {
        /* ignore */
      }
      throw new Error(`Failed to write ${partPath}: ${getErrorMessage(err)}`);
    } finally {
      clearTimeout(timeoutId);
    }

    const partStat = fs.statSync(partPath);
    if (contentLength > 0 && partStat.size !== contentLength) {
      try {
        fs.unlinkSync(partPath);
      } catch {
        /* ignore */
      }
      throw new Error(
        `Download incomplete: received ${partStat.size} bytes, expected ${contentLength}`,
      );
    }

    try {
      fs.unlinkSync(destPath);
    } catch {
      /* may not exist */
    }
    fs.renameSync(partPath, destPath);

    // Verify the file was written
    try {
      const stat = fs.statSync(destPath);
      runLogger.log(
        `[envprep/downloader] Download complete: ${stat.size} bytes`,
      );
    } catch {
      throw new Error(`Downloaded file missing: ${destPath}`);
    }
  }
}
