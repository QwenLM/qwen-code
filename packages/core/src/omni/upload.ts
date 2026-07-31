/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import path from 'node:path';

/** Prefix all DashScope instant-upload URLs share. */
export const OSS_URL_PREFIX = 'oss://';

/** getPolicy response payload (subset we use). */
export interface DashScopeUploadPolicy {
  policy: string;
  signature: string;
  upload_dir: string;
  upload_host: string;
  oss_access_key_id: string;
  x_oss_object_acl: string;
  x_oss_forbid_overwrite: string;
  max_file_size_mb?: number;
}

/** Injectable fetch so tests never hit the network. */
export type FetchFn = typeof fetch;

export interface DashScopeUploaderOptions {
  /** DashScope API key (Bearer). */
  apiKey: string;
  /**
   * Chat-completions base URL (e.g. https://dashscope.aliyuncs.com/compatible-mode/v1).
   * The uploads endpoint lives at `<origin>/api/v1/uploads`; only the origin
   * is used. Defaults to the official public endpoint when omitted.
   */
  baseUrl?: string;
  fetchFn?: FetchFn;
}

const DEFAULT_ORIGIN = 'https://dashscope.aliyuncs.com';
const GET_POLICY_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;

/** Strip everything but safe filename characters for the OSS object key. */
function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(-100) : 'file';
}

function uploadsOriginFromBaseUrl(baseUrl: string | undefined): string {
  if (!baseUrl) return DEFAULT_ORIGIN;
  try {
    return new URL(baseUrl).origin;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

function combineSignals(
  timeoutMs: number,
  signal: AbortSignal | undefined,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Client for DashScope's official temporary upload channel:
 * getPolicy → OSS multipart form POST → `oss://` URL usable as a media
 * URL in chat completions when the request carries the
 * `X-DashScope-OssResourceResolve: enable` header.
 *
 * S1 scope: no credential cache and no upload cache — every call performs
 * a fresh getPolicy + upload (S3 adds both). Files are streamed from disk
 * via openAsBlob, never buffered whole in memory.
 */
export class DashScopeUploader {
  private readonly apiKey: string;
  private readonly origin: string;
  private readonly fetchFn: FetchFn;

  constructor(options: DashScopeUploaderOptions) {
    this.apiKey = options.apiKey;
    this.origin = uploadsOriginFromBaseUrl(options.baseUrl);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /** Fetch a short-lived upload policy bound to `model`. */
  async getPolicy(
    model: string,
    signal?: AbortSignal,
  ): Promise<DashScopeUploadPolicy> {
    const url = new URL('/api/v1/uploads', this.origin);
    url.searchParams.set('action', 'getPolicy');
    url.searchParams.set('model', model);

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: combineSignals(GET_POLICY_TIMEOUT_MS, signal),
      });
    } catch (err) {
      throw new Error(
        `DashScope upload getPolicy request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `DashScope upload getPolicy failed: HTTP ${res.status} ${body.slice(0, 300)}`,
      );
    }
    const payload = (await res.json().catch(() => undefined)) as
      | { data?: Partial<DashScopeUploadPolicy> }
      | undefined;
    const data = payload?.data;
    if (
      !data?.policy ||
      !data.signature ||
      !data.upload_dir ||
      !data.upload_host ||
      !data.oss_access_key_id
    ) {
      throw new Error(
        'DashScope upload getPolicy returned an incomplete policy payload.',
      );
    }
    return data as DashScopeUploadPolicy;
  }

  /**
   * Upload a local file under a fresh policy for `model`. Returns the
   * `oss://` URL DashScope resolves at inference time.
   */
  async uploadFile(params: {
    filePath: string;
    model: string;
    mimeType: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const { filePath, model, mimeType, signal } = params;
    const policy = await this.getPolicy(model, signal);

    const key = `${policy.upload_dir}/${randomUUID().slice(0, 8)}-${sanitizeFileName(
      path.basename(filePath),
    )}`;

    const form = new FormData();
    // Field order mirrors the documented OSS PostObject contract: all
    // policy fields must precede the file part.
    form.append('OSSAccessKeyId', policy.oss_access_key_id);
    form.append('Signature', policy.signature);
    form.append('policy', policy.policy);
    form.append('x-oss-object-acl', policy.x_oss_object_acl);
    form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
    form.append('key', key);
    form.append('success_action_status', '200');

    let blob: Blob;
    try {
      blob = await openAsBlob(filePath, { type: mimeType });
    } catch (err) {
      throw new Error(
        `Failed to open file for upload: ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    form.append('file', blob, path.basename(filePath));

    let res: Response;
    try {
      res = await this.fetchFn(policy.upload_host, {
        method: 'POST',
        body: form,
        signal: combineSignals(UPLOAD_TIMEOUT_MS, signal),
      });
    } catch (err) {
      throw new Error(
        `DashScope media upload failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `DashScope media upload failed: HTTP ${res.status} ${body.slice(0, 300)}`,
      );
    }
    await res.body?.cancel().catch(() => {});
    return `${OSS_URL_PREFIX}${key}`;
  }
}
