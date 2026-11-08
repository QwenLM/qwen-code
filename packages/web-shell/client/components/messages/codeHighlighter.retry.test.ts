import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createHighlighter: vi.fn(),
  loadLanguage: vi.fn(),
  codeToHtml: vi.fn(() => '<pre class="shiki"></pre>'),
}));

vi.mock('shiki', () => ({
  createHighlighter: mocks.createHighlighter,
  createJavaScriptRegexEngine: () => ({}),
}));

const {
  __resetForTesting,
  getCachedHtml,
  getCodeHighlighter,
  highlightToHtmlSync,
  SHIKI_CACHE_MAX,
} = await import('./codeHighlighter');

const THEME = 'github-dark-default';

beforeEach(() => {
  __resetForTesting();
  mocks.createHighlighter.mockReset();
  mocks.loadLanguage.mockReset().mockResolvedValue(undefined);
  mocks.codeToHtml.mockReset().mockReturnValue('<pre class="shiki"></pre>');
});

describe('codeHighlighter retry/cleanup contracts', () => {
  it('does not cache a rejected highlighter promise — the next call retries', async () => {
    mocks.createHighlighter.mockRejectedValueOnce(new Error('boom'));
    mocks.createHighlighter.mockResolvedValue({
      loadLanguage: mocks.loadLanguage,
      codeToHtml: mocks.codeToHtml,
    });

    await expect(getCodeHighlighter('typescript')).rejects.toThrow('boom');
    await expect(getCodeHighlighter('typescript')).resolves.toBeDefined();
    expect(mocks.createHighlighter).toHaveBeenCalledTimes(2);
  });

  it('records a failed language and does not retry the load on the next call', async () => {
    mocks.createHighlighter.mockResolvedValue({
      loadLanguage: mocks.loadLanguage,
      codeToHtml: mocks.codeToHtml,
    });
    mocks.loadLanguage.mockRejectedValue(new Error('lang fail'));

    await expect(getCodeHighlighter('python')).rejects.toThrow('lang fail');
    // The second call is short-circuited (no re-request) and still rejects.
    await expect(getCodeHighlighter('python')).rejects.toThrow(
      /previously failed/,
    );
    expect(mocks.loadLanguage).toHaveBeenCalledTimes(1);
    // pendingLanguages was cleaned up (the failure didn't leave it stuck).
    expect(mocks.loadLanguage).toHaveBeenCalledWith('python');
  });

  it('highlightToHtmlSync returns null when codeToHtml throws (warm but failing)', async () => {
    mocks.createHighlighter.mockResolvedValue({
      loadLanguage: mocks.loadLanguage,
      codeToHtml: mocks.codeToHtml,
    });
    await getCodeHighlighter('typescript'); // warm the language
    mocks.codeToHtml.mockImplementation(() => {
      throw new Error('tokenize boom');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(
      highlightToHtmlSync('const x = 1;', 'typescript', 'github-dark-default'),
    ).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('evicts the oldest cache entry once past SHIKI_CACHE_MAX', async () => {
    mocks.createHighlighter.mockResolvedValue({
      loadLanguage: mocks.loadLanguage,
      codeToHtml: mocks.codeToHtml,
    });
    await getCodeHighlighter('typescript'); // warm the language

    // Cache one entry beyond the limit (each distinct code is a distinct key).
    for (let i = 0; i <= SHIKI_CACHE_MAX; i++) {
      highlightToHtmlSync(`code-${i}`, 'typescript', THEME);
    }

    // The first (oldest) entry was evicted; the most recent is still cached.
    expect(getCachedHtml('code-0', 'typescript', THEME)).toBeNull();
    expect(
      getCachedHtml(`code-${SHIKI_CACHE_MAX}`, 'typescript', THEME),
    ).not.toBeNull();
  });
});
