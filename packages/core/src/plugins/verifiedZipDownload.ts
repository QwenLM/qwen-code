/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND_TEMP_PATH_SLUG } from '../config/brand.js';
import { unmanagedRequest } from '../utils/fetch.js';
import { Sha256HexSchema } from './schemas.js';

const ZIP_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const ZIP_DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

export interface DownloadResult {
  zipPath: string;
  bytes: number;
}

/** Verify bytes before writing a ZIP. The caller owns the successful temp file. */
export async function downloadVerifiedZip(options: {
  url: string;
  sha256: string;
  expectedSize?: number;
  maxBytes: number;
  signal?: AbortSignal;
}): Promise<DownloadResult> {
  options.signal?.throwIfAborted();
  const { url, expectedSize, maxBytes } = options;
  const sha256 = Sha256HexSchema.parse(options.sha256);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid ZIP size limit ${maxBytes}`);
  }
  if (
    expectedSize !== undefined &&
    (!Number.isFinite(expectedSize) ||
      expectedSize <= 0 ||
      expectedSize > maxBytes)
  ) {
    throw new Error(`Invalid ZIP file_size ${expectedSize} (max ${maxBytes})`);
  }
  const zipPath = join(
    tmpdir(),
    `${BRAND_TEMP_PATH_SLUG}-plugin-${randomUUID()}.zip`,
  );
  try {
    const response = await unmanagedRequest(
      url,
      { signal: options.signal },
      {
        timeoutMs: ZIP_DOWNLOAD_TIMEOUT_MS,
        bodyIdleTimeoutMs: ZIP_DOWNLOAD_IDLE_TIMEOUT_MS,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `Plugin ZIP download failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body = response.body;
    if (!body) throw new Error('Plugin ZIP download: empty response body');
    const contentLengthHeader = response.headers.get('content-length');
    const declaredLength =
      contentLengthHeader === null ? NaN : Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await body.cancel().catch(() => {});
      throw new Error(
        `Plugin ZIP is too large: ${declaredLength} bytes (max ${maxBytes})`,
      );
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytes += value.byteLength;
        if (expectedSize !== undefined && bytes > expectedSize) {
          throw new Error(
            `Plugin ZIP download exceeds expected size ${expectedSize} (got >= ${bytes})`,
          );
        }
        if (bytes > maxBytes) {
          throw new Error(
            `Plugin ZIP is too large: exceeded ${maxBytes} bytes`,
          );
        }
        hash.update(value);
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    if (expectedSize !== undefined && bytes !== expectedSize) {
      throw new Error(
        `Plugin ZIP download size mismatch: expected ${expectedSize}, got ${bytes}`,
      );
    }
    const actual = hash.digest('hex');
    if (actual !== sha256) {
      throw new Error(
        `Plugin ZIP SHA256 mismatch: expected ${sha256}, got ${actual}`,
      );
    }
    options.signal?.throwIfAborted();
    await writeFile(zipPath, Buffer.concat(chunks, bytes), {
      mode: 0o600,
      flag: 'wx',
    });
    return { zipPath, bytes };
  } catch (error) {
    await rm(zipPath, { force: true }).catch(() => {});
    throw error;
  }
}
