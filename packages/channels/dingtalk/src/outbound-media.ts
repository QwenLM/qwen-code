const MEDIA_UPLOAD_API = 'https://oapi.dingtalk.com/media/upload';
const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;
const AUTH_ERROR_CODES = new Set([40014, 42001]);

export interface DingTalkUploadMedia {
  data: Buffer;
  fileName: string;
  mimeType: string;
}

export class DingTalkMediaUploadError extends Error {
  constructor(
    message: string,
    readonly authFailure: boolean,
  ) {
    super(message);
    this.name = 'DingTalkMediaUploadError';
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function sanitizeApiMessage(message: unknown, accessToken: string): string {
  const value = String(message ?? '');
  return (accessToken ? value.replaceAll(accessToken, '[redacted]') : value)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 200);
}

export async function uploadDingTalkMedia(
  media: DingTalkUploadMedia,
  accessToken: string,
  mediaType: 'image' | 'file',
): Promise<string> {
  const form = new FormData();
  form.append(
    'media',
    new Blob([media.data], { type: media.mimeType }),
    media.fileName,
  );

  let response: Response;
  try {
    const url = new URL(MEDIA_UPLOAD_API);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('type', mediaType);
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    // `AbortSignal.timeout` rejects with a TimeoutError DOMException. Folding it
    // into "network request failed" tells the user to check connectivity when
    // the real cause is a 20 MB upload that needed longer than the deadline.
    throw new DingTalkMediaUploadError(
      isTimeout(error)
        ? `DingTalk media upload failed: timed out after ${MEDIA_UPLOAD_TIMEOUT_MS}ms`
        : 'DingTalk media upload failed: network request failed',
      false,
    );
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = (await response.json()) as unknown;
    payload =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    throw new DingTalkMediaUploadError(
      `DingTalk media upload failed: HTTP ${response.status} invalid JSON response`,
      response.status === 401,
    );
  }

  const errcode =
    typeof payload['errcode'] === 'number' ? payload['errcode'] : undefined;
  if (!response.ok || (errcode !== undefined && errcode !== 0)) {
    const detail = sanitizeApiMessage(payload['errmsg'], accessToken);
    throw new DingTalkMediaUploadError(
      `DingTalk media upload failed: HTTP ${response.status}${
        errcode === undefined ? '' : ` errcode=${errcode}`
      }${detail ? ` ${detail}` : ''}`,
      response.status === 401 ||
        (errcode !== undefined && AUTH_ERROR_CODES.has(errcode)),
    );
  }

  const mediaId =
    typeof payload['media_id'] === 'string'
      ? payload['media_id']
      : typeof payload['mediaId'] === 'string'
        ? payload['mediaId']
        : undefined;
  if (!mediaId) {
    throw new DingTalkMediaUploadError(
      'DingTalk media upload failed: response did not include a MediaID',
      false,
    );
  }
  return mediaId;
}
