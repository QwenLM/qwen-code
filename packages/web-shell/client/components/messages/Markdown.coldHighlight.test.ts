/**
 * @vitest-environment jsdom
 *
 * Focused regression test for the cold-highlight path in CodeBlock. It mocks
 * `codeHighlighter` so the grammar load can be held *pending*, reproducing the
 * real-browser window that the integration tests in Markdown.test.ts cannot:
 * there, a bundled grammar resolves within the same React `act` flush, so the
 * stale interval never exists and a fix/no-fix difference is unobservable.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCachedHtml: vi.fn<(...args: unknown[]) => string | null>(() => null),
  highlightToHtmlSync: vi.fn<(...args: unknown[]) => string | null>(),
  getCodeHighlighter: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  isTooLargeToHighlight: vi.fn<(...args: unknown[]) => boolean>(() => false),
}));

vi.mock('./codeHighlighter', () => ({
  getCachedHtml: mocks.getCachedHtml,
  highlightToHtmlSync: mocks.highlightToHtmlSync,
  getCodeHighlighter: mocks.getCodeHighlighter,
  isTooLargeToHighlight: mocks.isTooLargeToHighlight,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { Markdown } = await import('./Markdown');

beforeEach(() => {
  mocks.getCachedHtml.mockReset().mockReturnValue(null);
  mocks.isTooLargeToHighlight.mockReset().mockReturnValue(false);
  // `typescript` is warm and highlights synchronously; every other language is
  // cold (sync returns null → the effect takes the async load path).
  mocks.highlightToHtmlSync
    .mockReset()
    .mockImplementation((code, lang) =>
      lang === 'typescript' ? `<span data-hl>${String(code)}</span>` : null,
    );
  // The cold grammar load never resolves, so the block stays on the cold path
  // for the duration of the assertion.
  mocks.getCodeHighlighter.mockReset().mockReturnValue(new Promise(() => {}));
});

describe('CodeBlock cold-highlight path', () => {
  it("drops the previous block's highlight without loading a grammar while streaming", async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // Settle a TypeScript block: it highlights synchronously, so the reused
    // CodeBlock instance now holds `const aaa = 1;` as highlighted HTML.
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst aaa = 1;\n```',
          isStreaming: false,
        }),
      );
    });
    expect(container.textContent).toContain('const aaa = 1;');

    // Regenerate the same slot into Python. Streaming deliberately stays on the
    // plain-text path and does not load or tokenize the grammar.
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```python\nxyzzy = 123456\n```',
          isStreaming: true,
        }),
      );
    });

    expect(container.textContent).not.toContain('aaa');
    expect(container.textContent).toContain('xyzzy = 123456');
    expect(mocks.getCodeHighlighter).not.toHaveBeenCalledWith('python');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('logs and renders plain text when the grammar load rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The cold grammar load fails outright (e.g. a broken/missing bundle).
    mocks.getCodeHighlighter
      .mockReset()
      .mockRejectedValue(new Error('grammar load failed'));

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```python\nxyzzy = 123456\n```',
          isStreaming: false,
        }),
      );
    });
    // Flush the rejected promise's `.catch` microtask.
    await act(async () => {});

    // The block degrades gracefully to plain text (no highlighted markup) and
    // the code stays visible — never a stuck/blank or stale-highlighted block.
    expect(container.querySelector('[data-hl]')).toBeNull();
    const codeEl = container.querySelector('pre code');
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toContain('xyzzy = 123456');
    // The failure is surfaced, not silently swallowed.
    expect(warn).toHaveBeenCalled();
    expect(mocks.getCodeHighlighter).toHaveBeenCalledWith('python');

    warn.mockRestore();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('CodeBlock transcript viewport', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('observes the new code node after a Mermaid fence and waits for the scroll root', async () => {
    let notify: IntersectionObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const observer = vi.fn(function (callback: IntersectionObserverCallback) {
      notify = callback;
      return { observe, disconnect };
    });
    vi.stubGlobal('IntersectionObserver', observer);

    const container = document.createElement('div');
    container.setAttribute('data-web-shell-message-list', '');
    document.body.appendChild(container);
    const root = createRoot(container);
    async function render(content: string) {
      await act(async () => {
        root.render(createElement(Markdown, { content }));
      });
    }

    try {
      await render('```mermaid\nflowchart TD; A-->B;\n```');
      expect(observe).not.toHaveBeenCalled();

      await render('```ts\nconst visible = true;\n```');
      const target = container.querySelector('[data-selection-code-language]');
      expect(target).not.toBeNull();
      expect(observe).toHaveBeenCalledWith(target);
      expect(observer).toHaveBeenCalledWith(expect.any(Function), {
        root: container,
        rootMargin: '200px 0px',
      });
      expect(container.querySelector('pre code')?.textContent).toContain(
        'visible',
      );
      expect(mocks.getCachedHtml).not.toHaveBeenCalled();
      expect(mocks.getCodeHighlighter).not.toHaveBeenCalled();
      expect(mocks.highlightToHtmlSync).not.toHaveBeenCalled();

      await act(async () => {
        notify?.([{ isIntersecting: true } as IntersectionObserverEntry], {
          observe,
          disconnect,
        } as unknown as IntersectionObserver);
      });
      expect(container.querySelector('[data-hl]')?.textContent).toContain(
        'visible',
      );
      expect(disconnect).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
