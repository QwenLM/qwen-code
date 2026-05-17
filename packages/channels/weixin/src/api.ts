/**
 * HTTP API wrapper for WeChat iLink Bot API.
 */

import type {
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  GetConfigResp,
  SendTypingReq,
  SendTypingResp,
  BaseInfo,
} from './types.js';

// ── Error handling ────────────────────────────────────────────────

/** Structured error from WeChat iLink Bot API. */
export class WeixinApiError extends Error {
  /** HTTP status code (0 if network/timeout error). */
  status: number;
  /** API-level return code (ret field in response body). */
  ret?: number;
  /** API-level error code (errcode field in response body). */
  errcode?: number;

  constructor(message: string, status: number, ret?: number, errcode?: number) {
    super(message);
    this.name = 'WeixinApiError';
    this.status = status;
    this.ret = ret;
    this.errcode = errcode;
  }
}

/** Errors that are safe to retry (transient / network). */
function isRetryableError(err: unknown): boolean {
  if (err instanceof WeixinApiError) {
    // Session expired — not retryable (needs re-login)
    if (err.errcode === -14) return false;
    // API-level transient errors (system busy, rate limit)
    if (err.errcode === -1 || err.errcode === 45011) return true;
    // ret field is used by getUploadUrl and other endpoints
    if (err.ret !== undefined && err.ret !== 0) return false;
    // Client errors (4xx except 429) — not retryable
    if (err.status >= 400 && err.status < 500) return err.status === 429;
    // Server errors (5xx) or network errors (status 0) — retryable
    return err.status === 0 || err.status >= 500;
  }
  if (err instanceof TypeError || (err as NodeJS.ErrnoException).code) {
    // Network errors (fetch TypeError, ECONNRESET, ETIMEDOUT, etc.)
    return true;
  }
  return false;
}

/** Exponential backoff retry wrapper. */
async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (err: unknown) {
      lastError = err;
      if (attempt > maxRetries || !isRetryableError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

// iLink Bot API protocol version we are compatible with.
// Used both in the request body (base_info.channel_version) and in the
// iLink-App-ClientVersion header (encoded as 0x00MMNNPP).
const ILINK_PROTOCOL_VERSION = '2.1.3';

function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

function baseInfo(): BaseInfo {
  return { channel_version: ILINK_PROTOCOL_VERSION };
}

function randomUin(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf));
}

export function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-WECHAT-UIN': randomUin(),
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(
      buildClientVersion(ILINK_PROTOCOL_VERSION),
    ),
  };
  if (token) {
    headers['AuthorizationType'] = 'ilink_bot_token';
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

async function post<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  timeoutMs = 40000,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    const resp = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // Try to parse the API error body for ret/errcode/errmsg
      let ret: number | undefined;
      let errcode: number | undefined;
      let errmsg: string | undefined;
      try {
        const errBody = (await resp.json()) as {
          ret?: number;
          errcode?: number;
          errmsg?: string;
        };
        ret = errBody.ret;
        errcode = errBody.errcode;
        errmsg = errBody.errmsg;
      } catch {
        // ignore parse errors — use status-based message
      }
      const message = errmsg
        ? `WeChat API error (HTTP ${resp.status}, ret=${ret}, errcode=${errcode}): ${errmsg}`
        : `WeChat API error (HTTP ${resp.status})`;
      throw new WeixinApiError(message, resp.status, ret, errcode);
    }
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
  timeoutMs = 40000,
  signal?: AbortSignal,
): Promise<GetUpdatesResp> {
  const body: GetUpdatesReq = {
    get_updates_buf: getUpdatesBuf,
    base_info: baseInfo(),
  };
  try {
    return await post<GetUpdatesResp>(
      baseUrl,
      '/ilink/bot/getupdates',
      body,
      token,
      timeoutMs,
      signal,
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  msg: SendMessageReq['msg'],
): Promise<void> {
  const body: SendMessageReq = { msg, base_info: baseInfo() };

  await retryWithBackoff(async (_attempt) => {
    const resp = await post<{
      ret?: number;
      errcode?: number;
      errmsg?: string;
    }>(baseUrl, '/ilink/bot/sendmessage', body, token);
    if (
      (resp.ret !== undefined && resp.ret !== 0) ||
      (resp.errcode !== undefined && resp.errcode !== 0)
    ) {
      throw new WeixinApiError(
        `sendMessage failed: ret=${resp.ret} errcode=${resp.errcode} ${resp.errmsg || ''}`,
        200,
        resp.ret,
        resp.errcode,
      );
    }
  });
}

export async function getConfig(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken?: string,
): Promise<GetConfigResp> {
  const body = {
    ilink_user_id: userId,
    context_token: contextToken,
    base_info: baseInfo(),
  };
  return post<GetConfigResp>(baseUrl, '/ilink/bot/getconfig', body, token);
}

export async function sendTyping(
  baseUrl: string,
  token: string,
  req: Omit<SendTypingReq, 'base_info'>,
): Promise<SendTypingResp> {
  const body: SendTypingReq = { ...req, base_info: baseInfo() };
  return post<SendTypingResp>(baseUrl, '/ilink/bot/sendtyping', body, token);
}

interface GetUploadUrlReq {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
  base_info: BaseInfo;
}

interface GetUploadUrlResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_full_url?: string;
  upload_param?: string;
  thumb_upload_param?: string;
}

/**
 * Request an upload URL and CDN credentials for media.
 * @param aeskeyHex 16-byte AES key as 32-char hex string (e.g. "00112233445566778899aabbccddeeff")
 * @returns Either the full CDN upload URL or the upload_param string
 */
export async function getUploadUrl(
  baseUrl: string,
  token: string,
  toUserId: string,
  filekey: string,
  rawsize: number,
  rawfilemd5: string,
  encryptedSize: number,
  aeskeyHex: string,
): Promise<string> {
  const body: GetUploadUrlReq = {
    filekey,
    media_type: 1,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize: encryptedSize,
    no_need_thumb: true,
    aeskey: aeskeyHex,
    base_info: baseInfo(),
  };

  return retryWithBackoff(async (_attempt) => {
    const resp = await post<GetUploadUrlResp>(
      baseUrl,
      '/ilink/bot/getuploadurl',
      body,
      token,
    );

    // Check API-level error first
    if (
      (resp.ret !== undefined && resp.ret !== 0) ||
      (resp.errcode !== undefined && resp.errcode !== 0)
    ) {
      throw new WeixinApiError(
        `getuploadurl failed: ret=${resp.ret} errcode=${resp.errcode ?? '(none)'} errmsg=${resp.errmsg || '(none)'}`,
        200,
        resp.ret,
        resp.errcode,
      );
    }

    // upload_full_url: CDN upload URL with all params embedded
    if (resp.upload_full_url) {
      return resp.upload_full_url;
    }

    // upload_param: CDN upload params only (must construct URL with filekey)
    if (resp.upload_param) {
      return resp.upload_param;
    }

    throw new WeixinApiError(
      `getuploadurl returned no URL: ret=${resp.ret} errcode=${resp.errcode ?? '(none)'} errmsg=${resp.errmsg || '(none)'}`,
      200,
      resp.ret,
      resp.errcode,
    );
  });
}

/** Upload encrypted media to CDN.
 *  If urlOrParam is a full URL, use it directly (host must match).
 *  If it's just a param, construct the URL. */
export async function uploadToCdn(
  urlOrParam: string,
  filekey: string,
  encryptedData: Buffer,
): Promise<string> {
  const CDN_HOST = 'novac2c.cdn.weixin.qq.com';

  let url: string;
  if (urlOrParam.startsWith('https://')) {
    const parsed = new URL(urlOrParam);
    if (parsed.hostname !== CDN_HOST) {
      throw new Error(`CDN upload URL has unexpected host: ${parsed.hostname}`);
    }
    url = urlOrParam;
  } else if (urlOrParam.startsWith('http://')) {
    throw new Error('CDN upload URL must use HTTPS');
  } else {
    url = `https://${CDN_HOST}/c2c/upload?encrypted_query_param=${encodeURIComponent(urlOrParam)}&filekey=${encodeURIComponent(filekey)}`;
  }

  return retryWithBackoff(async (_attempt) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: encryptedData,
        signal: controller.signal,
      });
      if (!resp.ok) {
        // Try to extract error details from CDN response
        let cdnErrMsg: string | undefined;
        let cdnRet: number | undefined;
        let cdnErrCode: number | undefined;
        try {
          const errBody = (await resp.json()) as {
            errmsg?: string;
            ret?: number;
            errcode?: number;
          };
          cdnErrMsg = errBody.errmsg;
          cdnRet = errBody.ret;
          cdnErrCode = errBody.errcode;
        } catch {
          // ignore
        }
        throw new WeixinApiError(
          cdnErrMsg
            ? `CDN upload failed: HTTP ${resp.status} — ${cdnErrMsg}`
            : `CDN upload failed: HTTP ${resp.status}`,
          resp.status,
          cdnRet,
          cdnErrCode,
        );
      }
      // Extract x-encrypted-param from response header
      const encryptParam = resp.headers.get('x-encrypted-param');
      if (!encryptParam) {
        throw new WeixinApiError(
          'CDN upload succeeded but missing x-encrypted-param header',
          resp.status,
        );
      }
      return encryptParam;
    } finally {
      clearTimeout(timeout);
    }
  });
}
