/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { fileUriToLocalPath, isFileUri, isUncPath } from './file-uri.js';

const PASTED_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Classify a pasted blob as image-file-path(s).
 *
 * Some terminals and clipboard helpers handle an image paste by injecting the
 * saved file path as text (optionally prefixed with `@`, shell-escaped, or
 * space/newline-separated for multiple files) instead of routing through our
 * own Ctrl+V handler. Recognizing those lets Cmd+V (terminal-driven) converge
 * on the same attachment UX as Ctrl+V. Mirrors Claude Code's usePasteHandler:
 * split on newlines and on spaces that precede a path outside quotes, while
 * preserving quoted or shell-escaped spaces, then normalize each token.
 *
 * @returns `imagePaths` (normalized tokens with an image extension) and
 *   `allImages` (true only when every token is such a path), so the caller can
 *   promote a pure image-path paste without swallowing mixed text.
 */
export function classifyPastedImagePaths(pasted: string): {
  imagePaths: string[];
  allImages: boolean;
} {
  const input = pasted.trim();
  const tokens: string[] = [];
  const pathStart = /@?["']?(?:\/|[A-Za-z]:\\|\\\\|file:)/iy;
  let start = 0;
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (
      (char === '"' || char === "'") &&
      (i === start || (i === start + 1 && input[start] === '@'))
    ) {
      quote = char;
      continue;
    }
    if (char === '\\' && input[i + 1] === ' ') {
      i++;
      continue;
    }
    if (char !== '\n' && char !== ' ') continue;
    pathStart.lastIndex = i + 1;
    if (char === ' ' && !pathStart.test(input)) continue;
    const token = input.slice(start, i).trim();
    if (token) tokens.push(token);
    start = i + 1;
  }
  const lastToken = input.slice(start).trim();
  if (lastToken) tokens.push(lastToken);
  const imagePaths: string[] = [];
  let allImages = tokens.length > 0;
  for (const token of tokens) {
    let normalized = token
      .replace(/^@/, '') // strip the `@` reference prefix
      .replace(/^["']|["']$/g, '') // strip surrounding quotes
      .replace(/\\ /g, ' '); // unescape shell-escaped spaces
    if (isFileUri(normalized)) {
      // A terminal or helper may inject the uri-list form of a copied file.
      const localPath = fileUriToLocalPath(normalized);
      if (localPath === null) {
        // A remote host or no local path on this platform: nothing to stat.
        allImages = false;
        continue;
      }
      normalized = localPath;
    } else if (isUncPath(normalized)) {
      // fs.stat on a UNC share authenticates to its host (Windows SMB).
      allImages = false;
      continue;
    }
    if (PASTED_IMAGE_EXTENSIONS.test(normalized)) {
      imagePaths.push(normalized);
    } else {
      allImages = false;
    }
  }
  return { imagePaths, allImages };
}
