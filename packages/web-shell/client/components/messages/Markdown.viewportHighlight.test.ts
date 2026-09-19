/**
 * @vitest-environment jsdom
 *
 * Viewport gating for the settled Shiki highlight in CodeBlock: a fence that
 * mounts outside the viewport must not tokenize (#6181 — switching back into
 * a long session mounts every fence at once), and must highlight once it
 * enters the viewport. jsdom has no IntersectionObserver, so these tests
 * install a controllable stub; the last case verifies the fallback when the
 * API is absent (the pre-gating behavior every other Markdown test relies on).
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

class IntersectionObserverStub {
  static instances: IntersectionObserverStub[] = [];
  readonly callback: IntersectionObserverCallback;
  readonly elements = new Set<Element>();
  readonly options: IntersectionObserverInit | undefined;

  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.callback = callback;
    this.options = options;
    IntersectionObserverStub.instances.push(this);
  }

  observe(element: Element): void {
    this.elements.add(element);
  }

  unobserve(element: Element): void {
    this.elements.delete(element);
  }

  disconnect(): void {
    this.elements.clear();
  }

  /** Fires the observer callback for every observed element at once. */
  trigger(isIntersecting: boolean): void {
    if (this.elements.size === 0) return;
    const entries = [...this.elements].map((target) => ({
      target,
      isIntersecting,
      intersectionRatio: isIntersecting ? 1 : 0,
    }));
    this.callback(
      entries as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

const { Markdown } = await import('./Markdown');

function renderMarkdown(content: string): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(Markdown, { content, isStreaming: false }));
  });
  return container;
}

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
  mocks.getCodeHighlighter.mockReset().mockReturnValue(new Promise(() => {}));
  IntersectionObserverStub.instances.length = 0;
});

afterEach(() => {
  for (const container of [...document.body.children]) container.remove();
  vi.unstubAllGlobals();
});

describe('CodeBlock viewport-gated highlighting', () => {
  it('does not highlight a settled block that is outside the viewport', () => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

    const container = renderMarkdown('```ts\nconst aaa = 1;\n```');

    // Still plain text: no highlighter call of any kind ran for the block.
    expect(container.querySelector('[data-hl]')).toBeNull();
    expect(mocks.highlightToHtmlSync).not.toHaveBeenCalled();
    expect(mocks.getCachedHtml).not.toHaveBeenCalled();
    expect(mocks.getCodeHighlighter).not.toHaveBeenCalled();
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const aaa = 1;',
    );
  });

  it('observes with a warm-up margin and highlights once the block enters view', () => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

    const container = renderMarkdown('```ts\nconst bbb = 2;\n```');
    expect(container.querySelector('[data-hl]')).toBeNull();

    const observer = IntersectionObserverStub.instances.at(-1);
    expect(observer).toBeDefined();
    // The gate pre-warms: the observer margin extends past the viewport so the
    // highlight lands before the block becomes visible.
    expect(observer?.options?.rootMargin).toBe('200px 0px');
    expect(observer?.elements.size).toBe(1);

    act(() => observer!.trigger(true));

    expect(container.querySelector('[data-hl]')?.textContent).toContain(
      'const bbb = 2;',
    );
    expect(mocks.highlightToHtmlSync).toHaveBeenCalledWith(
      'const bbb = 2;',
      'typescript',
      'github-dark-default',
      true,
    );
  });

  it('drops the highlight again when the block leaves the viewport', () => {
    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);

    const container = renderMarkdown('```ts\nconst ccc = 3;\n```');
    const observer = IntersectionObserverStub.instances.at(-1)!;
    act(() => observer.trigger(true));
    expect(container.querySelector('[data-hl]')).not.toBeNull();

    act(() => observer.trigger(false));

    // Offscreen blocks revert to plain text, so a stale highlight can never
    // outlive its code (the reused-instance regeneration case).
    expect(container.querySelector('[data-hl]')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const ccc = 3;',
    );
  });

  it('highlights immediately when IntersectionObserver is unavailable', () => {
    // No stub installed and jsdom ships no IntersectionObserver: the hook
    // degrades to "in view" so highlighting behavior is unchanged.
    expect(typeof IntersectionObserver).toBe('undefined');

    const container = renderMarkdown('```ts\nconst ddd = 4;\n```');

    expect(container.querySelector('[data-hl]')?.textContent).toContain(
      'const ddd = 4;',
    );
    expect(mocks.highlightToHtmlSync).toHaveBeenCalled();
  });
});
