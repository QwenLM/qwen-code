/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import stringWidth from 'string-width';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { renderInlineLatex } from './latexRenderer.js';
import {
  BARE_URL_PATTERN,
  MD_LINK_CAPTURE,
  MD_LINK_PATTERN,
  isSafeOscScheme,
  labelMayDeceive,
  osc8Close,
  osc8Open,
  sanitizeForOsc,
  shouldWrapMarkdownLink,
  supportsHyperlinks,
  trimTrailingUrlPunctuation,
} from './osc8.js';
import {
  INLINE_CODE_SPAN_PATTERN_SOURCE,
  mergeInlineMathMatches,
  unescapeMarkdownBeforeMath,
  unescapeMarkdownDollars,
} from './inline-math.js';

// Constants for Markdown parsing
const BOLD_MARKER_LENGTH = 2; // For "**"
const ITALIC_MARKER_LENGTH = 1; // For "*" or "_"
const STRIKETHROUGH_MARKER_LENGTH = 2; // For "~~")
const INLINE_CODE_MARKER_LENGTH = 1; // For "`"
const UNDERLINE_TAG_START_LENGTH = 3; // For "<u>"
const UNDERLINE_TAG_END_LENGTH = 4; // For "</u>"
const INLINE_MARKDOWN_REGEX = new RegExp(
  String.raw`(\*\*.*?\*\*|\*.*?\*|(?<![\w\u3400-\u9fff])_(?!_)[^_]*_(?![\w\u3400-\u9fff])|~~.*?~~|${MD_LINK_PATTERN}|` +
    String.raw`${INLINE_CODE_SPAN_PATTERN_SOURCE}|<u>.*?<\/u>|${BARE_URL_PATTERN})`,
  'g',
);

const debugLogger = createDebugLogger('INLINE_MARKDOWN');

interface RenderInlineProps {
  text: string;
  textColor?: string;
  enableInlineMath?: boolean;
}

type InlineTokenPlan =
  | { kind: 'bold'; visible: string }
  | { kind: 'italic'; visible: string }
  | { kind: 'strikethrough'; visible: string }
  | { kind: 'underline'; visible: string }
  | { kind: 'code'; visible: string }
  | { kind: 'plain'; visible: string }
  | {
      kind: 'link';
      visible: string;
      osc8: boolean;
      label: string;
      url: string;
      suffixUrl: string | null;
    }
  | { kind: 'bareUrl'; visible: string; oscUrl: string | null };

/**
 * One arm per RenderInline render branch — including the guards that make an
 * arm not apply — so what a caller measures and what gets drawn cannot drift.
 */
const planInlineToken = (
  fullMatch: string,
  text: string,
  index: number,
  canHyperlink: boolean,
): InlineTokenPlan => {
  if (
    fullMatch.startsWith('**') &&
    fullMatch.endsWith('**') &&
    fullMatch.length > BOLD_MARKER_LENGTH * 2
  ) {
    return {
      kind: 'bold',
      visible: unescapeMarkdownDollars(
        fullMatch.slice(BOLD_MARKER_LENGTH, -BOLD_MARKER_LENGTH),
      ),
    };
  }

  if (
    fullMatch.length > ITALIC_MARKER_LENGTH * 2 &&
    ((fullMatch.startsWith('*') && fullMatch.endsWith('*')) ||
      (fullMatch.startsWith('_') && fullMatch.endsWith('_'))) &&
    !/\w/.test(text.substring(index - 1, index)) &&
    !/\w/.test(
      text.substring(index + fullMatch.length, index + fullMatch.length + 1),
    ) &&
    !/\S[./\\]/.test(text.substring(index - 2, index)) &&
    !/[./\\]\S/.test(
      text.substring(index + fullMatch.length, index + fullMatch.length + 2),
    )
  ) {
    return {
      kind: 'italic',
      visible: unescapeMarkdownDollars(
        fullMatch.slice(ITALIC_MARKER_LENGTH, -ITALIC_MARKER_LENGTH),
      ),
    };
  }

  if (
    fullMatch.startsWith('~~') &&
    fullMatch.endsWith('~~') &&
    fullMatch.length > STRIKETHROUGH_MARKER_LENGTH * 2
  ) {
    return {
      kind: 'strikethrough',
      visible: unescapeMarkdownDollars(
        fullMatch.slice(
          STRIKETHROUGH_MARKER_LENGTH,
          -STRIKETHROUGH_MARKER_LENGTH,
        ),
      ),
    };
  }

  if (
    fullMatch.startsWith('`') &&
    fullMatch.endsWith('`') &&
    fullMatch.length > INLINE_CODE_MARKER_LENGTH
  ) {
    const codeMatch = fullMatch.match(/^(`+)(.+?)\1$/s);
    if (codeMatch && codeMatch[2]) {
      return { kind: 'code', visible: codeMatch[2] };
    }
  }

  if (
    fullMatch.startsWith('[') &&
    fullMatch.includes('](') &&
    fullMatch.endsWith(')')
  ) {
    const linkMatch = fullMatch.match(MD_LINK_CAPTURE);
    if (linkMatch) {
      const linkText = linkMatch[1] ?? '';
      const url = linkMatch[2] ?? '';
      const wrapOsc8 = shouldWrapMarkdownLink(url, canHyperlink);
      // With OSC 8 active the target lives in the envelope, so repeating a
      // long URL as plain text would only clutter the output: the visible
      // bytes are the label alone, with empty labels (`[](url)`) falling back
      // to the URL so the link stays discoverable. Without OSC 8 the output
      // stays byte-identical to the legacy `label (url)` form so the target
      // stays readable and copyable. The label is inside the clickable
      // region, so a bidi / C0 / C1 byte there would spoof it even though the
      // OSC target is sanitized — the sanitizer runs over the label AND any
      // URL bytes that become visible when OSC 8 is active, and leaves both
      // intact on the legacy path.
      const renderedLinkText = unescapeMarkdownDollars(linkText);
      const safeLabel = wrapOsc8
        ? sanitizeForOsc(renderedLinkText)
        : renderedLinkText;
      const safeUrl = wrapOsc8 ? sanitizeForOsc(url) : url;
      // Keep the `(url)` suffix visible when the label itself looks like a
      // (mismatched) URL — eliding it would let
      // `[https://google.com](https://attacker.com)` present a clickable
      // "google.com" that resolves elsewhere.
      const showUrlSuffix = wrapOsc8 && labelMayDeceive(safeLabel, safeUrl);
      return {
        kind: 'link',
        osc8: wrapOsc8,
        label: wrapOsc8 ? safeLabel || safeUrl : renderedLinkText,
        url,
        suffixUrl: showUrlSuffix ? safeUrl : null,
        visible: wrapOsc8
          ? `${safeLabel || safeUrl}${showUrlSuffix ? ` (${safeUrl})` : ''}`
          : `${renderedLinkText} (${url})`,
      };
    }
  }

  if (
    fullMatch.startsWith('<u>') &&
    fullMatch.endsWith('</u>') &&
    fullMatch.length > UNDERLINE_TAG_START_LENGTH + UNDERLINE_TAG_END_LENGTH - 1 // -1 because length is compared to combined length of start and end tags
  ) {
    return {
      kind: 'underline',
      visible: unescapeMarkdownDollars(
        fullMatch.slice(UNDERLINE_TAG_START_LENGTH, -UNDERLINE_TAG_END_LENGTH),
      ),
    };
  }

  if (/^https?:\/\//.test(fullMatch)) {
    // The bare-URL regex greedily eats trailing punctuation (`.`, `)`,
    // `,`, …). Trim that off the OSC 8 *target* so the clickable link
    // resolves correctly, while leaving the visible bytes unchanged so
    // unsupported terminals see today's output exactly. The bare-URL
    // alternative is anchored on `https?://`, so `isSafeOscScheme` is
    // redundant but kept as a cheap defense-in-depth assertion.
    const trimmedUrl = canHyperlink
      ? trimTrailingUrlPunctuation(fullMatch, text[index + fullMatch.length])
      : fullMatch;
    const wrapOsc8 = canHyperlink && isSafeOscScheme(trimmedUrl);
    return {
      kind: 'bareUrl',
      visible: fullMatch,
      oscUrl: wrapOsc8 ? trimmedUrl : null,
    };
  }

  return { kind: 'plain', visible: unescapeMarkdownDollars(fullMatch) };
};

const renderInlineToken = (key: string, plan: InlineTokenPlan) => {
  if (plan.kind === 'bold') {
    return (
      <Text key={key} bold>
        {plan.visible}
      </Text>
    );
  }
  if (plan.kind === 'italic') {
    return (
      <Text key={key} italic>
        {plan.visible}
      </Text>
    );
  }
  if (plan.kind === 'strikethrough') {
    return (
      <Text key={key} strikethrough>
        {plan.visible}
      </Text>
    );
  }
  if (plan.kind === 'underline') {
    return (
      <Text key={key} underline>
        {plan.visible}
      </Text>
    );
  }
  if (plan.kind === 'code') {
    return (
      <Text key={key} color={theme.text.code}>
        {plan.visible}
      </Text>
    );
  }
  if (plan.kind === 'link') {
    return plan.osc8 ? (
      <Text key={key}>
        <Text color={theme.text.link}>
          {osc8Open(plan.url)}
          {plan.label}
          {osc8Close()}
        </Text>
        {plan.suffixUrl !== null ? (
          <Text color={theme.text.link}> ({plan.suffixUrl})</Text>
        ) : null}
      </Text>
    ) : (
      <Text key={key}>
        {plan.label}
        <Text color={theme.text.link}> ({plan.url})</Text>
      </Text>
    );
  }
  if (plan.kind === 'bareUrl') {
    return (
      <Text key={key} color={theme.text.link}>
        {plan.oscUrl !== null ? osc8Open(plan.oscUrl) : null}
        {plan.visible}
        {plan.oscUrl !== null ? osc8Close() : null}
      </Text>
    );
  }
  return <Text key={key}>{plan.visible}</Text>;
};

const RenderInlineInternal: React.FC<RenderInlineProps> = ({
  text,
  textColor = theme.text.primary,
  enableInlineMath = false,
}) => {
  // Early return for plain text without markdown or URLs
  if (
    !/[*_~`<[]|https?:/.test(text) &&
    !(enableInlineMath && text.includes('$')) &&
    !text.includes('\\$')
  ) {
    return <Text color={textColor}>{text}</Text>;
  }

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  // Capability is stable for the duration of a single render — read it once
  // here so each matched link/URL doesn't re-walk the env-var table.
  const canHyperlink = supportsHyperlinks();
  for (const token of mergeInlineMathMatches(
    text,
    INLINE_MARKDOWN_REGEX,
    enableInlineMath,
  )) {
    const index =
      token.kind === 'math' ? token.span.index : (token.match.index ?? 0);

    if (index > lastIndex) {
      const prose = text.slice(lastIndex, index);
      nodes.push(
        <Text key={`t-${lastIndex}`}>
          {token.kind === 'math'
            ? unescapeMarkdownBeforeMath(prose)
            : unescapeMarkdownDollars(prose)}
        </Text>,
      );
    }

    if (token.kind === 'math') {
      nodes.push(
        <Text key={`m-${index}`} color={theme.text.accent}>
          {renderInlineLatex(unescapeMarkdownDollars(token.span.content))}
        </Text>,
      );
      lastIndex = index + token.span.raw.length;
      continue;
    }

    const match = token.match;
    const fullMatch = match[0];
    let renderedNode: React.ReactNode = null;
    const key = `m-${index}`;

    try {
      renderedNode = renderInlineToken(
        key,
        planInlineToken(fullMatch, text, index, canHyperlink),
      );
    } catch (e) {
      debugLogger.error('Error parsing inline markdown part:', fullMatch, e);
      renderedNode = null;
    }

    nodes.push(
      renderedNode ?? (
        <Text key={key}>{unescapeMarkdownDollars(fullMatch)}</Text>
      ),
    );
    lastIndex = index + fullMatch.length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      <Text key={`t-${lastIndex}`}>
        {unescapeMarkdownDollars(text.slice(lastIndex))}
      </Text>,
    );
  }

  return <>{nodes.filter((node) => node !== null)}</>;
};

export const RenderInline = React.memo(RenderInlineInternal);

/**
 * The exact bytes RenderInline draws for `text` — OSC 8 envelopes are not
 * visible, so they are excluded. Callers that size prose from the Markdown
 * source count markup the renderer strips and drop markup it draws verbatim,
 * which silently hides a row a height budget said would fit.
 */
export const getInlinePlainText = (
  text: string,
  enableInlineMath = false,
): string => {
  const canHyperlink = supportsHyperlinks();
  let plainText = '';
  let lastIndex = 0;

  for (const token of mergeInlineMathMatches(
    text,
    INLINE_MARKDOWN_REGEX,
    enableInlineMath,
  )) {
    const index =
      token.kind === 'math' ? token.span.index : (token.match.index ?? 0);
    const prose = text.slice(lastIndex, index);
    plainText +=
      token.kind === 'math'
        ? unescapeMarkdownBeforeMath(prose)
        : unescapeMarkdownDollars(prose);

    if (token.kind === 'math') {
      plainText += renderInlineLatex(
        unescapeMarkdownDollars(token.span.content),
      );
      lastIndex = index + token.span.raw.length;
      continue;
    }

    const fullMatch = token.match[0];
    try {
      plainText += planInlineToken(
        fullMatch,
        text,
        index,
        canHyperlink,
      ).visible;
    } catch {
      plainText += unescapeMarkdownDollars(fullMatch);
    }
    lastIndex = index + fullMatch.length;
  }
  plainText += unescapeMarkdownDollars(text.slice(lastIndex));

  return plainText;
};

/**
 * Rendered display width of a Markdown string, for callers laying out columns
 * or height budgets around RenderInline.
 */
export const getPlainTextLength = (
  text: string,
  enableInlineMath = false,
): number => stringWidth(getInlinePlainText(text, enableInlineMath));
