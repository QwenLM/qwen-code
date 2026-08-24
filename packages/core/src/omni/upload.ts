/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import { combineAbortSignals } from '../utils/abortController.js';

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

/**
 * One media upload request. `sha256` is the caller's already-computed
 * content hash — both call sites hash before uploading, and the
 * self-hosted channel keys objects by it so a re-run of the same instance
 * overwrites its objects instead of accumulating copies.
 */
export interface OmniUploadParams {
  filePath: string;
  model: string;
  mimeType: string;
  sha256: string;
  signal?: AbortSignal;
}

/**
 * A delivery channel for omni media. Returns a URL the model endpoint can
 * read: an `oss://` reference DashScope resolves server-side, or a
 * presigned https URL for endpoints that only accept fetchable URLs.
 */
export interface OmniUploader {
  uploadFile(params: OmniUploadParams): Promise<string>;
}

export interface DashScopeUploaderOptions {
  /** DashScope API key (Bearer). */
  apiKey: string;
  /**
   * Chat-completions base URL (e.g. https://dashscope.aliyuncs.com/compatible-mode/v1).
   * The uploads endpoint lives at `<origin>/api/v1/uploads`; only the origin
   * is used. Defaults to the official public endpoint when omitted — but the
   * production gate (isOmniDeliveryActive) requires a concrete DashScope
   * baseUrl, so the credential is never sent to an origin the user did not
   * configure for this provider.
   */
  baseUrl?: string;
  fetchFn?: FetchFn;
}

const DEFAULT_ORIGIN = 'https://dashscope.aliyuncs.com';
const GET_POLICY_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
/** Credential reuse window: official policy validity is 300s; 240s keeps
 * a safety margin for the slowest accepted upload start. */
const CREDENTIAL_TTL_MS = 240_000;

interface CachedPolicy {
  policy: Promise<DashScopeUploadPolicy>;
  fetchedAt: number;
}

/** Module-level getPolicy cache: uploader instances are created per
 * delivery, so an instance-level cache would never hit. Keyed by
 * origin|model; in-flight promises are shared so N concurrent uploads
 * spawn one credential request (same pattern as the ffmpeg availability
 * cache). Rejections are evicted immediately. */
const credentialCache = new Map<string, CachedPolicy>();

/** Test-only. */
export function resetCredentialCacheForTests(): void {
  credentialCache.clear();
}

/** Strip everything but safe filename characters for the OSS object key. */
export function sanitizeFileName(name: string): string {
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

/**
 * Compact, injection-resistant summary of an upstream HTTP failure. The raw
 * body is deliberately NOT echoed (it can reach model-visible error text);
 * only the status plus parsed `code`/`message` fields survive, truncated.
 */
export async function summarizeHttpFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as {
      code?: string;
      message?: string;
      error?: { code?: string; message?: string };
    };
    const code = parsed.code ?? parsed.error?.code;
    const message = parsed.message ?? parsed.error?.message;
    const detail = [code, message]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
      .join(': ')
      .slice(0, 160);
    if (detail) return `HTTP ${res.status} (${detail})`;
  } catch {
    // Non-JSON body: report the status only.
  }
  return `HTTP ${res.status}`;
}

/** Rethrow user aborts untouched so cancellation propagates as
 * cancellation instead of being wrapped into a generic failure. Timeout
 * aborts (combined signal fired without the user signal) are NOT
 * rethrown — a timeout is a failure, not a cancellation. */
function rethrowIfAborted(err: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw err;
}

/** Abort-shaped rejection reason for a caller whose signal fired. */
function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('This operation was aborted', 'AbortError')
  );
}

/**
 * Settle with `shared` unless `signal` aborts first. The shared promise is
 * never cancelled — it keeps running for the other cache consumers — while
 * this caller rejects with its own abort reason. The abort listener is
 * removed as soon as the shared promise settles, so racing against a
 * long-lived caller signal does not accumulate listeners.
 */
function raceWithSignal<T>(
  shared: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
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

  /** Fetch a short-lived upload policy bound to `model`, reusing a cached
   * credential within its validity window. */
  async getPolicy(
    model: string,
    signal?: AbortSignal,
  ): Promise<DashScopeUploadPolicy> {
    // Include the credential identity: two API keys on the same origin
    // must not share upload policies (each policy scopes an account's
    // upload_dir).
    const keyDigest = createHash('sha256')
      .update(this.apiKey)
      .digest('hex')
      .slice(0, 16);
    const cacheKey = `${this.origin}|${model}|${keyDigest}`;
    const cached = credentialCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CREDENTIAL_TTL_MS) {
      return raceWithSignal(cached.policy, signal);
    }
    // The shared fetch runs under the internal timeout only — never a
    // caller's signal. A caller-owned signal aborting a shared promise
    // would poison it for every other caller awaiting the same entry;
    // instead each caller races the shared promise against its own
    // signal below, so an abort rejects that caller alone.
    const entry: CachedPolicy = {
      fetchedAt: Date.now(),
      policy: this.fetchPolicy(model),
    };
    credentialCache.set(cacheKey, entry);
    entry.policy.catch(() => {
      // Never cache a failed credential fetch. This handler also keeps an
      // abandoned shared rejection (all racers already aborted) from
      // surfacing as an unhandled rejection.
      if (credentialCache.get(cacheKey) === entry) {
        credentialCache.delete(cacheKey);
      }
    });
    return raceWithSignal(entry.policy, signal);
  }

  /** Uncached policy fetch. Runs solely under the internal timeout; caller
   * signals are handled per-caller in getPolicy so one caller's abort never
   * contaminates the shared cached promise. */
  private async fetchPolicy(model: string): Promise<DashScopeUploadPolicy> {
    const url = new URL('/api/v1/uploads', this.origin);
    url.searchParams.set('action', 'getPolicy');
    url.searchParams.set('model', model);

    // The combined signal must stay live until the response BODY has been
    // consumed, not just until headers arrive — undici cancels in-flight
    // body reads through the request signal, so cleaning up earlier would
    // leave a stalled body read unabortable (no timeout, no ESC).
    const combined = combineAbortSignals([], {
      timeoutMs: GET_POLICY_TIMEOUT_MS,
    });
    let failureSummary: string | undefined;
    let payload: { data?: Partial<DashScopeUploadPolicy> } | undefined;
    try {
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: combined.signal,
      });
      if (res.ok) {
        try {
          payload = (await res.json()) as typeof payload;
        } catch (err) {
          if (combined.signal.aborted) throw err;
          payload = undefined; // Malformed JSON → incomplete-payload error.
        }
      } else {
        failureSummary = await summarizeHttpFailure(res);
      }
    } catch (err) {
      throw new Error(
        `DashScope upload getPolicy request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      combined.cleanup();
    }
    if (failureSummary) {
      throw new Error(`DashScope upload getPolicy failed: ${failureSummary}`);
    }
    const data = payload?.data;
    if (
      !data?.policy ||
      !data.signature ||
      !data.upload_dir ||
      !data.upload_host ||
      !data.oss_access_key_id ||
      !data.x_oss_object_acl ||
      !data.x_oss_forbid_overwrite
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
        `Failed to open file for upload: ${path.basename(filePath)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    form.append('file', blob, path.basename(filePath));

    // Keep the combined signal live through the body handling (see
    // getPolicy for why cleanup must not run at headers-arrival time).
    const combined = combineAbortSignals([signal], {
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    let failureSummary: string | undefined;
    try {
      const res = await this.fetchFn(policy.upload_host, {
        method: 'POST',
        body: form,
        signal: combined.signal,
      });
      if (res.ok) {
        await res.body?.cancel().catch(() => {});
      } else {
        failureSummary = await summarizeHttpFailure(res);
      }
    } catch (err) {
      rethrowIfAborted(err, signal);
      throw new Error(
        `DashScope media upload failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      combined.cleanup();
    }
    if (failureSummary) {
      throw new Error(`DashScope media upload failed: ${failureSummary}`);
    }
    return `${OSS_URL_PREFIX}${key}`;
  }
}
