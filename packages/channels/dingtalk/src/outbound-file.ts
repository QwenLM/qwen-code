import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, relative, sep } from 'node:path';
import { DingTalkMediaUploadError } from './outbound-image.js';

const FILE_OPENING = '[FILE:';
const MEDIA_UPLOAD_API = 'https://oapi.dingtalk.com/media/upload';
const MEDIA_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_FILE_PATH_CHARS = 4096;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const AUTH_ERROR_CODES = new Set([40014, 42001]);
export const MAX_FILES_PER_RESPONSE = 5;
export const FILE_UNAVAILABLE_NOTICE = '[File delivery unavailable]';

export interface FileProjection {
  text: string;
  paths: string[];
  invalidMarkers: number;
  excessMarkers: number;
  markerCount: number;
}

export interface ValidatedFile {
  data: Buffer;
  fileName: string;
  fileType: string;
}

export class OutboundFileProjector {
  private candidate = '';
  private reserved = '';
  private reservedAtLineStart = false;
  private reservedTooLong = false;
  private atLineStart = true;
  private readonly paths: string[] = [];
  private invalidMarkers = 0;
  private excessMarkers = 0;
  private markerCount = 0;

  append(chunk: string): string {
    let safe = '';
    for (const char of chunk) {
      if (this.reserved) {
        if (char === '\n') {
          this.finishReservedLine();
          safe += '\n';
          this.atLineStart = true;
        } else if (this.reserved.length <= MAX_FILE_PATH_CHARS + 9) {
          this.reserved += char;
        } else {
          this.reservedTooLong = true;
        }
        continue;
      }
      if (char === '\n') {
        safe += `${this.candidate}\n`;
        this.candidate = '';
        this.atLineStart = true;
        continue;
      }
      this.candidate += char;
      while (this.candidate && !FILE_OPENING.startsWith(this.candidate)) {
        safe += this.candidate[0];
        this.candidate = this.candidate.slice(1);
        this.atLineStart = false;
      }
      if (this.candidate === FILE_OPENING) {
        this.reserved = this.candidate;
        this.reservedAtLineStart = this.atLineStart;
        this.candidate = '';
        this.markerCount++;
      }
    }
    return safe;
  }

  complete(): string {
    if (!this.reserved) {
      const safe = this.candidate;
      this.candidate = '';
      return safe;
    }
    this.finishReservedLine();
    return '';
  }

  result(text: string): FileProjection {
    return {
      text,
      paths: [...this.paths],
      invalidMarkers: this.invalidMarkers,
      excessMarkers: this.excessMarkers,
      markerCount: this.markerCount,
    };
  }

  private finishReservedLine(): void {
    const match = /^\[FILE: ([^\]\r\n]+)\]\r?$/u.exec(this.reserved);
    const path = match?.[1];
    if (
      !this.reservedTooLong &&
      this.reservedAtLineStart &&
      path &&
      path.length <= MAX_FILE_PATH_CHARS &&
      path === path.trim()
    ) {
      if (this.paths.length < MAX_FILES_PER_RESPONSE) {
        this.paths.push(path);
      } else {
        this.excessMarkers++;
      }
    } else {
      this.invalidMarkers++;
    }
    this.reserved = '';
    this.reservedAtLineStart = false;
    this.reservedTooLong = false;
  }
}

/**
 * Redacts [FILE: ...] markers from one complete outbound text and returns
 * accepted paths separately. Detection deliberately scans the RAW text,
 * unlike the image path's maskCode scan, so a FILE-shaped example inside a
 * code fence is over-redacted rather than risking a leaked path.
 */
export function projectFileText(text: string): FileProjection {
  const projector = new OutboundFileProjector();
  const safe = projector.append(text) + projector.complete();
  return projector.result(safe);
}

export function withFileUnavailableNotice(text: string): string {
  const safe = text.trimEnd();
  return `${safe}${safe ? '\n' : ''}${FILE_UNAVAILABLE_NOTICE}`;
}

export function safeFileName(filePath: string): string {
  return (
    basename(filePath)
      .replace(/[\p{Cc}\p{Cf}[\]]+/gu, '_')
      .slice(0, 200) || 'file'
  );
}

function isInside(filePath: string, directory: string): boolean {
  const child = relative(directory, filePath);
  return (
    child === '' ||
    (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
  );
}

export function readValidatedFile(
  filePath: string,
  workspaceDir: string,
): ValidatedFile {
  if (!isAbsolute(filePath)) throw new Error('File path must be absolute');

  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    throw new Error('File not found');
  }
  const roots = [
    workspaceDir,
    tmpdir(),
    ...(process.platform === 'win32' ? [] : ['/tmp']),
  ].map((root) => realpathSync(root));
  if (!roots.some((root) => isInside(realPath, root))) {
    throw new Error('File path outside allowed directories');
  }
  if (!statSync(realPath).isFile()) throw new Error('Not a regular file');

  const descriptor = openSync(
    realPath,
    constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error('Not a regular file');
    if (stats.size === 0) throw new Error('File is empty');
    if (stats.size > MAX_FILE_BYTES) throw new Error('File is too large');

    const data = Buffer.allocUnsafe(stats.size + 1);
    let bytesRead = 0;
    while (bytesRead < data.length) {
      const count = readSync(
        descriptor,
        data,
        bytesRead,
        data.length - bytesRead,
        bytesRead,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead !== stats.size) throw new Error('File changed while read');

    const fileName = safeFileName(realPath);
    return {
      data: data.subarray(0, bytesRead),
      fileName,
      fileType: extname(fileName).slice(1).toLowerCase() || 'file',
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

export async function uploadDingTalkFile(
  file: ValidatedFile,
  accessToken: string,
): Promise<string> {
  const form = new FormData();
  form.append(
    'media',
    new Blob([file.data], { type: 'application/octet-stream' }),
    file.fileName,
  );

  let response: Response;
  try {
    const url = new URL(MEDIA_UPLOAD_API);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('type', 'file');
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new DingTalkMediaUploadError(
      'DingTalk file upload failed: network request failed',
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
      `DingTalk file upload failed: HTTP ${response.status} invalid JSON response`,
      response.status === 401,
    );
  }

  const errcode =
    typeof payload['errcode'] === 'number' ? payload['errcode'] : undefined;
  if (!response.ok || (errcode !== undefined && errcode !== 0)) {
    const detail = sanitizeApiMessage(payload['errmsg'], accessToken);
    throw new DingTalkMediaUploadError(
      `DingTalk file upload failed: HTTP ${response.status}${
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
      'DingTalk file upload failed: response did not include a MediaID',
      false,
    );
  }
  return mediaId;
}
