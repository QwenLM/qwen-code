/**
 * QQ Bot inbound media helpers.
 *
 * QQ does not document how long an attachment URL stays valid, so callers
 * download immediately rather than storing the URL.
 */

export const QQ_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const QQ_VIDEO_MAX_BYTES = 20 * 1024 * 1024;
export const QQ_MAX_ATTACHMENTS = 5;

/**
 * Hosts QQ serves attachments from. The allowlist is the SSRF guard, so an
 * unknown host is rejected rather than fetched. `qq.com.cn` is included
 * because the platform serves attachments from `multimedia.nt.qq.com.cn`.
 */
const ALLOWED_HOST_SUFFIXES = ['.qq.com', '.qq.com.cn'];

export type QQAttachmentKind = 'image' | 'video';

export interface QQDownloadedAttachment {
  buffer: Buffer;
  mimeType: string;
}

export function classifyQQAttachment(
  contentType: string | undefined,
): QQAttachmentKind | undefined {
  switch (contentType) {
    case 'image/jpeg':
    case 'image/png':
    case 'image/gif':
      return 'image';
    case 'video/mp4':
      return 'video';
    default:
      return undefined;
  }
}

export async function downloadQQAttachment(
  url: string,
  maxBytes: number,
  declaredContentType?: string,
): Promise<QQDownloadedAttachment> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('invalid attachment URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`attachment URL must use https: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error(`attachment host not allowed: ${host}`);
  }

  const response = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    redirect: 'error',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && Number(declaredLength) > maxBytes) {
    // Release the connection instead of letting the unread body pin it.
    await response.body?.cancel();
    throw new Error(
      `declared size ${declaredLength} exceeds ${maxBytes} bytes`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('attachment response has no body');
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`size exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  const buffer = Buffer.concat(chunks);
  return { buffer, mimeType: resolveMimeType(buffer, declaredContentType) };
}

function resolveMimeType(
  data: Buffer,
  declaredContentType: string | undefined,
): string {
  const sniffed = sniffImageMime(data);
  if (sniffed) return sniffed;
  const declared = declaredContentType?.split(';')[0]?.trim().toLowerCase();
  if (declared && (declared === 'video/mp4' || declared.startsWith('image/'))) {
    return declared;
  }
  return 'application/octet-stream';
}

function sniffImageMime(data: Buffer): string | undefined {
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  return undefined;
}
