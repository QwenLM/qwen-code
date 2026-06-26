import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetForTesting,
  getCachedHtml,
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
