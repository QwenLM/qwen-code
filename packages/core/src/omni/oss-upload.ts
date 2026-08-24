/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Self-hosted OSS delivery channel for omni media.
 *
 * DashScope's temporary upload channel returns an `oss://` reference that
 * only DashScope resolves (via the X-DashScope-OssResourceResolve header).
 * A self-hosted inference endpoint fetches media itself, so it needs a
 * plain https URL — hence a direct PUT into our own bucket plus a
 * presigned GET URL.
 */

import { createHmac } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { combineAbortSignals } from '../utils/abortController.js';
import {
  DashScopeUploader,
  OSS_URL_PREFIX,
  sanitizeFileName,
  summarizeHttpFailure,
  type DashScopeUploaderOptions,
  type FetchFn,
  type OmniUploadParams,
  type OmniUploader,
} from './upload.js';

/** Matches OmniUploadCache's default horizon: a URL that dies before the
 * cache entry does would make cache hits serve dead links. */
const DEFAULT_URL_TTL_HOURS = 47;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

export interface SelfHostedOssConfig {
  /** Host only, e.g. `oss-cn-shanghai-internal.aliyuncs.com`. */
  endpoint: string;
  bucket: string;
  /** Object key prefix without leading or trailing slashes. */
  prefix: string;
  accessKeyId: string;
  accessKeySecret: string;
  urlTtlHours: number;
}

function envValue(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * Read the self-hosted delivery config, or null when it is not fully
 * configured (bucket, endpoint and both credentials are all required).
 *
 * Read per call rather than snapshotted at module load: the values arrive
 * from `~/.qwen/.env`, which dotenv loads during settings resolution —
 * possibly after this module is first imported.
 */
export function readSelfHostedOssConfig(): SelfHostedOssConfig | null {
  const endpoint = envValue('OMNI_OSS_ENDPOINT')
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
  const bucket = envValue('OMNI_OSS_BUCKET');
  const accessKeyId = envValue('OMNI_OSS_ACCESS_KEY_ID');
  const accessKeySecret = envValue('OMNI_OSS_ACCESS_KEY_SECRET');
  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) return null;
  const ttlHours = Number(envValue('OMNI_OSS_URL_TTL_HOURS'));
  return {
    endpoint,
    bucket,
    prefix: envValue('OMNI_OSS_PREFIX').replace(/^\/+|\/+$/g, ''),
    accessKeyId,
    accessKeySecret,
    urlTtlHours:
      Number.isFinite(ttlHours) && ttlHours > 0
        ? ttlHours
        : DEFAULT_URL_TTL_HOURS,
  };
}

/**
 * Whether a fileUri came out of an omni delivery channel. Matching only the
 * `oss://` prefix would miss self-hosted deliveries, which silently
 * disables both the reactive degrade path and dead-URL cache hygiene.
 */
export function isOmniDeliveredUri(uri: string | undefined): boolean {
  if (!uri) return false;
  if (uri.startsWith(OSS_URL_PREFIX)) return true;
  const config = readSelfHostedOssConfig();
  if (!config) return false;
  try {
    return (
      new URL(uri).host === `${config.bucket}.${config.endpoint}`.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Whether an error message quotes a delivered media URL. The `oss://`
 * scheme is unmistakable; a self-hosted delivery has to be recognized by
 * its bucket host, because the provider quotes a plain https URL.
 */
export function mentionsOmniDeliveredUri(message: string): boolean {
  if (/oss:\/\//i.test(message)) return true;
  const config = readSelfHostedOssConfig();
  if (!config) return false;
  return message
    .toLowerCase()
    .includes(`${config.bucket}.${config.endpoint}`.toLowerCase());
}

/** Percent-encode each key segment; the signature uses the raw key. */
function encodeKeyPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Uploads media into our own bucket with OSS V1 header signing and hands
 * back a presigned GET URL the inference endpoint can fetch.
 */
export class OssDirectUploader implements OmniUploader {
  private readonly config: SelfHostedOssConfig;
  private readonly fetchFn: FetchFn;

  constructor(config: SelfHostedOssConfig, fetchFn: FetchFn = fetch) {
    this.config = config;
    this.fetchFn = fetchFn;
  }

  private get host(): string {
    return `${this.config.bucket}.${this.config.endpoint}`;
  }

  private sign(stringToSign: string): string {
    return createHmac('sha1', this.config.accessKeySecret)
      .update(stringToSign, 'utf8')
      .digest('base64');
  }

  private objectKey(filePath: string, sha256: string): string {
    const leaf = `${sha256.slice(0, 12)}-${sanitizeFileName(
      path.basename(filePath),
    )}`;
    return this.config.prefix ? `${this.config.prefix}/${leaf}` : leaf;
  }

  /** Presigned GET URL. Query-string signing covers the canonical resource
   * only, so the expiry is the sole revocation mechanism. */
  presignedUrl(key: string): string {
    const expires =
      Math.floor(Date.now() / 1000) +
      Math.round(this.config.urlTtlHours * 3600);
    const query = new URLSearchParams({
      OSSAccessKeyId: this.config.accessKeyId,
      Expires: String(expires),
      Signature: this.sign(
        `GET\n\n\n${expires}\n/${this.config.bucket}/${key}`,
      ),
    });
    return `https://${this.host}/${encodeKeyPath(key)}?${query}`;
  }

  async uploadFile(params: OmniUploadParams): Promise<string> {
    const { filePath, mimeType, sha256, signal } = params;
    const key = this.objectKey(filePath, sha256);
    // The signed Date must be the one we send: OSS recomputes the signature
    // over the received header.
    const date = new Date().toUTCString();
    const signature = this.sign(
      `PUT\n\n${mimeType}\n${date}\n/${this.config.bucket}/${key}`,
    );

    let blob: Blob;
    try {
      blob = await openAsBlob(filePath, { type: mimeType });
    } catch (err) {
      throw new Error(
        `Failed to open file for upload: ${path.basename(filePath)}: ${describe(err)}`,
      );
    }

    // Keep the combined signal live through body handling — undici cancels
    // in-flight body reads through the request signal.
    const combined = combineAbortSignals([signal], {
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    let failureSummary: string | undefined;
    try {
      const res = await this.fetchFn(
        `https://${this.host}/${encodeKeyPath(key)}`,
        {
          method: 'PUT',
          body: blob,
          headers: {
            Authorization: `OSS ${this.config.accessKeyId}:${signature}`,
            'Content-Type': mimeType,
            Date: date,
          },
          signal: combined.signal,
        },
      );
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
      } else {
        failureSummary = await summarizeHttpFailure(res);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error(`OSS media upload failed: ${describe(err)}`);
    } finally {
      combined.cleanup();
    }
    if (failureSummary) {
      throw new Error(`OSS media upload failed: ${failureSummary}`);
    }
    return this.presignedUrl(key);
  }
}

/**
 * Build the uploader for an already-resolved upload channel. The choice is
 * `selfHostedOss` being present, never a fresh environment read: resolution
 * and construction disagreeing would upload to the wrong place silently.
 *
 * Takes the fields structurally rather than importing `OmniUploadConfig`,
 * which would close an import cycle through `upload-config.ts`.
 */
export function createOmniUploader(
  upload: DashScopeUploaderOptions & { selfHostedOss?: SelfHostedOssConfig },
): OmniUploader {
  return upload.selfHostedOss
    ? new OssDirectUploader(upload.selfHostedOss)
    : new DashScopeUploader(upload);
}
