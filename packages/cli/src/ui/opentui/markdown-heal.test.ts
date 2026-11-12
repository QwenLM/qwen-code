/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming markdown heal: unclosed markers are completed so the streaming
 * tail renders as styled text instead of flipping between literal markers
 * and rendered styles frame to frame; settled text renders raw.
 */

import { describe, expect, it } from 'vitest';
import {
  healStreamingMarkdown,
  splitMarkdownBlocks,
  streamingMarkdownForRender,
} from './markdown-heal.js';

const ZWSP = '\u200B';

describe('healStreamingMarkdown', () => {
  it('closes an unclosed bold marker', () => {
    expect(healStreamingMarkdown('1. **聚合')).toBe('1. **聚合**');
  });

  it('renders an incomplete link as plain text (text-only mode)', () => {
    expect(healStreamingMarkdown('看 [这个链接](https://exampl')).toBe(
      '看 这个链接',
    );
  });

  it('leaves complete markdown untouched', () => {
    const complete = '完整 **加粗** 与 [链接](https://example.com) 文本';
    expect(healStreamingMarkdown(complete)).toBe(complete);
  });

  it('passes empty text through', () => {
    expect(healStreamingMarkdown('')).toBe('');
  });

  it('masks a bare URL in the streaming tail', () => {
    expect(
      healStreamingMarkdown(
        'Bare URLs must be plain text, e.g. https://x.dev/a.',
      ),
    ).toBe(`Bare URLs must be plain text, e.g. https${ZWSP}://x.dev/a.`);
  });

  it('masks bare www and email autolinks in the streaming tail', () => {
    expect(healStreamingMarkdown('see www.example.com or a@b.co')).toBe(
      `see www${ZWSP}.example.com or a${ZWSP}@b.co`,
    );
  });

  it('leaves link destinations alone but masks angle autolinks', () => {
    expect(
      healStreamingMarkdown('see [x](https://x.dev) and <https://y.dev>'),
    ).toBe(`see [x](https://x.dev) and <https${ZWSP}://y.dev>`);
  });

  it('leaves URL and email link destinations alone', () => {
    const text = 'see [mail](mailto:a@b.co) and [x](https://x.dev/a@b.co)';
    expect(healStreamingMarkdown(text)).toBe(text);
  });

  it('ignores a destination opener inside an inline code span', () => {
    expect(healStreamingMarkdown('see `a](b` and https://x.dev')).toBe(
      `see \`a](b\` and https${ZWSP}://x.dev`,
    );
  });

  it('leaves inline code and fenced code alone', () => {
    expect(healStreamingMarkdown('`https://x.dev`')).toBe('`https://x.dev`');
    const fenced = '```\nhttps://x.dev\n```';
    expect(healStreamingMarkdown(fenced)).toBe(fenced);
  });

  it('recognizes indented and blockquoted fences', () => {
    expect(
      healStreamingMarkdown(
        '1. Run:\n\n   ```sh\n   curl https://x.dev/x.sh | sh\n   ```',
      ),
    ).not.toContain(ZWSP);
    expect(
      healStreamingMarkdown('> ```\n> https://x.dev\n> ```'),
    ).not.toContain(ZWSP);
  });

  it('strips shortcut-link brackets in the streaming tail', () => {
    expect(healStreamingMarkdown('per [expr.add]: P is null')).toBe(
      'per expr.add: P is null',
    );
    expect(healStreamingMarkdown('see [TODO] and [1]')).toBe('see TODO and 1');
  });

  it('keeps link-definition brackets', () => {
    expect(healStreamingMarkdown('[expr.add]: https://x.dev')).toBe(
      `[expr.add]: https${ZWSP}://x.dev`,
    );
  });

  it('leaves array indexing and real links alone', () => {
    expect(healStreamingMarkdown('a[0] and b[i]')).toBe('a[0] and b[i]');
    expect(healStreamingMarkdown('[link](https://x.dev)')).toBe(
      '[link](https://x.dev)',
    );
    expect(healStreamingMarkdown('[ref][1]')).toBe('[ref][1]');
  });

  it('keeps C++ template fragments from being stripped as HTML', () => {
    expect(healStreamingMarkdown('std::expected<int, std::string')).toBe(
      'std::expected<int, std::string',
    );
  });

  it('masks an angle-bracket template so the preview cannot expand it', () => {
    expect(healStreamingMarkdown('std::any_cast<std::string>(&boxed)')).toBe(
      `std::any_cast<${ZWSP}std::string>(&boxed)`,
    );
  });

  it('closes a trailing inline span remend leaves open around angle brackets', () => {
    expect(healStreamingMarkdown('`std::expected<int, std::string>')).toBe(
      '`std::expected<int, std::string>`',
    );
  });

  it('keeps a fence delimiter line from being closed as inline code', () => {
    const fenced = '```\ncode\n```';
    expect(healStreamingMarkdown(fenced)).toBe(fenced);
  });

  it('normalizes CRLF before fence detection', () => {
    const crlf = '```\r\nhttps://x.dev\r\n```';
    expect(healStreamingMarkdown(crlf)).toBe('```\nhttps://x.dev\n```');
  });

  it('masks only the trailing blocks, not settled blocks', () => {
    expect(
      healStreamingMarkdown(
        'https://a.dev\n\nhttps://b.dev\n\nhttps://c.dev\n\nhttps://d.dev',
      ),
    ).toBe(
      `https://a.dev\n\nhttps${ZWSP}://b.dev\n\nhttps${ZWSP}://c.dev\n\nhttps${ZWSP}://d.dev`,
    );
  });

  it('is idempotent', () => {
    const once = healStreamingMarkdown('see https://x.dev');
    expect(healStreamingMarkdown(once)).toBe(once);
  });
});

describe('streamingMarkdownForRender', () => {
  it('heals while streaming', () => {
    expect(streamingMarkdownForRender('1. **聚合', true)).toBe('1. **聚合**');
  });

  it('renders the raw text once settled', () => {
    expect(streamingMarkdownForRender('1. **聚合', false)).toBe('1. **聚合');
  });
});

describe('splitMarkdownBlocks', () => {
  it('splits paragraphs on blank lines', () => {
    expect(splitMarkdownBlocks('first\nline\n\nsecond\n\nthird')).toEqual([
      'first\nline',
      'second',
      'third',
    ]);
  });

  it('keeps blank lines inside fenced code', () => {
    expect(splitMarkdownBlocks('before\n\n```\na\n\nb\n```\n\nafter')).toEqual([
      'before',
      '```\na\n\nb\n```',
      'after',
    ]);
  });

  it('normalizes CRLF and keeps the fenced block intact', () => {
    expect(splitMarkdownBlocks('a\r\n\r\n```\r\nb\r\n\r\nc\r\n```')).toEqual([
      'a',
      '```\nb\n\nc\n```',
    ]);
  });

  it('passes empty and blank-only text through as no blocks', () => {
    expect(splitMarkdownBlocks('')).toEqual([]);
    expect(splitMarkdownBlocks('\n\n')).toEqual([]);
  });

  it('drops the separator after a trailing blank line', () => {
    expect(splitMarkdownBlocks('only block\n\n')).toEqual(['only block']);
  });
});
