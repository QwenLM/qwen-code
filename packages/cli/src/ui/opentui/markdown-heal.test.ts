/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming markdown heal: unclosed markers are completed so the streaming
 * tail renders as styled text instead of flipping between literal markers
 * and rendered styles frame to frame; the streaming preview's autolink and
 * shortcut-label mismatches are masked, while settled text renders raw apart
 * from rendering-only line-ending and blank-gap normalization.
 */

import { describe, expect, it } from 'vitest';
import {
  healStreamingMarkdown,
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

  it('strips ATX heading markers while streaming', () => {
    expect(healStreamingMarkdown('## 同步結果')).toBe('同步結果');
    expect(healStreamingMarkdown('### 小節標題\n\nbody')).toBe(
      '小節標題\n\nbody',
    );
    expect(healStreamingMarkdown('> ## Title')).toBe('> Title');
    expect(healStreamingMarkdown('## Title ##')).toBe('Title');
  });

  it('does not strip heading-looking lines inside code', () => {
    const fenced = '```\n## not a heading\n```';
    expect(healStreamingMarkdown(fenced)).toBe(fenced);
    const indented = '    ## indented code';
    expect(healStreamingMarkdown(indented)).toBe(indented);
  });

  it('masks a bare URL in the streaming tail', () => {
    expect(
      healStreamingMarkdown(
        'Bare URLs must be plain text, e.g. https://x.dev/a.',
      ),
    ).toBe('Bare URLs must be plain text, e.g. `https://x.dev/a.`');
  });

  it('wraps an unfinished trailing URL so the preview cannot append its href', () => {
    expect(healStreamingMarkdown('see https://www.bb')).toBe(
      'see `https://www.bb`',
    );
    expect(healStreamingMarkdown('1. https://www.bbc.com/news')).toBe(
      '1. `https://www.bbc.com/news`',
    );
    expect(healStreamingMarkdown('see (https://x.dev) now')).toBe(
      'see (`https://x.dev`) now',
    );
  });

  it('leaves a real link label untouched', () => {
    const link = '[docs](https://www.bbc.com/news)';
    expect(healStreamingMarkdown(link)).toBe(link);
  });

  it('masks bare www, email and uppercase-scheme autolinks', () => {
    expect(healStreamingMarkdown('see www.example.com or a@b.co')).toBe(
      `see www${ZWSP}.example.com or a${ZWSP}@b.co`,
    );
    expect(healStreamingMarkdown('HTTPS://X.DEV / Http://x.dev')).toBe(
      '`HTTPS://X.DEV` / `Http://x.dev`',
    );
  });

  it('leaves link destinations alone but masks angle autolinks', () => {
    expect(
      healStreamingMarkdown('see [x](https://x.dev) and <https://y.dev>'),
    ).toBe(`see [x](https://x.dev) and <https${ZWSP}://y.dev>`);
  });

  it('leaves URL, email and angle-bracket destinations alone', () => {
    const text =
      'see [mail](mailto:a@b.co), [x](https://x.dev/a@b.co) and [y](<a b.md>)';
    expect(healStreamingMarkdown(text)).toBe(text);
  });

  it('ignores a destination opener inside an inline code span', () => {
    expect(healStreamingMarkdown('see `a](b` and https://x.dev')).toBe(
      `see \`a](b\` and \`https://x.dev\``,
    );
  });

  it('does not let a stray destination opener swallow the rest of the line', () => {
    expect(
      healStreamingMarkdown('use ]( to open a link, docs at https://x.dev'),
    ).toBe('use ]( to open a link, docs at `https://x.dev`');
  });

  it('leaves inline, fenced and indented code alone', () => {
    expect(healStreamingMarkdown('`https://x.dev`')).toBe('`https://x.dev`');
    const fenced = '```\nhttps://x.dev\n```';
    expect(healStreamingMarkdown(fenced)).toBe(fenced);
    const indented = 'Example:\n\n    curl https://x.dev/a';
    expect(healStreamingMarkdown(indented)).toBe(indented);
  });

  it('leaves a multi-line code span alone', () => {
    const span = '`see\nhttps://x.dev\n`';
    expect(healStreamingMarkdown(span)).toBe(span);
  });

  it('leaves HTML tags alone and still masks C++ templates', () => {
    const html = '<b>bold</b> <details>';
    expect(healStreamingMarkdown(html)).toBe(html);
    expect(healStreamingMarkdown('std::any_cast<std::string>(&boxed)')).toBe(
      `std::any_cast<${ZWSP}std::string>(&boxed)`,
    );
  });

  it('masks a URL after an escaped backtick instead of treating it as code', () => {
    expect(healStreamingMarkdown('copy \\`https://x.dev\\` now')).toBe(
      'copy \\`https' + ZWSP + '://x.dev\\` now',
    );
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
    expect(healStreamingMarkdown('~~~\nhttps://x.dev\n~~~')).not.toContain(
      ZWSP,
    );
  });

  it('treats a four-space indented marker as code, not as a fence', () => {
    expect(
      healStreamingMarkdown(
        'Intro:\n\n    ```\n example fence line\n\nAfter https://a.dev',
      ),
    ).toBe(
      `Intro:\n\n    \`\`\`\n example fence line\n\nAfter \`https://a.dev\``,
    );
  });

  it('does not close a fence with a shorter marker or non-empty rest', () => {
    expect(healStreamingMarkdown('`````\nhttps://x.dev\n```')).not.toContain(
      ZWSP,
    );
    expect(healStreamingMarkdown('```\nhttps://x.dev\n``` x')).not.toContain(
      ZWSP,
    );
    expect(healStreamingMarkdown('````\nhttps://x.dev\n`````')).not.toContain(
      ZWSP,
    );
  });

  it('strips shortcut-link brackets in the streaming tail', () => {
    expect(healStreamingMarkdown('per [expr.add]: P is null')).toBe(
      'per expr.add: P is null',
    );
    expect(healStreamingMarkdown('see [TODO] and [1]')).toBe('see TODO and 1');
    expect(
      healStreamingMarkdown('see **[expr.add]**, "[expr.add]", -[expr.add]'),
    ).toBe('see **expr.add**, "expr.add", -expr.add');
    expect(healStreamingMarkdown('see [图1] and [a@b]')).toBe(
      'see 图1 and a@b',
    );
  });

  it('keeps link-definition brackets, including inside a blockquote', () => {
    expect(healStreamingMarkdown('[expr.add]: https://x.dev')).toBe(
      `[expr.add]: \`https://x.dev\``,
    );
    expect(healStreamingMarkdown('> [expr.add]: https://x.dev')).toBe(
      `> [expr.add]: \`https://x.dev\``,
    );
  });

  it('keeps task markers', () => {
    expect(healStreamingMarkdown('- [ ] rotate\n- [x] drain')).toBe(
      '- [ ] rotate\n- [x] drain',
    );
  });

  it('strips reference links and single shortcut labels', () => {
    expect(healStreamingMarkdown('[link](https://x.dev)')).toBe(
      '[link](https://x.dev)',
    );
    expect(healStreamingMarkdown('[ref][1]')).toBe('ref');
    expect(healStreamingMarkdown('a[0] and b[i] and arr[i][j]')).toBe(
      'a0 and bi and arri',
    );
  });

  it('masks a bracketed URL in one pass and stays idempotent', () => {
    const once = healStreamingMarkdown('see [https://x.dev] for docs');
    expect(once).toBe('see `https://x.dev` for docs');
    expect(healStreamingMarkdown(once)).toBe(once);
  });

  it('keeps C++ template fragments from being stripped as HTML', () => {
    expect(healStreamingMarkdown('std::expected<int, std::string')).toBe(
      'std::expected<int, std::string',
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

  it('masks every URL in the streaming text, not just the tail', () => {
    expect(
      healStreamingMarkdown(
        'https://a.dev\n\nhttps://b.dev\n\nhttps://c.dev\n\nhttps://d.dev',
      ),
    ).toBe(
      `\`https://a.dev\`\n\n\`https://b.dev\`\n\n\`https://c.dev\`\n\n\`https://d.dev\``,
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

  it('keeps raw markdown once settled', () => {
    expect(streamingMarkdownForRender('1. **聚合', false)).toBe('1. **聚合');
  });

  it('keeps source block gaps in both states', () => {
    expect(streamingMarkdownForRender('p1\n\n\np2', false)).toBe('p1\n\n\np2');
    expect(streamingMarkdownForRender('p1\n\n\np2', true)).toBe('p1\n\n\np2');
  });

  it('drops a lone CR like the settled sanitizer does', () => {
    expect(streamingMarkdownForRender('a\rb', false)).toBe('ab');
    expect(streamingMarkdownForRender('a\rb', true)).toBe('ab');
  });

  it('keeps blank lines inside a fence', () => {
    const text = 'a\n\n\n```\n\n\n```\n\n\nb';
    expect(streamingMarkdownForRender(text, false)).toBe(text);
    expect(streamingMarkdownForRender(text, true)).toBe(text);
  });
});
