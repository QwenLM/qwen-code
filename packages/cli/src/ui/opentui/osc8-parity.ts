/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI parity of the OSC 8 hyperlink security constraints from the ink
 * renderers (ui/utils/osc8.ts + InlineMarkdownRenderer + TableRenderer):
 * scheme allowlist, label-deception defense, unsafe/whitespace fallback to
 * the legacy `label (url)` spelling, and bare-URL target trimming. Output is
 * a plain string (envelope + visible text) that an OpenTUI text renderable
 * can emit unchanged, so both renderers stay in lockstep.
 */

import {
  osc8Open,
  osc8Close,
  isSafeOscScheme,
  trimTrailingUrlPunctuation,
  shouldWrapMarkdownLink,
  labelMayDeceive,
  sanitizeForOsc,
  supportsHyperlinks,
  osc8Hyperlink,
  wrapForMultiplexer,
  HYPERLINK_ENV_KEYS,
  MD_LINK_PATTERN,
  MD_LINK_CAPTURE,
} from '../utils/osc8.js';
import { unescapeMarkdownDollars } from '../utils/inline-math.js';

export {
  osc8Open,
  osc8Close,
  isSafeOscScheme,
  trimTrailingUrlPunctuation,
  shouldWrapMarkdownLink,
  labelMayDeceive,
  sanitizeForOsc,
  supportsHyperlinks,
  osc8Hyperlink,
  wrapForMultiplexer,
  HYPERLINK_ENV_KEYS,
  MD_LINK_PATTERN,
  MD_LINK_CAPTURE,
};

export interface Osc8LinkRender {
  /** Bytes to emit: optional OSC 8 envelope around the visible text. */
  text: string;
  /** True when the OSC 8 envelope was applied. */
  wrapped: boolean;
  /** True when the anti-deception `(url)` suffix was appended. */
  deceptionSuffix: boolean;
}

/**
 * Render one markdown `[label](url)` token with the ink
 * InlineMarkdownRenderer semantics:
 *  - OSC 8 active (capable terminal + allowlisted scheme + no whitespace):
 *    emit only the clickable label; an empty label falls back to the URL so
 *    the link stays discoverable. When the label could deceive about the
 *    real target (it looks like a different URL/host), keep the `(url)`
 *    suffix visible even though wrapping is active.
 *  - Otherwise: byte-identical legacy `label (url)` spelling so the user
 *    sees the suspicious target before any click.
 */
export function renderMarkdownLink(
  label: string,
  url: string,
  canHyperlink: boolean,
): Osc8LinkRender {
  // Ink unescapes backslash-dollars in BOTH branches before use (the
  // math-enabled markdown pipeline emits '\$' labels routinely).
  const renderedLabel = unescapeMarkdownDollars(label);
  const wrap = shouldWrapMarkdownLink(url, canHyperlink);
  if (!wrap) {
    return {
      text: `${renderedLabel} (${url})`,
      wrapped: false,
      deceptionSuffix: false,
    };
  }
  const safeLabel = sanitizeForOsc(renderedLabel);
  const safeUrl = sanitizeForOsc(url);
  const showSuffix = labelMayDeceive(safeLabel, safeUrl);
  const envelope = `${osc8Open(url)}${safeLabel || safeUrl}${osc8Close()}`;
  return {
    text: showSuffix ? `${envelope} (${safeUrl})` : envelope,
    wrapped: true,
    deceptionSuffix: showSuffix,
  };
}

/**
 * Render a bare `https://…` URL run with the ink InlineMarkdownRenderer
 * semantics: the OSC 8 *target* drops trailing sentence punctuation (so the
 * click resolves), while the visible text keeps it byte-for-byte for
 * terminals without OSC 8.
 */
export function renderBareUrl(
  url: string,
  canHyperlink: boolean,
  nextCharacter = '',
): Osc8LinkRender {
  const trimmed = canHyperlink
    ? trimTrailingUrlPunctuation(url, nextCharacter)
    : url;
  const wrap = canHyperlink && isSafeOscScheme(trimmed);
  if (!wrap) {
    return { text: url, wrapped: false, deceptionSuffix: false };
  }
  return {
    text: `${osc8Open(trimmed)}${url}${osc8Close()}`,
    wrapped: true,
    deceptionSuffix: false,
  };
}
