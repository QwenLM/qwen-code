/**
 * QQ Bot HTTP API client.
 *
 * Encapsulates all REST calls to the QQ Bot API:
 *  - Access token issuance
 *  - WebSocket Gateway URL resolution
 *  - Message sending (text / markdown)
 *  - Message recall
 *  - Rich-media (image / video / voice / file) upload
 */

import { createHash } from 'node:crypto';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_HOST = 'https://api.sgroup.qq.com';
const SANDBOX_HOST = 'https://sandbox.api.sgroup.qq.com';

/** Standard fetch timeout to avoid hanging on network failures. */
const FETCH_TIMEOUT = 15_000;

export interface TokenResponse {
  accessToken: string;
  expiresIn: number;
}

/**
 * Obtain an access token via appId + clientSecret.
 * Throws on HTTP errors or missing token in the response.
 */
export async function fetchAccessToken(
  appId: string,
  appSecret: string,
): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    process.stderr.write(`[QQ] Token request failed (HTTP ${resp.status})\n`);
    throw new Error(`QQ Bot token request failed (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error('QQ Bot token response missing access_token');
  }
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 7200,
  };
}

/**
 * Validate the WebSocket Gateway URL to enforce TLS and known hostname.
 * - Enforces wss:// protocol (hard boundary — throws on non-wss).
 * - Rejects hostnames outside `*.qq.com` (hard boundary).
 *
 * The QQ Bot Open Platform documents all endpoints under qq.com domains
 * (api.sgroup.qq.com, sandbox.api.sgroup.qq.com, bots.qq.com). Broader
 * suffixes like *.tencentcs.com would accept attacker-controlled Tencent
 * Cloud API Gateway default domains, creating a token-exfiltration vector
 * if /gateway is tampered with or misdirected.
 */
export function validateGatewayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'wss:') {
      throw new Error(
        `QQ Bot gateway URL must use wss:// protocol, got: ${parsed.protocol}`,
      );
    }
    // Hard reject: only allow documented QQ gateway hostnames
    if (!parsed.hostname.toLowerCase().endsWith('.qq.com')) {
      throw new Error(
        `QQ Bot gateway URL has unexpected hostname: ${parsed.hostname} (expected *.qq.com)`,
      );
    }
    const clean = new URL(url);
    clean.username = '';
    clean.password = '';
    return clean.href;
  } catch (e) {
    if (e instanceof TypeError) {
      throw new Error('QQ Bot gateway URL is not a valid URL');
    }
    throw e;
  }
}

/**
 * Resolve the WebSocket Gateway URL.
 * Throws on HTTP errors or missing URL in the response.
 */
export async function fetchGatewayUrl(
  accessToken: string,
  sandbox: boolean,
): Promise<string> {
  const gw = sandbox ? `${SANDBOX_HOST}/gateway` : `${API_HOST}/gateway`;

  const resp = await fetch(gw, {
    headers: { Authorization: `QQBot ${accessToken}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new Error(`QQ Bot gateway request failed (HTTP ${resp.status})`);
  }

  const data = (await resp.json()) as { url?: string };
  if (!data['url']) {
    throw new Error('QQ Bot gateway response missing WebSocket URL');
  }
  return validateGatewayUrl(data['url']);
}

/** Determine the API base URL from the sandbox flag. */
export function getApiBase(sandbox: boolean): string {
  return sandbox ? SANDBOX_HOST : API_HOST;
}

/**
 * Send a message chunk to a QQ chat.
 * Resolves on success; caller should handle errors and msg_seq tracking.
 */
export async function sendQQMessage(
  base: string,
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return requestQQApi(base, 'POST', path, accessToken, body);
}

/** HTTP methods the QQ Bot REST API uses for group management. */
export type QQApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Call a QQ Bot REST endpoint. Used for the group-management surface, where
 * one thin wrapper per endpoint would only restate the path: callers own the
 * path and interpret the status code and error body themselves.
 */
export async function requestQQApi(
  base: string,
  method: QQApiMethod,
  path: string,
  accessToken: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Authorization: `QQBot ${accessToken}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
}

/** A presigned part carries up to `block_size` (10 MiB in practice) and the
 *  platform asks callers to allow at least 5s, so FETCH_TIMEOUT is too tight. */
const UPLOAD_TIMEOUT = 120_000;

/** The platform's retryable upload failure (40093001) is real, not theoretical:
 *  a live probe hit it once on an otherwise identical request and the retry
 *  succeeded. */
const UPLOAD_ATTEMPTS = 3;

/** `md5_10m` covers only the first 10002432 bytes, not the whole file. */
const MD5_10M_BYTES = 10002432;

/** Backoff for the retryable failures reported before the response can name a
 *  delay of its own (upload_prepare). */
const RETRY_DELAY_FALLBACK_MS = 1000;

/** Platform rich-media types. An image, video, or voice file is rendered by the
 *  client; a file (`4`) is a downloadable card and the only type that accepts
 *  any format. */
export const QQ_FILE_TYPE = {
  image: 1,
  video: 2,
  voice: 3,
  file: 4,
} as const;

export type QQFileType = (typeof QQ_FILE_TYPE)[keyof typeof QQ_FILE_TYPE];

export type QQRichMediaScope = 'users' | 'groups';

export interface QQRichMediaUploadInput {
  base: string;
  accessToken: string;
  scope: QQRichMediaScope;
  chatId: string;
  fileName: string;
  bytes: Buffer;
  /** `file_type` sent with both the prepare and the merge call. */
  fileType: QQFileType;
}

export interface QQRichMediaUploadResult {
  /** Opaque handle for the send call's `media.file_info`; the platform says
   *  callers never need to parse it. */
  fileInfo: string;
  /** Seconds the handle stays valid; 0 means it does not expire. */
  ttl: number;
}

export type QQRichMediaStage = 'prepare' | 'part' | 'finish' | 'merge';

/** A failed rich-media call, carrying the platform's `err_code` when the body
 *  has one so the caller can decide whether a retry could help. */
export class QQRichMediaError extends Error {
  readonly stage: QQRichMediaStage;
  readonly status: number;
  readonly code: number | undefined;

  constructor(
    stage: QQRichMediaStage,
    status: number,
    code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'QQRichMediaError';
    this.stage = stage;
    this.status = status;
    this.code = code;
  }
}

/**
 * Upload local bytes to a QQ chat as rich media and return the `file_info`
 * handle the send call needs.
 *
 * The platform's chunked path is the only one that fits local files (the URL
 * path needs a public origin; the ≤5 MiB binary path cannot carry a larger
 * file), so this always goes: upload_prepare → PUT each part → part_finish →
 * merge with srv_send_msg=false. Nothing is delivered to the user here.
 */
export async function uploadQQRichMedia(
  input: QQRichMediaUploadInput,
): Promise<QQRichMediaUploadResult> {
  const { base, accessToken, scope, chatId, fileName, bytes, fileType } = input;
  const scopePath = `/v2/${scope}/${encodeURIComponent(chatId)}`;

  // prepare is retried too: the platform marks 40093001 and 850027 ("try again
  // later") as retryable on this endpoint, and the delay is not known until the
  // response arrives, so it uses the same bounded backoff.
  const prepared = await retrying(
    () =>
      uploadJson(
        base,
        accessToken,
        `${scopePath}/upload_prepare`,
        {
          file_type: fileType,
          file_size: String(bytes.length),
          file_name: fileName,
          md5: digest('md5', bytes),
          sha1: digest('sha1', bytes),
          md5_10m: digest('md5', bytes.subarray(0, MD5_10M_BYTES)),
        },
        'prepare',
      ),
    RETRY_DELAY_FALLBACK_MS,
  );

  const uploadId = stringField(prepared, 'upload_id');
  const blockSize = numberField(prepared, 'block_size');
  const parts = (
    Array.isArray(prepared['parts']) ? prepared['parts'] : []
  ).filter(
    (part): part is Record<string, unknown> =>
      typeof part === 'object' && part !== null,
  );
  if (!uploadId || blockSize <= 0 || parts.length === 0) {
    throw new QQRichMediaError(
      'prepare',
      200,
      undefined,
      'upload_prepare returned no upload_id, block_size or parts',
    );
  }
  const retryDelayMs =
    Math.max(1, numberField(prepared['upload_config'], 'retry_delay') || 1) *
    1000;

  // Cumulative offsets rather than `index * block_size`: the parts array is the
  // authority on the split, and the last part may be short.
  const ordered = [...parts].sort(
    (a, b) => numberField(a, 'index') - numberField(b, 'index'),
  );
  let offset = 0;
  for (const part of ordered) {
    const url = stringField(part, 'url') || stringField(part, 'presigned_url');
    const length = numberField(part, 'block_size') || blockSize;
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    if (!url || slice.length === 0) {
      throw new QQRichMediaError(
        'prepare',
        200,
        undefined,
        'upload_prepare returned a part without a URL or payload',
      );
    }
    await retrying(async () => {
      // Presigned URLs carry their own signature — the bot token must not be
      // attached here.
      const resp = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(slice),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT),
      });
      await resp.text().catch(() => '');
      if (!resp.ok) {
        throw new QQRichMediaError(
          'part',
          resp.status,
          undefined,
          `part upload failed (HTTP ${resp.status})`,
        );
      }
    }, retryDelayMs);

    await retrying(
      () =>
        uploadJson(
          base,
          accessToken,
          `${scopePath}/upload_part_finish`,
          {
            upload_id: uploadId,
            part_index: numberField(part, 'index'),
            block_size: length,
            md5: digest('md5', slice),
          },
          'finish',
        ),
      retryDelayMs,
    );
  }
  if (offset !== bytes.length) {
    throw new QQRichMediaError(
      'prepare',
      200,
      undefined,
      `upload_prepare parts cover ${offset} of ${bytes.length} bytes`,
    );
  }

  const merged = await retrying(
    () =>
      uploadJson(
        base,
        accessToken,
        `${scopePath}/files`,
        {
          upload_id: uploadId,
          file_type: fileType,
          file_name: fileName,
          srv_send_msg: false,
        },
        'merge',
      ),
    retryDelayMs,
  );
  const fileInfo = stringField(merged, 'file_info');
  if (!fileInfo) {
    throw new QQRichMediaError(
      'merge',
      200,
      undefined,
      'file upload returned no file_info',
    );
  }
  return { fileInfo, ttl: numberField(merged, 'ttl') };
}

/** POST a JSON body and return the parsed response, or a typed failure. */
async function uploadJson(
  base: string,
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
  stage: QQRichMediaStage,
): Promise<Record<string, unknown>> {
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `QQBot ${accessToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new QQRichMediaError(
      stage,
      resp.status,
      parseQQErrorCode(text),
      text.slice(0, 200) || `HTTP ${resp.status}`,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new QQRichMediaError(
      stage,
      resp.status,
      undefined,
      'response was not JSON',
    );
  }
}

/** Retry the failures the platform marks retryable, plus transport errors. */
async function retrying<T>(fn: () => Promise<T>, delayMs: number): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const retryable =
        !(error instanceof QQRichMediaError) ||
        error.code === 40093001 ||
        error.code === 850027 ||
        error.status === 429 ||
        error.status >= 500;
      if (!retryable || attempt >= UPLOAD_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function digest(algorithm: 'md5' | 'sha1', data: Buffer): string {
  return createHash(algorithm).update(data).digest('hex');
}

/** The platform's error code from a JSON error body, when it carries one. */
export function parseQQErrorCode(text: string): number | undefined {
  try {
    const body = JSON.parse(text) as { code?: unknown; err_code?: unknown };
    const code = body.code ?? body.err_code;
    return typeof code === 'number' ? code : undefined;
  } catch {
    return undefined;
  }
}

function stringField(source: unknown, key: string): string {
  if (typeof source !== 'object' || source === null) return '';
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function numberField(source: unknown, key: string): number {
  if (typeof source !== 'object' || source === null) return 0;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}
