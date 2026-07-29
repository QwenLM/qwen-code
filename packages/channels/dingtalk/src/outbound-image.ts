import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, relative } from 'node:path';

const MEDIA_UPLOAD_API = 'https://oapi.dingtalk.com/media/upload';
const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp']);
const AUTH_ERROR_CODES = new Set([40014, 42001]);

export interface ImageMarker {
  start: number;
  end: number;
  path: string;
}

export interface ValidatedImage {
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

function maskCode(text: string): string {
  const masked = text.split('');
  const blank = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      if (masked[i] !== '\n') masked[i] = ' ';
    }
  };

  let offset = 0;
  while (offset < text.length) {
    if (text[offset] === '`') {
      let runLength = 1;
      while (text[offset + runLength] === '`') runLength++;
      const delimiter = '`'.repeat(runLength);
      const closing = text.indexOf(delimiter, offset + runLength);
      const newline =
        runLength >= 3 ? -1 : text.indexOf('\n', offset + runLength);
      const closesBeforeNewline =
        closing !== -1 && (newline === -1 || closing < newline);
      const end = closesBeforeNewline
        ? closing + runLength
        : newline === -1
          ? text.length
          : newline;
      blank(offset, end);
      offset = end;
      continue;
    }
    offset++;
  }

  return masked.join('');
}

export function findImageMarkers(text: string): ImageMarker[] {
  const visibleText = maskCode(text);
  const markerPattern = /\[IMAGE:\s*([^\]\r\n]+)\]/gi;
  const markers: ImageMarker[] = [];

  for (const match of visibleText.matchAll(markerPattern)) {
    const path = match[1]?.trim();
    if (!path || match.index === undefined) continue;
    markers.push({
      start: match.index,
      end: match.index + match[0].length,
      path,
    });
  }

  return markers;
}

export function replaceImageMarkers(
  text: string,
  markers: readonly ImageMarker[],
  replacements: readonly string[],
): string {
  if (markers.length !== replacements.length) {
    throw new Error('Image marker replacement count mismatch');
  }

  let result = text;
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i]!;
    result =
      result.slice(0, marker.start) +
      replacements[i]! +
      result.slice(marker.end);
  }
  return result;
}

export function sanitizeStreamingImageMarkers(text: string): string {
  const markers = findImageMarkers(text);
  let result = replaceImageMarkers(
    text,
    markers,
    markers.map(() => '[Image pending]'),
  );
  const visibleText = maskCode(result);
  const partialMarker =
    /\[(?:I(?:M(?:A(?:G(?:E(?::[^\]\r\n]*)?)?)?)?)?)?$/i.exec(visibleText);
  if (partialMarker?.index !== undefined) {
    result = `${result.slice(0, partialMarker.index)}[Image pending]`;
  }
  return result;
}

function isInside(realPath: string, directory: string): boolean {
  const pathFromDirectory = relative(directory, realPath);
  return (
    pathFromDirectory === '' ||
    (!pathFromDirectory.startsWith('..') && !isAbsolute(pathFromDirectory))
  );
}

function detectImageMime(data: Buffer): string {
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return 'image/png';
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp';
  }
  throw new Error('Unrecognized image format');
}

export function readValidatedImage(
  imagePath: string,
  options: {
    workspaceDir: string;
    temporaryDir?: string;
  },
): ValidatedImage {
  if (!isAbsolute(imagePath)) {
    throw new Error(`Image path must be absolute: ${imagePath}`);
  }

  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Image extension not allowed: ${extension}`);
  }

  let realPath: string;
  try {
    realPath = realpathSync(imagePath);
  } catch {
    throw new Error(`Image file not found: ${imagePath}`);
  }
  const allowedDirectories = [
    realpathSync(options.workspaceDir),
    realpathSync(options.temporaryDir ?? tmpdir()),
  ];
  if (!allowedDirectories.some((directory) => isInside(realPath, directory))) {
    throw new Error(`Image path outside allowed directories: ${realPath}`);
  }

  const descriptor = openSync(realPath, 'r');
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`Not a regular file: ${realPath}`);
    }
    if (stats.size > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image too large: ${stats.size} bytes (max ${MAX_IMAGE_BYTES})`,
      );
    }

    const header = Buffer.alloc(16);
    const bytesRead = readSync(descriptor, header, 0, header.length, 0);
    const mimeType = detectImageMime(header.subarray(0, bytesRead));
    const expectedMime: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    };
    if (mimeType !== expectedMime[extension]) {
      throw new Error(
        `Image type mismatch: ${extension} expects ${expectedMime[extension]} but got ${mimeType}`,
      );
    }

    return {
      data: readFileSync(descriptor),
      fileName: basename(realPath),
      mimeType,
    };
  } finally {
    closeSync(descriptor);
  }
}

function sanitizeApiMessage(message: unknown, accessToken: string): string {
  const value = String(message ?? '');
  return (accessToken ? value.replaceAll(accessToken, '[redacted]') : value)
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 200);
}

export async function uploadDingTalkImage(
  image: ValidatedImage,
  accessToken: string,
): Promise<string> {
  const form = new FormData();
  form.append(
    'media',
    new Blob([image.data], { type: image.mimeType }),
    image.fileName,
  );

  let response: Response;
  try {
    const url = new URL(MEDIA_UPLOAD_API);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('type', 'image');
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new DingTalkMediaUploadError(
      'DingTalk media upload failed: network request failed',
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
