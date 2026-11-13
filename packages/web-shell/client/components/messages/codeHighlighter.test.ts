import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetForTesting,
  getCachedHtml,
  highlightCode,
  getCodeHighlighter,
  highlightToHtmlSync,
  isTooLargeToHighlight,
  MAX_HIGHLIGHT_LINE_CHARS,
  MAX_HIGHLIGHT_TOTAL_CHARS,
} from './codeHighlighter';

const THEME = 'github-dark-default';

// Reset the module-level highlighter singleton so each test is order-independent
// (loadedLanguages would otherwise accumulate across tests).
beforeEach(() => {
  __resetForTesting();
});

describe('isTooLargeToHighlight', () => {
  it('allows normal multi-line code', () => {
    expect(isTooLargeToHighlight('const x = 1;\nconst y = 2;\n')).toBe(false);
  });

  it('bails on any single line over the per-line limit (anywhere in the block)', () => {
    expect(
      isTooLargeToHighlight('x'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1)),
    ).toBe(true);
    // A long line earlier in the block (not just the trailing one) also bails.
    expect(
      isTooLargeToHighlight(
        'x'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1) + '\nshort',
      ),
    ).toBe(true);
  });

  it('bails when the whole block exceeds the total limit (many short lines)', () => {
    const line = 'a'.repeat(80) + '\n';
    const block = line.repeat(
      Math.ceil(MAX_HIGHLIGHT_TOTAL_CHARS / line.length) + 5,
    );
    expect(block.length).toBeGreaterThan(MAX_HIGHLIGHT_TOTAL_CHARS);
    expect(isTooLargeToHighlight(block)).toBe(true);
  });
});

describe('codeHighlighter', () => {
  it('highlightToHtmlSync is null until the language is warm, then returns HTML', async () => {
    // Cold: the language has not been loaded yet.
    expect(highlightToHtmlSync('SELECT 1', 'sql', THEME)).toBeNull();
    await getCodeHighlighter('sql');
    expect(highlightToHtmlSync('SELECT 1', 'sql', THEME)).toContain('shiki');
  });

  it('does not persist streaming intermediates when persist=false', async () => {
    await getCodeHighlighter('sql');
    // persist=false highlights but doesn't write the cache...
    expect(highlightToHtmlSync('SELECT 2', 'sql', THEME, false)).toContain(
      'shiki',
    );
    expect(getCachedHtml('SELECT 2', 'sql', THEME)).toBeNull();
    // ...persist=true (default) does.
    highlightToHtmlSync('SELECT 3', 'sql', THEME);
    expect(getCachedHtml('SELECT 3', 'sql', THEME)).toContain('shiki');
  });

  it('dedupes concurrent loads of the same language without throwing', async () => {
    const results = await Promise.all([
      getCodeHighlighter('python'),
      getCodeHighlighter('python'),
      getCodeHighlighter('python'),
    ]);
    expect(results).toHaveLength(3);
    expect(highlightToHtmlSync('x = 1', 'python', THEME)).toContain('shiki');
  });
});

describe('public highlightCode', () => {
  it('shares highlighted output and cache across both themes', async () => {
    const code = 'SELECT id FROM orders WHERE id = 1';
    const light = await highlightCode({
      code,
      language: 'sql',
      theme: 'light',
    });
    const dark = await highlightCode({ code, language: 'sql', theme: 'dark' });
    expect(light).toContain('<span style="color:');
    expect(dark).toContain('<span style="color:');
    expect(light).not.toBe(dark);
    expect(light).toBe(getCachedHtml(code, 'sql', 'github-light-default'));
    expect(dark).toBe(getCachedHtml(code, 'sql', THEME));
  });

  it('returns plain-text fallback for unknown languages and oversized code', async () => {
    expect(
      await highlightCode({
        code: 'hello',
        language: 'not-a-language',
        theme: 'dark',
      }),
    ).toBeNull();
    expect(
      await highlightCode({
        code: 'x'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1),
        language: 'sql',
        theme: 'dark',
      }),
    ).toBeNull();
    expect(
      getCachedHtml('x'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1), 'sql', THEME),
    ).toBeNull();
  });
});
