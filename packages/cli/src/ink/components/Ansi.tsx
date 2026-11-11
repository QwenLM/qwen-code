/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * <Ansi> — Parses ANSI escape sequences and renders them as styled Ink <Text>
 * nodes.  Use this as an escape hatch when you have pre-formatted ANSI strings
 * (e.g. from a user-provided statusline script) that need to display colours,
 * bold, dim, italic, etc. inside Ink.
 *
 * Under the hood it uses the project's own termio parser (same parser that
 * powers the terminal screen buffer) to produce semantic actions, then maps
 * each styled text span to an Ink <Text> element with the appropriate props.
 */

import React, { memo } from 'react';
import Text from './Text.js';
import type { Color } from '../styles.js';
import { Parser } from '../termio/parser.js';
import type {
  NamedColor,
  Color as TermioColor,
  TextStyle,
} from '../termio/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type AnsiProps = {
  children: string;
  /** When true, force all text to be rendered with dim styling. */
  dimColor?: boolean;
};

type SpanProps = {
  color?: Color;
  backgroundColor?: Color;
  dim?: boolean;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
};

type Span = {
  text: string;
  props: SpanProps;
};

// ─── Named-color mapping (termio → Ink Color) ───────────────────────────────

const NAMED_COLOR_MAP: Record<NamedColor, Color> = {
  black: 'ansi:black',
  red: 'ansi:red',
  green: 'ansi:green',
  yellow: 'ansi:yellow',
  blue: 'ansi:blue',
  magenta: 'ansi:magenta',
  cyan: 'ansi:cyan',
  white: 'ansi:white',
  brightBlack: 'ansi:blackBright',
  brightRed: 'ansi:redBright',
  brightGreen: 'ansi:greenBright',
  brightYellow: 'ansi:yellowBright',
  brightBlue: 'ansi:blueBright',
  brightMagenta: 'ansi:magentaBright',
  brightCyan: 'ansi:cyanBright',
  brightWhite: 'ansi:whiteBright',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function colorToString(color: TermioColor): Color | undefined {
  switch (color.type) {
    case 'named':
      return NAMED_COLOR_MAP[color.name];
    case 'indexed':
      return `ansi256(${color.index})` as Color;
    case 'rgb':
      return `rgb(${color.r},${color.g},${color.b})` as Color;
    case 'default':
      return undefined;
  }
}

function textStyleToSpanProps(style: TextStyle): SpanProps {
  const props: SpanProps = {};
  if (style.bold) props.bold = true;
  if (style.dim) props.dim = true;
  if (style.italic) props.italic = true;
  if (style.underline !== 'none') props.underline = true;
  if (style.strikethrough) props.strikethrough = true;
  if (style.inverse) props.inverse = true;
  const fgColor = colorToString(style.fg);
  if (fgColor) props.color = fgColor;
  const bgColor = colorToString(style.bg);
  if (bgColor) props.backgroundColor = bgColor;
  return props;
}

function propsEqual(a: SpanProps, b: SpanProps): boolean {
  return (
    a.color === b.color &&
    a.backgroundColor === b.backgroundColor &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.inverse === b.inverse
  );
}

function hasAnyProps(props: SpanProps): boolean {
  return (
    props.color !== undefined ||
    props.backgroundColor !== undefined ||
    props.dim === true ||
    props.bold === true ||
    props.italic === true ||
    props.underline === true ||
    props.strikethrough === true ||
    props.inverse === true
  );
}

/**
 * Parse an ANSI string into spans using the termio parser.
 */
function parseToSpans(input: string): Span[] {
  const parser = new Parser();
  const actions = parser.feed(input);
  const spans: Span[] = [];

  for (const action of actions) {
    if (action.type === 'text') {
      const text = action.graphemes.map((g) => g.value).join('');
      if (!text) continue;

      const props = textStyleToSpanProps(action.style);

      // Try to merge with previous span if props match
      const lastSpan = spans[spans.length - 1];
      if (lastSpan && propsEqual(lastSpan.props, props)) {
        lastSpan.text += text;
      } else {
        spans.push({ text, props });
      }
    }
    // Ignore cursor, erase, scroll, mode, link and other actions — we only
    // care about styled text output.
  }

  return spans;
}

// ─── StyledText (handles bold/dim mutual exclusivity) ────────────────────────

function StyledText({
  bold,
  dim,
  children,
  ...rest
}: SpanProps & { children: React.ReactNode }): React.ReactElement {
  if (dim) {
    return (
      <Text {...rest} dim>
        {children}
      </Text>
    );
  }
  if (bold) {
    return (
      <Text {...rest} bold>
        {children}
      </Text>
    );
  }
  return <Text {...rest}>{children}</Text>;
}

// ─── <Ansi> component ────────────────────────────────────────────────────────

/**
 * Parses ANSI escape codes in `children` and renders them as styled Ink <Text>
 * nodes.  Memoized to prevent unnecessary re-renders.
 */
export const Ansi = memo(function Ansi({
  children,
  dimColor,
}: AnsiProps): React.ReactElement | null {
  if (typeof children !== 'string') {
    return dimColor ? (
      <Text dim>{String(children)}</Text>
    ) : (
      <Text>{String(children)}</Text>
    );
  }

  if (children === '') {
    return null;
  }

  const spans = parseToSpans(children);

  if (spans.length === 0) {
    return null;
  }

  // Fast path: single unstyled span — just render plain text.
  if (spans.length === 1 && !hasAnyProps(spans[0]!.props)) {
    return dimColor ? (
      <Text dim>{spans[0]!.text}</Text>
    ) : (
      <Text>{spans[0]!.text}</Text>
    );
  }

  const content = spans.map((span, i) => {
    const p = { ...span.props };
    if (dimColor) {
      p.dim = true;
    }

    return hasAnyProps(p) ? (
      <StyledText key={i} {...p}>
        {span.text}
      </StyledText>
    ) : (
      span.text
    );
  });

  return dimColor ? <Text dim>{content}</Text> : <Text>{content}</Text>;
});
