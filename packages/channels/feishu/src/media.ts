/**
 * Feishu media download helpers.
 *
 * Downloads images, files, audio, and video from Feishu using the
 * Open API: GET /im/v1/messages/:message_id/resources/:file_key
 */

const BASE_URL = 'https://open.feishu.cn/open-apis';

/** Validate Feishu ID format to prevent path traversal in URL interpolation. */
const FEISHU_ID_RE = /^[a-zA-Z0-9_.:-]+$/;

export interface MediaFile {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Download a media file from Feishu.
 *
 * @param messageId - The message ID containing the resource
 * @param fileKey - The file_key or image_key from the message content
 * @param resourceType - 'image' or 'file'
 * @param accessToken - A valid tenant access token
 * @returns MediaFile with buffer and mimeType, or null on failure
 */
export async function downloadMedia(
  messageId: string,
  fileKey: string,
  resourceType: 'image' | 'file',
  accessToken: string,
): Promise<MediaFile | null> {
  if (
    !messageId ||
    !fileKey ||
    !accessToken ||
    !FEISHU_ID_RE.test(messageId) ||
    !FEISHU_ID_RE.test(fileKey)
  ) {
    return null;
  }

  try {
    const url = `${BASE_URL}/im/v1/messages/${messageId}/resources/${fileKey}?type=${resourceType}`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      process.stderr.write(
        `[Feishu] downloadMedia failed: HTTP ${resp.status} ${detail}\n`,
      );
      return null;
    }

    const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
    const contentLength = resp.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
      process.stderr.write(
        `[Feishu] downloadMedia rejected: size ${contentLength} exceeds ${MAX_DOWNLOAD_BYTES} byte limit\n`,
      );
      return null;
    }

    const mimeType =
      resp.headers.get('content-type') || 'application/octet-stream';

    // Stream-read with size enforcement (handles chunked transfer without Content-Length)
    const reader = resp.body?.getReader();
    if (!reader) {
      return null;
    }
    const chunks: Buffer[] = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_DOWNLOAD_BYTES) {
        reader.cancel();
        process.stderr.write(
          `[Feishu] downloadMedia rejected: actual size exceeds ${MAX_DOWNLOAD_BYTES} byte limit\n`,
        );
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks);

    return { buffer, mimeType };
  } catch (err) {
    process.stderr.write(
      `[Feishu] downloadMedia error: ${err instanceof Error ? err.message : err}\n`,
    );
    return null;
  }
}
