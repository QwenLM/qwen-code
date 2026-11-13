/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Streaming markdown heal: unclosed markers are completed so the streaming
 * tail renders as styled text instead of flipping between literal markers
 * and rendered styles frame to frame; the streaming preview's autolink and
 * shortcut-label mismatches are masked. Settled text keeps the source apart
 * from line-ending/blank-gap normalization and the width-preserving render
 * masks (lone `~`, unpaired backticks, thinking-only literal asterisks).
 */

import { describe, expect, it } from 'vitest';
import {
  healStreamingMarkdown,
  maskThinkingEmphasis,
  streamingMarkdownForRender,
} from './markdown-heal.js';

const ZWSP = '\u200B';
const TILDE_OPERATOR = '\u223C';

describe('healStreamingMarkdown', () => {
  it('closes an unclosed bold marker', () => {
    expect(healStreamingMarkdown('1. **聚合')).toBe('1. **聚合**');
  });

  it('does not append a close for a dereference at line start', () => {
    expect(healStreamingMarkdown('*p = nullptr; return')).toBe(
      '*p = nullptr; return',
    );
  });

  it('does not append a close for a C++ pointer asterisk', () => {
    expect(healStreamingMarkdown('const char*; fine.')).toBe(
      'const char*; fine.',
    );
  });

  it('does not append a close for a C++ underscore identifier', () => {
    const text = 'scan_recipes 和 devtool_* 並沒有。我要修正這句說明。';
    expect(healStreamingMarkdown(text)).toBe(text);
  });

  it('does not carry an unpaired backtick across a paragraph', () => {
    const text = 'Press the ` key once.\n\nFees are ~5 and ~10 USD.\n';
    expect(streamingMarkdownForRender(text, false)).toContain('∼5');
    expect(streamingMarkdownForRender(text, false)).toContain('∼10');
  });

  it('leaves home paths and semver tildes untouched', () => {
    expect(streamingMarkdownForRender('cd ~/.qwen', false)).toBe('cd ~/.qwen');
    expect(streamingMarkdownForRender('pin to ~1.2.3 please', false)).toBe(
      'pin to ~1.2.3 please',
    );
    expect(streamingMarkdownForRender('see www.example.com/~user', false)).toBe(
      'see www.example.com/~user',
    );
  });

  it('does not treat __cplusplus as bold', () => {
    const text = 'print intro "C++ standard: " << __cplusplus.';
    expect(healStreamingMarkdown(text)).toBe(text);
  });

  it('masks literal emphasis markers in thinking text', () => {
    expect(
      maskThinkingEmphasis(
        '1. Unclosed emphasis markers (**bold, *italic, ~~strike)',
      ),
    ).toBe(
      '1. Unclosed emphasis markers (\u2217\u2217bold, \u2217italic, ~~strike)',
    );
    expect(maskThinkingEmphasis('1. **聚合** and *italic*')).toBe(
      '1. **聚合** and *italic*',
    );
  });

  it('still closes a real emphasis opener', () => {
    expect(healStreamingMarkdown('*italic')).toBe('*italic*');
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

  it('keeps emphasis and CJK punctuation outside the URL span', () => {
    expect(healStreamingMarkdown('**run https://x.dev**')).toBe(
      '**run `https://x.dev`**',
    );
    expect(healStreamingMarkdown('~~https://x.dev~~')).toBe(
      '~~`https://x.dev`~~',
    );
    expect(healStreamingMarkdown('see https://x.dev。then')).toBe(
      'see `https://x.dev`。then',
    );
  });

  it('masks a URL that starts inside an emphasis or word run', () => {
    expect(healStreamingMarkdown('see _https://x.dev_ now')).toBe(
      'see _`https://x.dev`_ now',
    );
    expect(healStreamingMarkdown('see xhttps://x.dev now')).toBe(
      'see x`https://x.dev` now',
    );
  });

  it('masks ftp URLs', () => {
    expect(healStreamingMarkdown('see ftp://ftp.gnu.org/gnu/emacs')).toBe(
      'see `ftp://ftp.gnu.org/gnu/emacs`',
    );
  });

  it('replaces lone approximation tildes with the non-delimiter operator', () => {
    expect(healStreamingMarkdown('~3,000, ~3,300, ~3,600')).toBe(
      `${TILDE_OPERATOR}3,000, ${TILDE_OPERATOR}3,300, ${TILDE_OPERATOR}3,600`,
    );
    expect(healStreamingMarkdown('- Fuel: Q4 ~$92 (+12%), ~20% of cost')).toBe(
      `- Fuel: Q4 ${TILDE_OPERATOR}$92 (+12%), ${TILDE_OPERATOR}20% of cost`,
    );
    expect(healStreamingMarkdown('~~strike~~')).toBe('~~strike~~');
    expect(healStreamingMarkdown('code `~1`')).toBe('code `~1`');
    expect(healStreamingMarkdown('```\n~2\n```')).toBe('```\n~2\n```');
    expect(healStreamingMarkdown('see https://x.dev/~user')).toBe(
      'see `https://x.dev/~user`',
    );
  });

  it('applies the tilde replacement to settled rendering too', () => {
    expect(streamingMarkdownForRender('~3,000', false)).toBe(
      `${TILDE_OPERATOR}3,000`,
    );
  });

  it('does not mask a URL in a GFM table cell', () => {
    const table = '| a | b |\n| --- | --- |\n| https://x.dev | x |';
    expect(healStreamingMarkdown(table)).toBe(table);
  });

  it('leaves parser-protected single-column tables and HTML blocks alone', () => {
    const table = '| ~3 |\n| --- |\n| ~4 |';
    expect(healStreamingMarkdown(table)).toBe(table);
    const html = '<!-- ~3 https://x.dev -->';
    expect(healStreamingMarkdown(html)).toBe(html);
    const indented = '  <!-- ~3 https://x.dev -->';
    expect(healStreamingMarkdown(indented)).toBe(indented);
    const quoted = '> <!-- ~3 https://x.dev -->';
    expect(healStreamingMarkdown(quoted)).toBe(quoted);
  });

  it('leaves a list-indented fence alone', () => {
    const text = '1. Run:\n\n   ```\n   ~3 https://x.dev\n   ```';
    expect(healStreamingMarkdown(text)).toBe(text);
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
      `copy \u02CBhttps${ZWSP}://x.dev\u02CB now`,
    );
  });

  it('recognizes indented and blockquoted fences', () => {
    const indented =
      '1. Run:\n\n   ```sh\n   curl https://x.dev/x.sh | sh\n   ```';
    expect(healStreamingMarkdown(indented)).toBe(indented);
    const blockquoted = '> ```\n> https://x.dev\n> ```';
    expect(healStreamingMarkdown(blockquoted)).toBe(blockquoted);
    const tilde = '~~~\nhttps://x.dev\n~~~';
    expect(healStreamingMarkdown(tilde)).toBe(tilde);
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

  it('strips a heading marker after a list marker', () => {
    expect(healStreamingMarkdown('- ## Title')).toBe('- Title');
    expect(healStreamingMarkdown('1. ## Title')).toBe('1. Title');
  });

  it('does not close a fence with a shorter marker or non-empty rest', () => {
    expect(
      healStreamingMarkdown('`````\nhttps://a.dev\n```\nb https://b.dev'),
    ).toBe('`````\nhttps://a.dev\n```\nb https://b.dev');
    expect(
      healStreamingMarkdown('```\nhttps://a.dev\n``` x\nb https://b.dev'),
    ).toBe('```\nhttps://a.dev\n``` x\nb https://b.dev');
    expect(
      healStreamingMarkdown('````\nhttps://a.dev\n`````\nb https://b.dev'),
    ).toBe('````\nhttps://a.dev\n`````\nb `https://b.dev`');
  });

  it('does not close a fence on a list-marker line', () => {
    const text = '~~~\n1. ~~~\n# not a heading\nsee https://x.dev\n~~~';
    expect(healStreamingMarkdown(text)).toBe(text);
  });

  it('treats document start and post-fence indentation as code boundaries', () => {
    const documentStart = '    curl https://x.dev/a';
    expect(healStreamingMarkdown(documentStart)).toBe(documentStart);
    const afterFence = '```\ncode\n```\n    https://x.dev';
    expect(healStreamingMarkdown(afterFence)).toBe(afterFence);
  });

  it('masks a list continuation paragraph indented four columns', () => {
    expect(healStreamingMarkdown('1. Run:\n\n    see https://x.dev')).toBe(
      '1. Run:\n\n    see `https://x.dev`',
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
    expect(healStreamingMarkdown('- [expr.add]: https://x.dev')).toBe(
      '- [expr.add]: `https://x.dev`',
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

  it('normalizes a prose line that quotes multi-backtick spans', () => {
    const line =
      '9. Lone tildes `~3,000`, `~1.2.3`, `~~strike~~`, code `` `~1` ``.';
    const live = healStreamingMarkdown(line);
    const settled = streamingMarkdownForRender(line, false);
    expect(live).toContain('\u02CB\u223C1.2.3\u02CB');
    expect(settled).toContain('\u02CB\u223C1.2.3\u02CB');
    expect(live).toContain('\u223C\u223Cstrike\u223C\u223C');
    expect(settled).toContain('\u223C\u223Cstrike\u223C\u223C');
  });

  it('leaves an unmatched inline span literal instead of completing it', () => {
    expect(healStreamingMarkdown('`std::expected<int, std::string>')).toBe(
      `\u02CBstd::expected<${ZWSP}int, std::string>`,
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
