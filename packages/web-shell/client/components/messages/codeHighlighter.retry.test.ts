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

const { __resetForTesting, getCodeHighlighter } = await import(
  './codeHighlighter'
);

beforeEach(() => {
  __resetForTesting();
  mocks.createHighlighter.mockReset();
  mocks.loadLanguage.mockReset().mockResolvedValue(undefined);
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

  it('clears the pending language load after a failure so it can retry', async () => {
    mocks.createHighlighter.mockResolvedValue({
      loadLanguage: mocks.loadLanguage,
      codeToHtml: mocks.codeToHtml,
    });
    mocks.loadLanguage.mockRejectedValueOnce(new Error('lang fail'));

    await expect(getCodeHighlighter('python')).rejects.toThrow('lang fail');
    await expect(getCodeHighlighter('python')).resolves.toBeDefined();
    expect(mocks.loadLanguage).toHaveBeenCalledTimes(2);
  });
});
