import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetForTesting,
  getCodeHighlighter,
  highlightToHtml,
  highlightToHtmlSync,
} from './codeHighlighter';

const THEME = 'github-dark-default';

// Reset the module-level highlighter singleton so each test is order-independent
// (loadedLanguages would otherwise accumulate across tests).
beforeEach(() => {
  __resetForTesting();
});

describe('codeHighlighter', () => {
  it('highlightToHtml produces Shiki markup for a loaded language', async () => {
    const html = await highlightToHtml('const x = 1;', 'typescript', THEME);
    expect(html).toContain('<pre');
    expect(html).toContain('shiki');
  });

  it('highlightToHtmlSync is null until the language is warm, then returns HTML', async () => {
    // Cold: the language has not been loaded yet.
    expect(highlightToHtmlSync('SELECT 1', 'sql', THEME)).toBeNull();
    await getCodeHighlighter('sql');
    expect(highlightToHtmlSync('SELECT 1', 'sql', THEME)).toContain('shiki');
  });

  it('highlightToHtmlSync bails to null for oversized input even when warm', async () => {
    await getCodeHighlighter('json');
    const big = '"x",'.repeat(10_000); // > 30K chars
    expect(big.length).toBeGreaterThan(30_000);
    expect(highlightToHtmlSync(big, 'json', THEME)).toBeNull();
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
