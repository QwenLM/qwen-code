/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure helpers for the Artifact tool: wrap a body-only HTML fragment into a
 * self-contained document, validate it has no external dependencies, and
 * normalize the title. No I/O — kept side-effect free so it is trivially
 * unit-testable and reused by every publisher backend.
 */

/** Upload/byte ceiling for a published artifact (mirrors CC's MAX_ARTIFACT_BYTES). */
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024; // 16 MB

/** Minimal CSS reset injected into every artifact so bare fragments look sane. */
const CSS_RESET = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:1.5rem;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1a1a1a;background:#fff}
img,svg,video,canvas{max-width:100%;height:auto}
pre,table{max-width:100%;overflow-x:auto}
:where(a){color:#0969da}`;

const DEFAULT_TITLE = 'Artifact';

/**
 * Collapses whitespace and clamps an artifact title to a sane length. Falls
 * back to a default so the document always has a usable <title>.
 */
export function sanitizeArtifactTitle(raw: string | undefined): string {
  const cleaned = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned || DEFAULT_TITLE;
}

/** HTML-escapes the few characters that matter inside a <title> element. */
function escapeForTitle(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Heuristic check that a fragment is a self-contained body fragment with no
 * external dependencies. Returns an error string (model-facing, actionable) or
 * null when the fragment passes.
 *
 * This is a deliberately simple scanner, not a full HTML/CSS/JS parser: it
 * catches the common mistakes (full-document wrappers, CDN scripts, external
 * stylesheets/fonts/images, protocol-relative URLs). For local publishing the
 * page runs from file:// with no network anyway; the strict no-egress
 * guarantee belongs to the host's CSP once remote publishing (option C) lands.
 */
export function validateSelfContained(fragment: string): string | null {
  if (!fragment.trim()) {
    return 'Artifact file is empty — write the page content (a body-only HTML fragment) first.';
  }

  // Must be a fragment, not a whole document — publishing adds the skeleton.
  // Only inspect the start (after leading whitespace and HTML comments) so a
  // page that merely mentions these tags in its body — a comment, or an escaped
  // code sample — is not falsely rejected.
  const head = fragment
    .replace(/^\s+/, '')
    .replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  const wrapperTag = /^(?:<!doctype\b|<html[\s>]|<head[\s>]|<body[\s>])/i.exec(
    head,
  );
  if (wrapperTag) {
    return `Write a body-only fragment — it starts with a full-document tag (${wrapperTag[0].trim()}). Omit <!doctype>, <html>, <head>, and <body>; they are added at publish time.`;
  }

  // External resource references (src=/href= → http(s):// or protocol-relative //).
  const extResource = /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(
    fragment,
  );
  if (extResource) {
    return `Artifact must be self-contained — found an external reference (${truncate(extResource[0])}). Inline scripts/styles and embed assets as data: URIs.`;
  }

  // External CSS via @import or url(...) (fonts, background images, etc.).
  const extCss =
    /(?:@import\s+(?:url\()?|url\()\s*["']?\s*(?:https?:)?\/\//i.exec(fragment);
  if (extCss) {
    return `Artifact must be self-contained — found an external CSS reference (${truncate(extCss[0])}). Inline CSS and embed fonts/images as data: URIs.`;
  }

  return null;
}

function truncate(s: string, max = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Wraps a body-only fragment into a complete, responsive, self-contained HTML
 * document with the given title and a baseline CSS reset.
 */
export function wrapArtifactHtml(
  bodyFragment: string,
  title: string | undefined,
): string {
  const safeTitle = escapeForTitle(sanitizeArtifactTitle(title));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>${CSS_RESET}</style>
</head>
<body>
${bodyFragment}
</body>
</html>
`;
}

/** UTF-8 byte length of a string. */
export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
