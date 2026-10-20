/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

const PASTED_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

/**
 * Classify a pasted blob as image-file-path(s).
 *
 * Some terminals and clipboard helpers handle an image paste by injecting the
 * saved file path as text (optionally prefixed with `@`, shell-escaped, or
 * space/newline-separated for multiple files) instead of routing through our
 * own Ctrl+V handler. Recognizing those lets Cmd+V (terminal-driven) converge
 * on the same attachment UX as Ctrl+V. Mirrors Claude Code's usePasteHandler:
 * split on newlines and on spaces that precede an absolute path (spaces inside
 * a path are shell-escaped), then normalize each token.
 *
 * @returns `imagePaths` (normalized tokens with an image extension) and
 *   `allImages` (true only when every token is such a path), so the caller can
 *   promote a pure image-path paste without swallowing mixed text.
 */
export function classifyPastedImagePaths(pasted: string): {
  imagePaths: string[];
  allImages: boolean;
} {
  const tokens = pasted
    .split(/ (?=@?\/|@?[A-Za-z]:\\)/)
    .flatMap((part) => part.split('\n'))
    .map((token) => token.trim())
    .filter(Boolean);
  const imagePaths: string[] = [];
  let allImages = tokens.length > 0;
  for (const token of tokens) {
    const normalized = token
      .replace(/^@/, '') // strip the `@` reference prefix
      .replace(/^["']|["']$/g, '') // strip surrounding quotes
      .replace(/\\ /g, ' '); // unescape shell-escaped spaces
    if (PASTED_IMAGE_EXTENSIONS.test(normalized)) {
      imagePaths.push(normalized);
    } else {
      allImages = false;
    }
  }
  return { imagePaths, allImages };
}
