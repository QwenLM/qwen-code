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
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
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
  await post(baseUrl, '/ilink/bot/sendmessage', body, token);
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
  const resp = await post<GetUploadUrlResp>(
    baseUrl,
    '/ilink/bot/getuploadurl',
    body,
    token,
  );

  // upload_full_url: CDN upload URL with all params embedded
  if (resp.upload_full_url) {
    return resp.upload_full_url;
  }

  // upload_param: CDN upload params only (must construct URL with filekey)
  if (resp.upload_param) {
    return resp.upload_param;
  }

  throw new Error(
    `getuploadurl failed: ret=${resp.ret} errmsg=${resp.errmsg || '(none)'}`,
  );
}

/** Upload encrypted media to CDN.
 *  If urlOrParam is a full URL, use it directly.
 *  If it's just a param, construct the URL. */
export async function uploadToCdn(
  urlOrParam: string,
  filekey: string,
  encryptedData: Buffer,
): Promise<string> {
  const url = urlOrParam.startsWith('http')
    ? urlOrParam
    : `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=${encodeURIComponent(urlOrParam)}&filekey=${encodeURIComponent(filekey)}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedData,
  });
  if (!resp.ok) {
    throw new Error(`CDN upload failed: HTTP ${resp.status}`);
  }
  // Extract x-encrypted-param from response header
  const encryptParam = resp.headers.get('x-encrypted-param');
  if (!encryptParam) {
    throw new Error(
      'CDN upload succeeded but missing x-encrypted-param header',
    );
  }
  return encryptParam;
}
