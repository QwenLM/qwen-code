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
 * stylesheets/fonts/images, JS network calls, protocol-relative URLs). The
 * generated wrapper also adds a browser CSP as a second no-egress guard.
 */
export function validateSelfContained(fragment: string): string | null {
  if (!fragment.trim()) {
    return 'Artifact file is empty — write the page content (a body-only HTML fragment) first.';
  }
  const scan = normalizeAttributeQuotes(fragment);

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

  // External resource references (src=/href=/srcset=/poster= → http(s):// or //).
  const extResource =
    /\b(?:src|srcset|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(scan) ??
    /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i.exec(scan);
  if (extResource) {
    return `Artifact must be self-contained — found an external reference (${truncate(extResource[0])}). Inline scripts/styles and embed assets as data: URIs.`;
  }

  const jsUri = /\b(?:href|src)\s*=\s*["']?\s*javascript\s*:/i.exec(scan);
  if (jsUri) {
    return `Artifact must be self-contained — found a javascript: URI (${truncate(jsUri[0])}). Use inline <script> blocks instead.`;
  }

  const extScript =
    /\b(?:fetch|WebSocket|XMLHttpRequest)\s*\(\s*["']\s*(?:https?|wss?):\/\//i.exec(
      scan,
    ) ??
    /\bimport\s*\(\s*["'](?:https?:)?\/\//i.exec(scan) ??
    /\bwindow\.open\s*\(/i.exec(scan) ??
    /\blocation\.\w+\s*[=(]/i.exec(scan) ??
    /\bnavigator\.sendBeacon\s*\(\s*["']\s*(?:https?:)?\/\//i.exec(scan);
  if (extScript) {
    return `Artifact must be self-contained — found browser network egress (${truncate(extScript[0])}). Embed data in the artifact instead of fetching it at runtime.`;
  }

  const metaRefresh =
    /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*\burl\s*=\s*(?:https?:)?\/\//i.exec(
      scan,
    );
  if (metaRefresh) {
    return `Artifact must be self-contained — found a meta refresh redirect (${truncate(metaRefresh[0])}).`;
  }

  // External CSS via @import or url(...) (fonts, background images, etc.).
  const extCss =
    /(?:@import\s+(?:url\()?|url\()\s*["']?\s*(?:https?:)?\/\//i.exec(scan);
  if (extCss) {
    return `Artifact must be self-contained — found an external CSS reference (${truncate(extCss[0])}). Inline CSS and embed fonts/images as data: URIs.`;
  }

  return null;
}

function normalizeAttributeQuotes(s: string): string {
  return s
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/&apos;|&#39;|&#x27;/gi, "'");
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none';">
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
