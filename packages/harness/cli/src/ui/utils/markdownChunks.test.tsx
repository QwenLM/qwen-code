/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The load-bearing test for R2.
 *
 * Splitting one giant `<Text>` into per-block siblings is only safe if the
 * painted result is identical. Summing `measureText` would not prove that —
 * that function is a first-pass estimate, while the rendered rows come from
 * `measureTextNode` (which wraps and re-measures) and then a third wrap at
 * paint time in `render-node-to-output`. So the oracle here is what the
 * terminal ends up holding: render both trees through the real engine into a
 * headless xterm and compare every cell (glyph, width, colors, attributes).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Box, Text } from 'ink';
import type { Token } from 'marked';
import type { Terminal } from '@xterm/headless';
import { render, cleanup } from '../../test-utils/render.js';
import { themeManager, DEFAULT_THEME } from '../themes/theme-manager.js';
import { formatToken, lexMarkdown } from './markdownTokenizer.js';
import {
  buildMarkdownChunks,
  createMarkdownChunkCache,
  MARKDOWN_CHUNK_MIN_LINES,
} from './markdownChunks.js';

const WIDTHS = [40, 80, 81, 120];

/** Everything MarkdownDisplay would send through formatToken, joined. */
function joinedText(tokens: Token[]): string {
  return tokens
    .map((token) => formatToken(token))
    .join('')
    .replace(/^\n+|\n+$/g, '');
}

/** One row of the terminal, each cell serialised with its attributes. */
function dumpRows(terminal: Terminal): string[][] {
  const buffer = terminal.buffer.active;
  const rows: string[][] = [];
  for (let y = buffer.baseY; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    const row: string[] = [];
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell) break;
      row.push(
        [
          JSON.stringify(cell.getChars()),
          cell.getWidth(),
          cell.getFgColorMode(),
          cell.getFgColor(),
          cell.getBgColorMode(),
          cell.getBgColor(),
          cell.isBold(),
          cell.isItalic(),
          cell.isDim(),
          cell.isUnderline(),
          cell.isInverse(),
          cell.isStrikethrough(),
        ].join(':'),
      );
    }
    rows.push(row);
  }
  while (rows.length > 0 && rows[rows.length - 1].every(isBlankCell)) {
    rows.pop();
  }
  return rows;
}

function isBlankCell(cell: string): boolean {
  return cell.startsWith('"":') || cell.startsWith('" ":');
}

function expectSameRows(
  single: string[][],
  chunked: string[][],
  label: string,
) {
  expect(chunked.length, `${label}: height`).toBe(single.length);
  for (let row = 0; row < single.length; row++) {
    for (let col = 0; col < single[row].length; col++) {
      if (single[row][col] !== chunked[row][col]) {
        throw new Error(
          `${label}: cell mismatch at (row ${row}, col ${col}): ` +
            `${single[row][col]} vs ${chunked[row][col]}`,
        );
      }
    }
  }
}

/**
 * Rendered directly below the tree under test so a stray trailing row in one
 * variant shifts it and shows up as a mismatch — trimming trailing blank rows
 * alone would hide a height difference.
 */
const SENTINEL = '<<end>>';

async function paint(
  tree: React.ReactElement,
  width: number,
): Promise<string[][]> {
  const instance = await render(
    <Box flexDirection="column">
      {tree}
      <Text>{SENTINEL}</Text>
    </Box>,
    width,
  );
  await instance.waitUntilReady();
  const rows = dumpRows(instance.terminal);
  instance.unmount();
  expect(
    rows[rows.length - 1]?.[0]?.startsWith('"<":'),
    'sentinel row must be the last painted row',
  ).toBe(true);
  return rows;
}

/**
 * Render the pre-chunking tree and the post-chunking tree and assert the
 * painted buffers match.
 */
async function assertChunkingIsInvisible(markdown: string, label: string) {
  const tokens = lexMarkdown(markdown).filter(
    (token) => token.type !== 'code' && token.type !== 'table',
  );
  const single = joinedText(tokens);
  const chunks = buildMarkdownChunks(tokens, createMarkdownChunkCache());

  for (const width of WIDTHS) {
    const before = await paint(
      <Box flexDirection="column" width={width} flexShrink={0}>
        {single ? <Text wrap="wrap">{single}</Text> : null}
      </Box>,
      width,
    );
    const after = await paint(
      <Box flexDirection="column" width={width} flexShrink={0}>
        {chunks.map((chunk, index) => (
          <Text key={index} wrap="wrap">
            {chunk}
          </Text>
        ))}
      </Box>,
      width,
    );
    expectSameRows(before, after, `${label} @${width}`);
  }
}

const PROSE = Array.from(
  { length: 40 },
  (_, i) =>
    `Paragraph ${i} with some **bold** and *italic* and \`code\` plus a fairly long run of words so that it wraps at every tested width.`,
).join('\n\n');

const LONG_LIST = [
  'Intro paragraph.',
  '',
  ...Array.from(
    { length: 60 },
    (_, i) => `- Item ${i} with enough text to be worth wrapping somewhere.`,
  ),
  '',
  'Closing paragraph.',
].join('\n');

const ORDERED_NESTED_LIST = [
  ...Array.from(
    { length: 30 },
    (_, i) => `${i + 1}. Step ${i + 1}\n   - nested detail for step ${i + 1}`,
  ),
].join('\n');

const CJK = Array.from(
  { length: 30 },
  (_, i) =>
    `第 ${i} 段中文文本，混合 ASCII words 与全角标点。这一行故意写得比较长，用来触发不同宽度下的折行。`,
).join('\n\n');

// A line whose visible width is odd while the trailing glyph is 2 cells wide:
// exercises the double-width-does-not-fit boundary at width 41/81.
const CJK_ODD_WIDTH = `${'a'.repeat(39)}宽\n${'b'.repeat(79)}宽`;

const EMOJI = Array.from(
  { length: 20 },
  (_, i) => `Line ${i} 👨‍👩‍👧‍👦 family, ✅ check, 🇯🇵 flag, and text after.`,
).join('\n\n');

// NFD (decomposed) text. measureTextNode skips wrapText — and therefore
// wrap-ansi's internal normalize() — when the widest line already fits, so
// chunking changes which nodes take that shortcut.
const NFD = Array.from(
  { length: 20 },
  (_, i) => `Ligne ${i} : élève, hängul 한ᅡᆫ, café.`,
).join('\n\n');

const TRAILING_SPACES = Array.from(
  { length: 20 },
  (_, i) => `Line ${i} ends with spaces   `,
).join('\n\n');

// A chalk span that crosses a newline inside one paragraph. Cutting inside it
// would leave an unterminated SGR in one chunk and a stray reset in the next.
const CROSS_LINE_BOLD = [
  ...Array.from({ length: 20 }, (_, i) => `Filler paragraph ${i}.`),
  '',
  '**bold start\nbold end** trailing text',
  '',
  ...Array.from({ length: 20 }, (_, i) => `More filler ${i}.`),
].join('\n');

const HEADINGS_QUOTES_RULES = Array.from({ length: 15 }, (_, i) =>
  [
    `## Heading ${i}`,
    '',
    `> quoted line ${i}`,
    `> second quoted line ${i}`,
    '',
    '---',
    '',
    `Body ${i}.`,
  ].join('\n'),
).join('\n');

const LINK_AND_CODESPAN_DENSE = Array.from(
  { length: 40 },
  (_, i) =>
    `[link ${i}](https://example.com/${i}) and \`code${i}\` and [another](https://example.com/x${i}).`,
).join('\n\n');

const BLANK_LINE_RUNS = [
  'First.',
  '',
  '',
  '',
  'Second after three blank lines.',
  '',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Body ${i}.`),
].join('\n');

const LEADING_TRAILING_BLANKS = `\n\n\nContent in the middle.\n\n\n`;

const FIXTURES: Array<[string, string]> = [
  ['prose', PROSE],
  ['long list', LONG_LIST],
  ['ordered nested list', ORDERED_NESTED_LIST],
  ['cjk', CJK],
  ['cjk odd width', CJK_ODD_WIDTH],
  ['emoji', EMOJI],
  ['nfd', NFD],
  ['trailing spaces', TRAILING_SPACES],
  ['cross-line bold', CROSS_LINE_BOLD],
  ['headings quotes rules', HEADINGS_QUOTES_RULES],
  ['link and codespan dense', LINK_AND_CODESPAN_DENSE],
  ['blank line runs', BLANK_LINE_RUNS],
  ['leading and trailing blanks', LEADING_TRAILING_BLANKS],
  ['single short paragraph', 'Just one short line.'],
  ['empty', ''],
];

describe('markdownChunks', () => {
  beforeAll(() => {
    themeManager.setActiveTheme(DEFAULT_THEME.name);
    themeManager.setTerminalBackground(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  describe('rendering equivalence', () => {
    for (const [label, markdown] of FIXTURES) {
      it(`paints identically to a single <Text>: ${label}`, async () => {
        await assertChunkingIsInvisible(markdown, label);
      });
    }

    it('paints identically under a height-constrained parent', async () => {
      // flexShrink defaults to 1 on both Box and Text, so a height cap would
      // otherwise spread the shrink across every chunk instead of trimming
      // one node's tail. MarkdownDisplay pins flexShrink={0} for this reason.
      const tokens = lexMarkdown(PROSE);
      const single = joinedText(tokens);
      const chunks = buildMarkdownChunks(tokens, createMarkdownChunkCache());
      const width = 80;

      const before = await paint(
        <Box flexDirection="column" height={12} width={width}>
          <Box flexDirection="column" width={width} flexShrink={0}>
            <Text wrap="wrap">{single}</Text>
          </Box>
        </Box>,
        width,
      );
      const after = await paint(
        <Box flexDirection="column" height={12} width={width}>
          <Box flexDirection="column" width={width} flexShrink={0}>
            {chunks.map((chunk, index) => (
              <Text key={index} wrap="wrap">
                {chunk}
              </Text>
            ))}
          </Box>
        </Box>,
        width,
      );
      expectSameRows(before, after, 'height-constrained');
    });
  });

  describe('chunk shape', () => {
    it('splits a long document into several chunks', () => {
      const chunks = buildMarkdownChunks(
        lexMarkdown(PROSE),
        createMarkdownChunkCache(),
      );
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('splits a long list, which marked reports as one token', () => {
      const tokens = lexMarkdown(LONG_LIST);
      expect(tokens.filter((token) => token.type === 'list')).toHaveLength(1);
      const chunks = buildMarkdownChunks(tokens, createMarkdownChunkCache());
      expect(chunks.length).toBeGreaterThan(1);
    });

    it('never emits an empty chunk', () => {
      for (const [, markdown] of FIXTURES) {
        const chunks = buildMarkdownChunks(
          lexMarkdown(markdown),
          createMarkdownChunkCache(),
        );
        for (const chunk of chunks) expect(chunk).not.toBe('');
      }
    });

    it('gives every chunk but the last at least the minimum lines', () => {
      const chunks = buildMarkdownChunks(
        lexMarkdown(PROSE),
        createMarkdownChunkCache(),
      );
      for (const chunk of chunks.slice(0, -1)) {
        expect(chunk.split('\n').length).toBeGreaterThanOrEqual(
          MARKDOWN_CHUNK_MIN_LINES,
        );
      }
    });

    it('returns nothing for a run that is only blank lines', () => {
      const cache = createMarkdownChunkCache();
      expect(buildMarkdownChunks(lexMarkdown('\n\n\n'), cache)).toEqual([]);
    });

    it('leaves a single unbreakable token as one chunk', () => {
      const oneParagraph = `${'word '.repeat(20_000)}end`;
      const chunks = buildMarkdownChunks(
        lexMarkdown(oneParagraph),
        createMarkdownChunkCache(),
      );
      expect(chunks).toHaveLength(1);
    });
  });

  describe('format cache', () => {
    it('reuses formatting for tokens it has already seen', () => {
      const cache = createMarkdownChunkCache();
      const tokens = lexMarkdown(PROSE);
      const first = buildMarkdownChunks(tokens, cache);
      // Same token objects — every lookup should hit and produce the same text.
      const second = buildMarkdownChunks(tokens, cache);
      expect(second).toEqual(first);
      expect(cache.formatted.has(tokens[0])).toBe(true);
    });

    it('drops everything when the theme changes', () => {
      const cache = createMarkdownChunkCache();
      const tokens = lexMarkdown(PROSE);
      buildMarkdownChunks(tokens, cache);
      expect(cache.formatted.has(tokens[0])).toBe(true);

      cache.themeToken = { stale: true };
      buildMarkdownChunks(tokens, cache);
      // Re-populated from scratch, not served from the stale map.
      expect(cache.themeToken).not.toEqual({ stale: true });
    });

    it('formats a growing stream to the same text as a full parse', () => {
      const cache = createMarkdownChunkCache();
      const full = buildMarkdownChunks(lexMarkdown(LONG_LIST), cache);
      const streamed = buildMarkdownChunks(
        lexMarkdown(LONG_LIST),
        createMarkdownChunkCache(),
      );
      expect(streamed).toEqual(full);
    });
  });
});
