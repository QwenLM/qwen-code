/**
 * @vitest-environment jsdom
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebShellCustomizationProvider } from '../../customization';
import { I18nProvider } from '../../i18n';
import * as EnhancedTableModule from './EnhancedMarkdownTable';
import {
  MAX_HIGHLIGHT_LINE_CHARS,
  __resetForTesting,
  getCodeHighlighter,
} from './codeHighlighter';
import {
  isSafeHref,
  isSafeImageSrc,
  Markdown,
  resolveFenceLanguage,
} from './Markdown';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isSafeHref', () => {
  it('allows https URLs', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
  });

  it('allows http URLs', () => {
    expect(isSafeHref('http://example.com')).toBe(true);
  });

  it('allows mailto URLs', () => {
    expect(isSafeHref('mailto:test@example.com')).toBe(true);
  });

  it('allows anchor links', () => {
    expect(isSafeHref('#section')).toBe(true);
  });

  it('allows relative paths', () => {
    expect(isSafeHref('/path/to/page')).toBe(true);
  });

  it('blocks protocol-relative URLs', () => {
    expect(isSafeHref('//evil.com')).toBe(false);
  });

  it('blocks javascript: scheme', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
  });

  it('blocks data: URIs', () => {
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('blocks vbscript: scheme', () => {
    expect(isSafeHref('vbscript:MsgBox("XSS")')).toBe(false);
  });

  it('returns false for empty/undefined', () => {
    expect(isSafeHref(undefined)).toBe(false);
    expect(isSafeHref('')).toBe(false);
    expect(isSafeHref('   ')).toBe(false);
  });

  it('handles whitespace-padded schemes', () => {
    expect(isSafeHref('  https://example.com')).toBe(true);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
  });
});

describe('isSafeImageSrc', () => {
  it('allows https URLs', () => {
    expect(isSafeImageSrc('https://example.com/img.png')).toBe(true);
  });

  it('allows data:image/png base64', () => {
    expect(isSafeImageSrc('data:image/png;base64,iVBOR')).toBe(true);
  });

  it('allows data:image/jpeg base64', () => {
    expect(isSafeImageSrc('data:image/jpeg;base64,/9j')).toBe(true);
  });

  it('allows data:image/gif base64', () => {
    expect(isSafeImageSrc('data:image/gif;base64,R0lG')).toBe(true);
  });

  it('allows data:image/webp base64', () => {
    expect(isSafeImageSrc('data:image/webp;base64,UklG')).toBe(true);
  });

  it('blocks data:image/svg+xml (can load external resources)', () => {
    expect(isSafeImageSrc('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
  });

  it('blocks data:text/html', () => {
    expect(isSafeImageSrc('data:text/html,<script>')).toBe(false);
  });

  it('blocks protocol-relative URLs', () => {
    expect(isSafeImageSrc('//evil.com/img.png')).toBe(false);
  });

  it('blocks javascript: scheme', () => {
    expect(isSafeImageSrc('javascript:alert(1)')).toBe(false);
  });

  it('allows relative paths', () => {
    expect(isSafeImageSrc('/images/logo.png')).toBe(true);
  });
});

describe('Markdown enhanced tables', () => {
  it('uses enhanced table controls when enabled', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'en' },
          createElement(Markdown, {
            content: '| A |\n| --- |\n| 1 |',
            enhanceTables: true,
          }),
        ),
      );
    });

    const toggle = container.querySelector('button');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-label')).toContain('advanced');

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Quick copy');
    expect(container.textContent).toContain('Details');

    const toggleOff = container.querySelector(
      'button[aria-label="Switch to basic table"]',
    );
    expect(toggleOff).not.toBeNull();
    act(() => {
      toggleOff?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).not.toContain('Quick copy');
    expect(container.querySelector('table')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Switch to advanced table"]'),
    ).not.toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('keeps enhanced table when source customizes table rendering', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'en' },
          createElement(
            WebShellCustomizationProvider,
            {
              value: {
                markdown: {
                  components: {
                    table({ children }: { children?: ReactNode }) {
                      return createElement(
                        'table',
                        { 'data-custom-table': 'true' },
                        children,
                      );
                    },
                  },
                },
              },
            },
            createElement(Markdown, {
              content: '| A |\n| --- |\n| 1 |',
              source: 'assistant',
              enhanceTables: true,
            }),
          ),
        ),
      );
    });

    const toggle = container.querySelector('button');
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('Quick copy');
    expect(container.querySelector('[data-custom-table="true"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });

  it('uses plain table rendering when enhancement is disabled', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'en' },
          createElement(Markdown, {
            content: '| A |\n| --- |\n| 1 |',
            enhanceTables: false,
          }),
        ),
      );
    });

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).not.toContain('Quick copy');

    act(() => root.unmount());
    container.remove();
  });

  it('renders the plain table fallback when enhancement throws', () => {
    vi.spyOn(EnhancedTableModule, 'EnhancedMarkdownTable').mockImplementation(
      () => {
        throw new Error('Enhanced table failed');
      },
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'en' },
          createElement(Markdown, {
            content: '| A |\n| --- |\n| 1 |',
            enhanceTables: true,
          }),
        ),
      );
    });

    const toggle = container.querySelector('button');
    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('A');
    expect(table?.textContent).toContain('1');
    expect(container.textContent).not.toContain('Quick copy');
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell] enhanced markdown table failed:',
      expect.any(Error),
      expect.any(String),
    );

    act(() => root.unmount());
    container.remove();
  });
});

describe('resolveFenceLanguage', () => {
  it('resolves common aliases to Shiki language ids', () => {
    expect(resolveFenceLanguage('ts').resolvedLang).toBe('typescript');
    expect(resolveFenceLanguage('js').resolvedLang).toBe('javascript');
    expect(resolveFenceLanguage('py').resolvedLang).toBe('python');
    expect(resolveFenceLanguage('sh').resolvedLang).toBe('bash');
    expect(resolveFenceLanguage('yml').resolvedLang).toBe('yaml');
    expect(resolveFenceLanguage('golang').resolvedLang).toBe('go');
  });

  it('passes through already-canonical languages', () => {
    expect(resolveFenceLanguage('typescript').resolvedLang).toBe('typescript');
    expect(resolveFenceLanguage('sql').resolvedLang).toBe('sql');
  });

  it('is case-insensitive', () => {
    expect(resolveFenceLanguage('SQL').resolvedLang).toBe('sql');
    expect(resolveFenceLanguage('TS').resolvedLang).toBe('typescript');
  });

  it('falls back to "text" for unknown languages', () => {
    expect(resolveFenceLanguage('made-up').resolvedLang).toBe('text');
    expect(resolveFenceLanguage('').resolvedLang).toBe('text');
    expect(resolveFenceLanguage(undefined).resolvedLang).toBe('text');
  });

  it('keeps the user-typed label (original case) for the header', () => {
    expect(resolveFenceLanguage('ts').label).toBe('ts');
    // Original case is preserved for display even though resolution lowercases.
    expect(resolveFenceLanguage('TypeScript').label).toBe('TypeScript');
    expect(resolveFenceLanguage('TypeScript').resolvedLang).toBe('typescript');
    expect(resolveFenceLanguage(undefined).label).toBe('text');
  });

  it('detects mermaid as its own language', () => {
    expect(resolveFenceLanguage('mermaid').lang).toBe('mermaid');
  });

  it('does not leak inherited Object.prototype keys as a non-string lang', () => {
    for (const evil of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ]) {
      const { lang, resolvedLang } = resolveFenceLanguage(evil);
      expect(typeof lang).toBe('string');
      expect(resolvedLang).toBe('text');
    }
  });
});

describe('Markdown mermaid rendering', () => {
  it('keeps mermaid code blocks unrendered while streaming', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```mermaid\ngraph TD\nA --> B\n```',
          isStreaming: true,
        }),
      );
    });

    expect(container.textContent).toContain('mermaid');
    expect(container.textContent).toContain('graph TD');
    expect(container.textContent).not.toContain('mermaid.rendering');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});

describe('Markdown code highlighting while streaming', () => {
  it('keeps streamed code content visible while streaming', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst x: number = 1;\n```',
          isStreaming: true,
        }),
      );
    });

    // The streamed code stays visible inside the rendered code element — not
    // merely somewhere in the DOM (the lang label / copy button). Anchoring to
    // `pre code` guards the "no streamed text is ever hidden" invariant: if the
    // highlight HTML were set but empty, this element would be missing/blank
    // even though container.textContent still matched the header.
    const codeEl = container.querySelector('pre code');
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toContain('const x: number = 1;');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('highlights the block as it streams, and the appended chunk too', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // First streamed chunk: gets highlighted (async grammar load, then the
    // synchronous re-highlight).
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst a = 1;\n```',
          isStreaming: true,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(container.querySelector('.shiki')).not.toBeNull();
    expect(container.textContent).toContain('const a = 1;');

    // Appended chunk (still streaming): the new line is re-highlighted
    // synchronously — content never lags out of the DOM.
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst a = 1;\nconst b = 2;\n```',
          isStreaming: true,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(container.querySelector('.shiki')).not.toBeNull();
    expect(container.textContent).toContain('const b = 2;');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('applies Shiki highlighting once a code block has settled', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst x: number = 1;\n```',
          isStreaming: false,
        }),
      );
    });
    // Wait for the async highlight (language load + tokenization) to resolve.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    expect(container.querySelector('.shiki')).not.toBeNull();
    expect(container.textContent).toContain('const x');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('drops stale highlighted HTML when the code is replaced (regeneration)', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    // Settle an initial highlighted block.
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst aaa = 1;\n```',
          isStreaming: false,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(container.textContent).toContain('const aaa');

    // Replace the content while streaming. `ts` is already warm, so the
    // synchronous re-highlight produces the new block's HTML immediately; the
    // stale highlight (of `const aaa`) must NOT be shown — `const zzz` is.
    // (The cold-language variant of this — where the new grammar is still
    // loading — is covered deterministically in Markdown.coldHighlight.test.tsx.)
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst zzz = 2;\n```',
          isStreaming: true,
        }),
      );
    });
    expect(container.textContent).toContain('const zzz');
    expect(container.textContent).not.toContain('const aaa');

    // Positive case: once the regenerated content settles, it is actually
    // highlighted (re-highlighted synchronously — not stuck on plain text).
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```ts\nconst zzz = 2;\n```',
          isStreaming: false,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(container.querySelector('.shiki')).not.toBeNull();
    expect(container.textContent).toContain('const zzz');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('renders an oversized single-line fence as plain text even when the grammar is warm', async () => {
    // Warm `json` up front so this test exercises the SIZE guard, not the cold
    // path: if isTooLargeToHighlight were removed from CodeBlock, the warm
    // synchronous highlight would run and produce `.shiki` — so the test would
    // fail, which is what we want. (With an unwarmed language it would pass
    // vacuously, because the cold path renders plain regardless of size.)
    __resetForTesting();
    await getCodeHighlighter('json');

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const longLine = 'a'.repeat(MAX_HIGHLIGHT_LINE_CHARS + 1);

    // Sanity: a normal json block DOES highlight, proving the grammar is warm.
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```json\n{ "a": 1 }\n```',
          isStreaming: false,
        }),
      );
    });
    expect(container.querySelector('.shiki')).not.toBeNull();

    // The oversized single line is rendered plain despite the warm grammar — the
    // size guard, not language coldness, is what suppresses highlighting.
    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```json\n' + longLine + '\n```',
          isStreaming: false,
        }),
      );
    });
    expect(container.textContent).toContain(longLine);
    expect(container.querySelector('.shiki')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
