/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdownHtml.js';

describe('markdownToHtml', () => {
  it('the spec scenario: bold + inline code', () => {
    expect(markdownToHtml('**bold** and `code`')).toBe(
      '<strong>bold</strong> and <code>code</code>',
    );
  });

  it('escapes HTML in plain text and inside code', () => {
    expect(markdownToHtml('a < b & c')).toBe('a &lt; b &amp; c');
    expect(markdownToHtml('`<script>`')).toBe('<code>&lt;script&gt;</code>');
  });

  it('does not treat markup inside code spans/blocks as markup', () => {
    expect(markdownToHtml('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('renders italics, links, and line breaks', () => {
    expect(markdownToHtml('*em* and _em2_')).toBe(
      '<em>em</em> and <em>em2</em>',
    );
    expect(markdownToHtml('[qwen](https://x.test/a)')).toBe(
      '<a href="https://x.test/a">qwen</a>',
    );
    expect(markdownToHtml('line1\nline2')).toBe('line1<br>line2');
  });

  it('renders a fenced code block as pre/code, escaped, no inline processing', () => {
    const out = markdownToHtml('```ts\nconst x = a < b && **y**;\n```');
    expect(out).toBe(
      '<pre><code>const x = a &lt; b &amp;&amp; **y**;\n</code></pre>',
    );
  });

  it('escapes a link URL (no attribute injection)', () => {
    const out = markdownToHtml('[x](https://a.test/"onerror=alert)');
    expect(out).toContain('href="https://a.test/&quot;onerror=alert"');
    expect(out).not.toContain('"onerror=alert"');
  });

  it('drops a non-http(s) link scheme to plain text (no live javascript:/data: href)', () => {
    // javascript: — the visible text survives (escaped), but no <a href> is emitted.
    const js = markdownToHtml('[click](javascript:alert(1))');
    expect(js).not.toContain('<a');
    expect(js).not.toContain('javascript:');
    expect(js).toContain('click');

    // data: is likewise refused.
    expect(markdownToHtml('[x](data:text/html,<b>)')).not.toContain('<a');

    // http(s) and mailto stay live.
    expect(markdownToHtml('[a](https://x.test)')).toBe(
      '<a href="https://x.test">a</a>',
    );
    expect(markdownToHtml('[m](mailto:a@x.test)')).toBe(
      '<a href="mailto:a@x.test">m</a>',
    );
  });

  it('leaves underscores inside identifiers alone', () => {
    expect(markdownToHtml('call run_the_tests now')).toBe(
      'call run_the_tests now',
    );
  });
});
