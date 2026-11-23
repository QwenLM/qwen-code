/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** The bundled card asks for a copy; downloads use `ui/download-file`. */
export const COPY_CAPABILITY = 'qwen-code/generated-ui-copy';
export const COPY_WRITE = 'qwen-code/generated-ui-copy/write';

const MAX_COPY_BYTES = 16 * 1024;
const MAX_DOWNLOAD_BYTES = 64 * 1024;
const MAX_FILENAME_LENGTH = 100;
// The card's name plus the extension the App adds, the longest being '.json'.
const MAX_REQUEST_NAME_LENGTH = MAX_FILENAME_LENGTH + 5;
const EXTENSIONS: Readonly<Record<string, string>> = {
  'text/csv': '.csv',
  'text/plain': '.txt',
  'application/json': '.json',
  'text/markdown': '.md',
};

export type EffectStatus = 'copied' | 'copy-pending' | 'downloaded' | 'refused';

export interface DownloadFile {
  filename: string;
  mimeType: string;
  text: string;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The text of a valid copy request, checked here rather than trusted. */
export function copyRequestText(params: unknown): string | undefined {
  const text = (params as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' && text && utf8Bytes(text) <= MAX_COPY_BYTES
    ? text
    : undefined;
}

/** A safe name with the extension of its type; never a path. */
export function sanitizeFilename(name: string, mimeType: string): string {
  const extension = EXTENSIONS[mimeType] ?? '.txt';
  const base =
    (name.split(/[\\/]/).pop() ?? '')
      .replace(/[^\p{L}\p{N} ._-]+/gu, '-')
      .replace(/^[\s.-]+|[\s.]+$/g, '')
      .slice(0, MAX_FILENAME_LENGTH) || 'download';
  return base.toLowerCase().endsWith(extension) ? base : base + extension;
}

/**
 * The file of a valid `ui/download-file` request: exactly one embedded text
 * resource of an allowed type and size. Links and binary content are refused.
 */
export function downloadRequestFile(params: unknown): DownloadFile | undefined {
  const contents = (params as { contents?: unknown } | undefined)?.contents;
  if (!Array.isArray(contents) || contents.length !== 1) return undefined;
  const item = contents[0] as { type?: unknown; resource?: unknown };
  if (item?.type !== 'resource' || !item.resource) return undefined;
  const { uri, mimeType, text, blob } = item.resource as Record<
    string,
    unknown
  >;
  if (
    blob !== undefined ||
    typeof uri !== 'string' ||
    !uri.startsWith('file:///') ||
    typeof mimeType !== 'string' ||
    !Object.hasOwn(EXTENSIONS, mimeType) ||
    typeof text !== 'string' ||
    !text ||
    utf8Bytes(text) > MAX_DOWNLOAD_BYTES
  ) {
    return undefined;
  }
  let name: string;
  try {
    name = decodeURIComponent(uri.slice('file:///'.length));
  } catch {
    return undefined;
  }
  if (!name || name.length > MAX_REQUEST_NAME_LENGTH) return undefined;
  return { filename: sanitizeFilename(name, mimeType), mimeType, text };
}

/** Whether the browser accepted the write; it may refuse a stale gesture. */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Starts the browser download; whether the file is saved is up to it. */
export function startDownload(file: DownloadFile, doc = document): void {
  const url = URL.createObjectURL(
    new Blob([file.text], { type: file.mimeType }),
  );
  const link = doc.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.hidden = true;
  doc.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
