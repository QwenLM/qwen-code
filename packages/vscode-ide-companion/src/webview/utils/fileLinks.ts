/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * File-link detection for clicks inside the WebShell transcript.
 *
 * The legacy webui timeline intercepted file links through its own markdown
 * renderer (`onFileClick`). The shared WebShell transcript has no file-open
 * callback, so the companion intercepts anchor clicks at the container level
 * instead and posts the existing `openFile` message. The heuristics mirror
 * webui's MarkdownRenderer so identical markdown resolves identically.
 */

// Known file extensions for validation of explicit markdown links
const KNOWN_FILE_EXTENSIONS =
  /\.(tsx?|jsx?|css|scss|json|md|py|java|go|rs|c|cpp|h|hpp|sh|ya?ml|toml|xml|html|vue|svelte)$/i;

const safeDecodePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const normalizeExplicitFileLink = (raw: string): string => {
  const decoded = safeDecodePath(raw).replace(/\\/g, '/');

  // file:// URIs (e.g. from vscode.Uri.file().toString()) encode special
  // characters like # as %23 in the path component. After decoding the
  // full URI we can strip the scheme and return the filesystem path
  // directly — no fragment splitting needed, because any # in the
  // decoded result is a literal filename character, not an anchor.
  if (/^file:\/\//i.test(decoded)) {
    let filePath = decoded.replace(/^file:\/\/\//i, '');
    // On Unix the path should start with /
    if (!/^[a-zA-Z]:/.test(filePath) && !filePath.startsWith('/')) {
      filePath = '/' + filePath;
    }
    return filePath;
  }

  const hashIndex = decoded.indexOf('#');
  if (hashIndex < 0) {
    return decoded;
  }

  const base = decoded.slice(0, hashIndex);
  const fragment = decoded.slice(hashIndex + 1);
  const lineMatch = fragment.match(/^L?(\d+)(?:-\d+)?$/i);
  if (lineMatch) {
    return `${base}:${parseInt(lineMatch[1], 10)}`;
  }

  return base;
};

/**
 * Return the filesystem path an anchor points to when it is a file link,
 * or `null` for external/in-page links the browser should keep handling.
 */
export function resolveFileLinkFromAnchor(
  anchor: HTMLAnchorElement,
): string | null {
  const href = anchor.getAttribute('href') || '';

  // file:// URIs come from trusted system-generated content (e.g. /export).
  if (/^file:\/\//i.test(href)) {
    return normalizeExplicitFileLink(href);
  }

  // External schemes and fragment-only links stay with the browser.
  if (/^(https?|mailto|ftp|data):/i.test(href) || href.startsWith('#')) {
    return null;
  }

  // Explicit markdown file-path links (e.g. [report](/tmp/report.md)).
  // Falls back to the anchor text for anchors whose href was stripped by
  // markdown sanitizers, matching the legacy webui behavior.
  const text = (anchor.textContent || '').trim();
  const candidate = normalizeExplicitFileLink(href || text);

  const isAbsolutePath = /^(?:[a-zA-Z]:[/\\]|[/\\])/i.test(candidate);
  const isRelativeFile =
    !isAbsolutePath &&
    KNOWN_FILE_EXTENSIONS.test(candidate.replace(/:\d+(?::\d+)?$/, ''));

  if (isAbsolutePath || isRelativeFile) {
    return candidate;
  }

  return null;
}
