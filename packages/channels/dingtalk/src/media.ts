/**
 * DingTalk media download helpers.
 *
 * Two-step flow:
 * 1. POST downloadCode to DingTalk API → get a temporary downloadUrl
 * 2. GET the downloadUrl → arraybuffer
 */

const DOWNLOAD_API =
  'https://api.dingtalk.com/v1.0/robot/messageFiles/download';

export interface MediaFile {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Download a media file from DingTalk using a downloadCode.
 *
 * @param downloadCode - The code from incoming message richText/content
 * @param robotCode - The bot's clientId (appKey)
 * @param accessToken - A valid DingTalk access token
 * @returns MediaFile with buffer and mimeType, or null on failure
 */
export async function downloadMedia(
  downloadCode: string,
  robotCode: string,
  accessToken: string,
): Promise<MediaFile | null> {
  if (!downloadCode || !robotCode || !accessToken) {
    return null;
  }

  try {
    // Step 1: Get downloadUrl from DingTalk API
    const apiResp = await fetch(DOWNLOAD_API, {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ downloadCode, robotCode }),
    });

    if (!apiResp.ok) {
      const detail = await apiResp.text().catch(() => '');
      process.stderr.write(
        `[DingTalk] downloadMedia API failed: HTTP ${apiResp.status} ${detail}\n`,
      );
      return null;
    }

    const payload = (await apiResp.json()) as Record<string, unknown>;
    const downloadUrl =
      (payload['downloadUrl'] as string) ??
      ((payload['data'] as Record<string, unknown>)?.['downloadUrl'] as string);

    if (!downloadUrl) {
      process.stderr.write(
        `[DingTalk] downloadMedia: no downloadUrl in response\n`,
      );
      return null;
    }

    // Step 2: Download the actual file
    const fileResp = await fetch(downloadUrl);
    if (!fileResp.ok) {
      process.stderr.write(
        `[DingTalk] downloadMedia file fetch failed: HTTP ${fileResp.status}\n`,
      );
      return null;
    }

    const mimeType =
      fileResp.headers.get('content-type') || 'application/octet-stream';
    const buffer = Buffer.from(await fileResp.arrayBuffer());

    return { buffer, mimeType };
  } catch (err) {
    process.stderr.write(
      `[DingTalk] downloadMedia error: ${err instanceof Error ? err.message : err}\n`,
    );
    return null;
  }
}
