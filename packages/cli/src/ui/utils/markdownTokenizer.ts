/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Markdown tokenizer and ANSI formatter based on the `marked` library.
 *
 * Replaces the previous hand-rolled regex parser with a proper AST-based
 * approach. Code blocks and tables are NOT rendered here — they are handled
 * as React components in MarkdownDisplay.
 *
 * Architecture: markdown text → marked.lexer() → Token[] → formatToken() → ANSI string
 */

import chalk from 'chalk';
import { marked, type Token, type Tokens } from 'marked';
import stripAnsi from 'strip-ansi';
import { theme } from '../semantic-colors.js';
import {
  resolveColor,
  INK_SUPPORTED_NAMES,
  INK_NAME_TO_HEX_MAP,
} from '../themes/color-utils.js';

const EOL = '\n';
const BLOCKQUOTE_BAR = '│';

// ---------------------------------------------------------------------------
// Marked configuration
// ---------------------------------------------------------------------------

let markedConfigured = false;

/**
 * Configure GFM with strikethrough restricted to double tildes, so range
 * separators such as `3~5` and `90~94` remain literal text.
 */
export function configureMarked(): void {
  if (markedConfigured) return;
  markedConfigured = true;

  marked.use({
    tokenizer: {
      del(src: string): Tokens.Del | undefined {
        // Keep marked's content/escape rules, but require a double delimiter.
        const match =
          /^~~(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))~~(?=[^~]|$)/.exec(
            src,
          );
        const text = match?.[1];
        // `false` falls back to marked's single-tilde rule; undefined skips it.
        if (!match || text === undefined) return undefined;
        return {
          type: 'del',
          raw: match[0],
          text,
          tokens: this.lexer.inlineTokens(text),
        };
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Fast-path detection
// ---------------------------------------------------------------------------

/**
 * Quick regex that matches any character that *could* start a markdown
 * construct. If this test fails we can skip parsing entirely.
 */
const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;

export function hasMarkdownSyntax(content: string): boolean {
  return MD_SYNTAX_RE.test(content);
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Tokenize markdown content into a `marked` AST.
 */
export function lexMarkdown(content: string): Token[] {
  configureMarked();
  return marked.lexer(content);
}

/**
 * Incremental lexer state for a growing markdown response.
 *
 * Only complete top-level blocks are retained. The final non-space token is
 * always considered mutable because another chunk may change how marked
 * parses it (for example, an unfinished paragraph or fenced code block).
 */
export interface StreamingMarkdownLexerState {
  stablePrefix: string;
  stableTokens: Token[];
}

export function createStreamingMarkdownLexerState(): StreamingMarkdownLexerState {
  return {
    stablePrefix: '',
    stableTokens: [],
  };
}

/**
 * Tokenize an append-only markdown stream without repeatedly lexing completed
 * top-level blocks. The returned token sequence is consumed by the exact same
 * renderer as a normal full parse, so this optimization does not introduce a
 * separate streaming layout or delay incomplete text.
 */
export function lexStreamingMarkdown(
  content: string,
  state: StreamingMarkdownLexerState,
): Token[] {
  // Reference definitions can retroactively change links in earlier blocks,
  // so no prefix is truly stable once one appears. Preserve full-parse
  // semantics for this uncommon cross-block construct.
  if (/^ {0,3}\[[^\]]+\]:/m.test(content)) {
    state.stablePrefix = '';
    state.stableTokens = [];
    return lexMarkdown(content);
  }

  // A replacement, truncation, or edit invalidates the append-only cache.
  if (!content.startsWith(state.stablePrefix)) {
    state.stablePrefix = '';
    state.stableTokens = [];
  }

  const boundary = state.stablePrefix.length;
  const suffixTokens = lexMarkdown(content.slice(boundary));

  // The final content token is still growing. Spaces after it remain in the
  // suffix as well, since a following chunk can make them block-significant.
  let lastContentIndex = suffixTokens.length - 1;
  while (
    lastContentIndex >= 0 &&
    suffixTokens[lastContentIndex]?.type === 'space'
  ) {
    lastContentIndex--;
  }

  let stableTokenCount = 0;
  let advance = 0;
  for (let index = 0; index < lastContentIndex; index++) {
    advance += suffixTokens[index]?.raw.length ?? 0;
    stableTokenCount++;
  }

  if (advance > 0) {
    state.stablePrefix = content.slice(0, boundary + advance);
    state.stableTokens.push(...suffixTokens.slice(0, stableTokenCount));
  }

  return [...state.stableTokens, ...suffixTokens.slice(stableTokenCount)];
}

// ---------------------------------------------------------------------------
// Fenced code helpers
// ---------------------------------------------------------------------------

const OPEN_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Whether a fenced code token has its closing fence. marked also emits a
 * `code` token for a fence that is still streaming or was never closed; in
 * that case `raw` simply has no closing line.
 *
 * The closing line may be indented 0-3 spaces independently of the opener and
 * must use the opener's character, at least as many times (CommonMark).
 * Indented (non-fenced) code blocks are reported as not closed.
 */
export function isFencedCodeClosed(token: Tokens.Code): boolean {
  const lines = token.raw.replace(/\n$/, '').split('\n');
  if (lines.length < 2) return false;
  const open = OPEN_FENCE_RE.exec(lines[0] ?? '');
  if (!open) return false;
  const fence = open[1] ?? '';
  const marker = fence[0] === '~' ? '~' : '`';
  const closeRe = new RegExp(`^ {0,3}\\${marker}{${fence.length},} *$`);
  return closeRe.test(lines[lines.length - 1] ?? '');
}

/**
 * Whether a code fence info string names mermaid. Only the first
 * whitespace-separated word counts, case-insensitively, so
 * `Mermaid title="x"` matches and `mermaid-js` does not.
 */
export function isMermaidLang(lang: string | null | undefined): boolean {
  return lang?.trim().split(/\s+/)[0]?.toLowerCase() === 'mermaid';
}

// ---------------------------------------------------------------------------
// Color helper
// ---------------------------------------------------------------------------

/**
 * Apply a semantic color to text using ANSI escape codes, consistent with
 * the way Ink resolves color values.
 */
function applyColor(text: string, color: string | undefined): string {
  if (!color) return text;
  const resolved = resolveColor(color);
  if (!resolved) return text;

  if (resolved.startsWith('#')) {
    return chalk.hex(resolved)(text);
  }

  const mappedHex =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    INK_NAME_TO_HEX_MAP[resolved as keyof typeof INK_NAME_TO_HEX_MAP];
  if (mappedHex) {
    return chalk.hex(mappedHex)(text);
  }

  if (INK_SUPPORTED_NAMES.has(resolved)) {
    switch (resolved) {
      case 'black':
        return chalk.black(text);
      case 'red':
        return chalk.red(text);
      case 'green':
        return chalk.green(text);
      case 'yellow':
        return chalk.yellow(text);
      case 'blue':
        return chalk.blue(text);
      case 'magenta':
        return chalk.magenta(text);
      case 'cyan':
        return chalk.cyan(text);
      case 'white':
        return chalk.white(text);
      case 'gray':
      case 'grey':
        return chalk.gray(text);
      default:
        return text;
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

/**
 * Recursively format a `marked` token into an ANSI-styled string.
 *
 * `code` and `table` tokens are intentionally no-ops here — they are
 * rendered as React/Ink components in `MarkdownDisplay`.
 */
export function formatToken(
  token: Token,
  listDepth = 0,
  orderedListNumber: number | null = null,
  parent: Token | null = null,
  defaultColor?: string,
  codespanColor?: string,
): string {
  // Helper to colorize text with the default color when provided
  const colorText = (text: string): string =>
    defaultColor ? applyColor(text, defaultColor) : text;

  // Helper shorthand for recursive calls preserving defaultColor
  const fmt = (
    t: Token,
    depth = 0,
    num: number | null = null,
    par: Token | null = null,
  ) => formatToken(t, depth, num, par, defaultColor, codespanColor);

  switch (token.type) {
    // ----- Block-level tokens -----

    case 'blockquote': {
      const inner = (token.tokens ?? [])
        .map((t) => fmt(t, 0, null, null))
        .join('');
      const bar = chalk.dim(BLOCKQUOTE_BAR);
      return inner
        .split(EOL)
        .map((line) =>
          stripAnsi(line).trim() ? `${bar} ${chalk.italic(line)}` : line,
        )
        .join(EOL);
    }

    case 'code':
      // Handled as a React component in MarkdownDisplay.
      // Safety fallback only — should never be reached in normal flow.
      return token.text + EOL;

    case 'heading': {
      const content = (token.tokens ?? [])
        .map((t) => fmt(t, 0, null, null))
        .join('');
      switch (token.depth) {
        case 1:
        case 2:
          return chalk.bold(content) + EOL + EOL;
        case 3:
          return chalk.bold(content) + EOL + EOL;
        case 4:
          return (
            applyColor(chalk.italic(content), theme.text.secondary) + EOL + EOL
          );
        default:
          return chalk.bold(content) + EOL + EOL;
      }
    }

    case 'hr':
      return chalk.dim('---') + EOL;

    case 'list':
      return (token as Tokens.List).items
        .map((item: Tokens.ListItem, index: number) =>
          fmt(
            item,
            listDepth,
            (token as Tokens.List).ordered
              ? (((token as Tokens.List).start as number) || 1) + index
              : null,
            token,
          ),
        )
        .join('');

    case 'list_item':
      return (token.tokens ?? [])
        .map(
          (t) =>
            `${'  '.repeat(listDepth)}${fmt(
              t,
              listDepth + 1,
              orderedListNumber,
              token,
            )}`,
        )
        .join('');

    case 'paragraph':
      return (
        (token.tokens ?? []).map((t) => fmt(t, 0, null, null)).join('') + EOL
      );

    case 'table':
      // Handled as a React component in MarkdownDisplay.
      return '';

    case 'space':
      return EOL;

    // ----- Inline tokens -----

    case 'br':
      return EOL;

    case 'codespan':
      if (codespanColor) {
        return chalk.bold(applyColor(token.text, codespanColor));
      }
      return applyColor(token.text, theme.text.accent);

    case 'del':
      return chalk.strikethrough(
        (token.tokens ?? []).map((t) => fmt(t, 0, null, parent)).join(''),
      );

    case 'em':
      return chalk.italic(
        (token.tokens ?? []).map((t) => fmt(t, 0, null, parent)).join(''),
      );

    case 'strong':
      return chalk.bold(
        (token.tokens ?? []).map((t) => fmt(t, 0, null, parent)).join(''),
      );

    case 'link': {
      const linkText = (token.tokens ?? [])
        .map((t) => fmt(t, 0, null, token))
        .join('');
      const plainLinkText = stripAnsi(linkText);
      if (plainLinkText && plainLinkText !== token.href) {
        const coloredUrl = applyColor(token.href, theme.text.accent);
        return `${linkText} (${coloredUrl})`;
      }
      return applyColor(token.href, theme.text.accent);
    }

    case 'image':
      return token.href as string;

    case 'text': {
      if (parent?.type === 'list_item') {
        const prefix =
          orderedListNumber === null ? '- ' : `${orderedListNumber}. `;
        const content = token.tokens
          ? token.tokens
              .map((t) => fmt(t, listDepth, orderedListNumber, token))
              .join('')
          : colorText(token.text);
        return `${colorText(prefix)}${content}${EOL}`;
      }
      // text tokens may contain sub-tokens (e.g. inline formatting)
      if (token.tokens) {
        return token.tokens
          .map((t) => fmt(t, listDepth, orderedListNumber, parent))
          .join('');
      }
      return colorText(token.text);
    }

    case 'escape':
      return colorText(token.text);

    case 'def':
    case 'html':
      return '';

    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Convenience entry point
// ---------------------------------------------------------------------------

/**
 * Parse markdown content and return a fully formatted ANSI string.
 *
 * Code blocks and tables are rendered as plain text — use `lexMarkdown` +
 * per-token handling in a React component for full rendering.
 */
export function applyMarkdown(
  content: string,
  defaultColor?: string,
  codespanColor?: string,
): string {
  if (!hasMarkdownSyntax(content)) {
    return defaultColor ? applyColor(content, defaultColor) : content;
  }
  return lexMarkdown(content)
    .map((t) => formatToken(t, 0, null, null, defaultColor, codespanColor))
    .join('')
    .trimEnd();
}
