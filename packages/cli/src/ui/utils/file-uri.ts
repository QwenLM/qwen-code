/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileURLToPath } from 'node:url';

/**
 * A `\\host\share` or `//host/share` path: on Windows, fs.stat on it opens an
 * authenticated SMB session to that host.
 */
export function isUncPath(candidate: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(candidate);
}

/** Whether `text` is spelled as a `file:` URI; the scheme is case-insensitive. */
export function isFileUri(text: string): boolean {
  return /^file:/i.test(text);
}

/**
 * The local path a `file:` URI names, or null when it names none. URL
 * parsing is the one authority: every legal spelling converts (`file:/a`,
 * `FILE:///a`, `file://localhost/a`, which normalises to an empty host) and
 * the name is percent-decoded. A remote host, or a path that resolves to a
 * UNC share or that this platform cannot express, yields null.
 */
export function fileUriToLocalPath(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'file:' || url.host !== '') {
    return null;
  }
  try {
    const localPath = fileURLToPath(url);
    return isUncPath(localPath) ? null : localPath;
  } catch {
    return null;
  }
}
