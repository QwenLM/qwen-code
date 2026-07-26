/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OSC 8 hyperlink helpers.
 *
 * The shared primitives — `sanitizeForOsc`, `osc8Hyperlink`,
 * `supportsHyperlinks`, `wrapForMultiplexer`, `HYPERLINK_ENV_KEYS` — now live
 * in `@qwen-code/qwen-code-core` so core-side emitters (e.g. the Qwen OAuth
 * device-flow fallback message) can wrap a URL in a single clickable link.
 * They are re-exported here so existing CLI imports of this module keep
 * resolving unchanged. The markdown-link and label-deception helpers below are
 * CLI-renderer-specific and stay here.
 *
 * Supported terminals (iTerm2 ≥ 3.1, WezTerm ≥ 20200620, Kitty, Ghostty,
 * Windows Terminal, VS Code ≥ 1.72, GNOME Terminal / VTE ≥ 0.50, …) render
 * an OSC 8 envelope as a clickable link that survives line wrapping.
 * Terminals without OSC 8 support ignore the escapes and print the visible
 * label as-is.
 */

import {
  osc8Hyperlink,
  sanitizeForOsc,
  supportsHyperlinks,
  wrapForMultiplexer,
  HYPERLINK_ENV_KEYS,
} from '@qwen-code/qwen-code-core';

export {
  osc8Hyperlink,
  sanitizeForOsc,
  supportsHyperlinks,
  wrapForMultiplexer,
  HYPERLINK_ENV_KEYS,
};

/**
 * Open half of an OSC 8 hyperlink envelope. Pair with `osc8Close()` to wrap
 * a styled label without losing the surrounding SGR resets — OSC 8 and SGR
 * are orthogonal so nested color styling is preserved by terminals that
 * honor the hyperlink sequence.
 */
export function osc8Open(url: string): string {
  return wrapForMultiplexer(`\x1b]8;;${sanitizeForOsc(url)}\x07`);
}

/** Close half of an OSC 8 hyperlink envelope. */
export function osc8Close(): string {
  return wrapForMultiplexer(`\x1b]8;;\x07`);
}

/**
 * Schemes safe to embed in an OSC 8 target. Restricting to network and mail
 * schemes prevents prompt-injection attacks from producing a one-click
 * `javascript:` / `data:` / `file:` trap whose target is hidden behind the
 * link label. Anything outside this set falls back to legacy `label (url)`
 * rendering so the user sees the suspicious URL before any click.
 *
 * When OSC 8 wrapping IS active the renderer drops the parenthesized URL
 * suffix and shows only the label — long URLs would otherwise clutter the
 * stream. Capable terminals expose the target via hover / status bar /
 * right-click "copy link", so the URL is still inspectable without
 * polluting the visible bytes. The scheme allowlist remains the front-line
 * defense against the click-deception case.
 */
const SAFE_OSC8_SCHEMES = new Set([
  'http:',
  'https:',
  'mailto:',
  'ftp:',
  'ftps:',
  'sftp:',
  'ssh:',
]);

/**
 * Return true if `url` carries an explicit allowlisted scheme. URLs without
 * a scheme (relative paths, `#anchor`, empty) are rejected — terminals can't
 * resolve them anyway, and rejecting them avoids creating un-clickable links.
 */
export function isSafeOscScheme(url: string): boolean {
  const match = url.match(/^([a-z][a-z0-9+.-]*:)/i);
  if (!match) return false;
  return SAFE_OSC8_SCHEMES.has(match[1]!.toLowerCase());
}

/**
 * Trim trailing sentence punctuation off a bare URL run before it becomes
 * an OSC 8 target. Models routinely produce `see https://example.com.` and
 * the inline regex greedily swallows the period; clicking the wrapped link
 * then opens a 404. The trailing characters stay in the visible text — only
 * the OSC 8 *target* is trimmed, so byte-output for unsupported terminals
 * is unchanged.
 *
 * The set of trimmable trailing characters matches GitHub / GitLab linkifier
 * behavior. We additionally rebalance a trailing `)` against opening `(` in
 * the URL so URLs that legitimately end with `)` (Wikipedia disambiguation,
 * MSDN) aren't truncated.
 */
export function trimTrailingUrlPunctuation(url: string): string {
  // Count `( [ {` opens once up-front; we then decrement running `)`/`]`/`}`
  // close counts as we trim, keeping the whole trim O(n) instead of O(n²)
  // for adversarial inputs like `https://x.com))))…`.
  let openParen = 0;
  let openBracket = 0;
  let openBrace = 0;
  let closeParen = 0;
  let closeBracket = 0;
  let closeBrace = 0;
  for (let i = 0; i < url.length; i++) {
    const cc = url.charCodeAt(i);
    if (cc === 0x28) openParen++;
    else if (cc === 0x5b) openBracket++;
    else if (cc === 0x7b) openBrace++;
    else if (cc === 0x29) closeParen++;
    else if (cc === 0x5d) closeBracket++;
    else if (cc === 0x7d) closeBrace++;
  }

  let end = url.length;
  while (end > 0) {
    const c = url.charCodeAt(end - 1);
    // .,;:!?'"`> — `>` covers CommonMark autolinks (`<https://x.com>`)
    // where the inline regex greedily eats the trailing `>` into `\S+`.
    if (
      c === 0x2e ||
      c === 0x2c ||
      c === 0x3b ||
      c === 0x3a ||
      c === 0x21 ||
      c === 0x3f ||
      c === 0x27 ||
      c === 0x22 ||
      c === 0x60 ||
      c === 0x3e
    ) {
      end--;
      continue;
    }
    // Trailing `)`/`]`/`}` only when unbalanced against opens in the prefix.
    if (c === 0x29 && closeParen > openParen) {
      closeParen--;
      end--;
      continue;
    }
    if (c === 0x5d && closeBracket > openBracket) {
      closeBracket--;
      end--;
      continue;
    }
    if (c === 0x7d && closeBrace > openBrace) {
      closeBrace--;
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

// ── Markdown link regex shared between the React and ANSI renderers ──────

/**
 * Inline link pattern allowing one level of balanced parens in the URL
 * group so `[wiki](https://en.wikipedia.org/wiki/Foo_(bar))` isn't truncated
 * at the inner `)`. Mirrors CommonMark's cap. Exposed for both the React
 * markdown renderer and the ANSI table renderer to keep them in lockstep.
 */
export const MD_LINK_PATTERN = String.raw`\[.*?\]\((?:[^()]|\([^()]*\))*\)`;

/**
 * Capture the label and URL out of a single matched link token. Anchored
 * with `^...$` because callers pass the whole match string.
 */
export const MD_LINK_CAPTURE = /^\[(.*?)\]\(((?:[^()]|\([^()]*\))*)\)$/;

/**
 * Should the markdown renderers wrap a `[label](url)` token in an OSC 8
 * envelope? Returns true only when (a) the host terminal advertises OSC 8,
 * (b) the URL uses an allowlisted network/mail scheme, and (c) the URL
 * contains no whitespace — every terminal rejects or silently truncates a
 * whitespace-bearing OSC 8 target, which would turn the whole region into
 * an un-clickable trap on capable terminals.
 *
 * Centralizing the predicate keeps the React renderer and the ANSI table
 * renderer in lockstep; if a future scheme is allowlisted, both pick it up.
 */
export function shouldWrapMarkdownLink(
  url: string,
  canHyperlink: boolean,
): boolean {
  return canHyperlink && isSafeOscScheme(url) && !/\s/.test(url);
}

/**
 * True if the visible label could deceive the user about where the link
 * actually points. The OSC 8 branch hides the URL target behind a clickable
 * label, so a model-emitted `[https://google.com](https://attacker.com)`
 * shows a label that *looks* like a different host than the click resolves
 * to — pre-OSC-8 rendering always kept `(url)` visible, so the deception
 * couldn't land. The fix is: when the label contains a URL-shaped substring
 * AND it doesn't equal the actual target, keep the `(url)` suffix visible
 * even though OSC 8 wrapping is otherwise active. The label is still
 * clickable (envelope is still emitted), but the user sees the real target.
 *
 * Three patterns trip the heuristic:
 *   1. Label contains `scheme://…` — covers `[https://google.com](https://evil.com)`.
 *   2. Label *starts* with a `scheme:` — covers `[mailto:x](mailto:y)`.
 *   3. Label contains a bare host token (`name.tld`) that doesn't equal the
 *      URL's hostname — covers the most common spoof shape an attacker
 *      would actually use: `[google.com](https://attacker.com)`.
 *
 * Heuristic is intentionally permissive: false positives just append a
 * harmless `(url)` suffix to niche labels (e.g. Python attrs like
 * `os.path` happen to look like a host); false negatives let a real spoof
 * through. ASCII-only hostname matching means an IDN-homograph attack
 * (Cyrillic `о` in `gооgle.com`) escapes the bare-host check, but the
 * fully-qualified-URL form of that same attack is still caught by pattern 1.
 */
const HOST_LIKE_RE =
  /\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.[a-z]{2,}\b/gi;

// Dotted-quad IPv4 in a label: `[1.1.1.1](https://attacker.com)` is the
// same class of click-deception as a bare hostname but `HOST_LIKE_RE`'s
// alphabetic-TLD anchor skips it. Each octet is loosely bounded to 1-3
// digits; over-permissive (e.g. `999.999.999.999`) is fine — false
// positives just keep an extra `(url)` suffix.
const IPV4_LIKE_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function targetHostname(url: string): string | undefined {
  try {
    const u = new URL(url);
    // `mailto:` URLs report an empty `hostname` — pull the domain out of
    // the email address after the `@` so labels like `[support@example.com]
    // (mailto:support@example.com)` don't trip the bare-host check.
    if (u.protocol === 'mailto:') {
      const at = u.pathname.lastIndexOf('@');
      return at >= 0
        ? u.pathname.slice(at + 1).toLowerCase() || undefined
        : undefined;
    }
    return u.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export function labelMayDeceive(label: string, url: string): boolean {
  if (label === url) return false;
  if (/:\/\//.test(label) || /^[a-z][a-z0-9+.-]*:/i.test(label.trim())) {
    return true;
  }
  const lower = label.toLowerCase();
  const labelHosts = [
    ...(lower.match(HOST_LIKE_RE) ?? []),
    ...(lower.match(IPV4_LIKE_RE) ?? []),
  ];
  if (labelHosts.length === 0) return false;
  const target = targetHostname(url);
  if (!target) return true;
  return labelHosts.some((h) => h !== target);
}
