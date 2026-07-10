/**
 * @vitest-environment jsdom
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebShellCustomizationProvider,
  type WebShellCodeBlockRenderInfo,
} from '../../customization';
import { I18nProvider } from '../../i18n';
import { ThemeProvider } from '../../themeContext';
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
  markdownUrlTransform,
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

describe('markdownUrlTransform', () => {
  it('lets the qwen-session scheme through untouched', () => {
    expect(markdownUrlTransform('qwen-session://abc-123')).toBe(
      'qwen-session://abc-123',
    );
    expect(markdownUrlTransform('  qwen-session://abc-123  ')).toBe(
      '  qwen-session://abc-123  ',
    );
  });

  it('defers every other url to react-markdown’s sanitizer', () => {
    expect(markdownUrlTransform('https://example.com')).toBe(
      'https://example.com',
    );
    expect(markdownUrlTransform('mailto:a@b.c')).toBe('mailto:a@b.c');
    // defaultUrlTransform rewrites unsafe schemes to ''.
    expect(markdownUrlTransform('javascript:alert(1)')).toBe('');
    expect(markdownUrlTransform('data:text/html;base64,PHN2Zz4=')).toBe('');
  });
});

describe('qwen-session:// links', () => {
  function renderMd(content: string): HTMLDivElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          I18nProvider,
          { language: 'en' },
          createElement(Markdown, { content }),
        ),
      );
    });
    (container as HTMLDivElement & { __unmount: () => void }).__unmount = () =>
      act(() => root.unmount());
    return container as HTMLDivElement;
  }

  it('survives react-markdown url sanitization and becomes a button', () => {
    // Without `urlTransform`, react-markdown rewrites every non-http(s)/mailto
    // href to '' before `components.a` runs, so the interception branch never
    // fires and the link renders as an inert anchor.
    const c = renderMd('[🧵 abc12345](qwen-session://abc12345-full-id)');
    const a = c.querySelector('a')!;
    expect(a).toBeTruthy();
    expect(a.getAttribute('role')).toBe('button');
    (c as HTMLDivElement & { __unmount: () => void }).__unmount();
    c.remove();
  });

  it('dispatches qwen:open-session with the session id on click', () => {
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('qwen:open-session', handler);
    const c = renderMd('[🧵 abc12345](qwen-session://abc12345-full-id)');
    act(() => {
      c.querySelector('a')!.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    window.removeEventListener('qwen:open-session', handler);
    expect(seen).toEqual(['abc12345-full-id']);
    // The scheme is never written to the DOM: the anchor is a plain '#'.
    expect(c.querySelector('a')!.getAttribute('href')).toBe('#');
    (c as HTMLDivElement & { __unmount: () => void }).__unmount();
    c.remove();
  });

  it('still sanitizes dangerous schemes', () => {
    const c = renderMd('[x](javascript:alert(1))');
    const a = c.querySelector('a')!;
    expect(a.getAttribute('role')).not.toBe('button');
    expect(a.getAttribute('href')).toBeNull();
    (c as HTMLDivElement & { __unmount: () => void }).__unmount();
    c.remove();
  });
});

describe('Markdown enhanced tables', () => {
  it('uses enhanced table rendering when configured', () => {
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
            tableMode: 'advanced',
          }),
        ),
      );
    });

    expect(container.textContent).toContain('Quick copy');
    expect(container.textContent).toContain('Details');
    expect(container.querySelector('button[aria-label*="table"]')).toBeNull();

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
              tableMode: 'advanced',
            }),
          ),
        ),
      );
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
            tableMode: 'basic',
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
            tableMode: 'advanced',
          }),
        ),
      );
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
    expect(resolveFenceLanguage('c++').resolvedLang).toBe('cpp');
    expect(resolveFenceLanguage('c#').resolvedLang).toBe('csharp');
    expect(resolveFenceLanguage('f#').resolvedLang).toBe('fsharp');
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

describe('Markdown custom code block rendering', () => {
  it('lets host renderers replace assistant fenced code blocks', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn((info: WebShellCodeBlockRenderInfo) => {
      if (info.language !== 'echarts-fulldata') return undefined;
      return createElement(
        'div',
        { 'data-chart-theme': info.theme },
        `${info.source}:${info.isStreaming}:${info.code}`,
      );
    });

    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { value: 'dark' },
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\nconst option = {};\n```',
              source: 'assistant',
              isStreaming: true,
            }),
          ),
        ),
      );
    });

    expect(renderCodeBlock).toHaveBeenCalledWith({
      language: 'echarts-fulldata',
      resolvedLanguage: 'text',
      className: 'language-echarts-fulldata',
      code: 'const option = {};',
      isStreaming: true,
      source: 'assistant',
      theme: 'dark',
    });
    expect(container.querySelector('[data-chart-theme="dark"]')).not.toBeNull();
    expect(container.textContent).toContain(
      'assistant:true:const option = {};',
    );
    expect(container.querySelector('pre code')).toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('falls back to the default code block when the host renderer declines', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => undefined);

    await act(async () => {
      root.render(
        createElement(
          ThemeProvider,
          { value: 'light' },
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```custom-chart\nconst option = {};\n```',
              source: 'assistant',
              isStreaming: false,
            }),
          ),
        ),
      );
    });

    expect(renderCodeBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'custom-chart',
        resolvedLanguage: 'text',
        className: 'language-custom-chart',
        code: 'const option = {};',
        theme: 'light',
      }),
    );
    expect(container.textContent).toContain('custom-chart');
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const option = {};',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('passes resolved language aliases to host renderers', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => undefined);

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```ts\nconst x = 1;\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'ts',
        resolvedLanguage: 'typescript',
      }),
    );
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const x = 1;',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('passes punctuation language aliases to host renderers', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => undefined);

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```c++\nstd::cout << "hello";\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        language: 'c++',
        resolvedLanguage: 'cpp',
      }),
    );
    expect(container.querySelector('pre code')?.textContent).toContain(
      'std::cout << "hello";',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('extracts language prefixes from glued fence metadata', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => undefined);

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content:
              '```js{1,3}\nconst x = 1;\n```\n\n```c:main.c\nint main() {}\n```\n\n```vue{2}\n<template />\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    const infos = renderCodeBlock.mock.calls.map(
      ([info]) => info as WebShellCodeBlockRenderInfo,
    );
    expect(infos.map((info) => info.language)).toEqual(['js', 'c', 'vue']);
    expect(infos.map((info) => info.resolvedLanguage)).toEqual([
      'javascript',
      'c',
      'vue',
    ]);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('does not pass unsafe fence-language characters to host renderers', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => createElement('div', null, 'custom'));

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```bad<script>\nconst option = {};\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).not.toHaveBeenCalled();
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const option = {};',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('falls back to the default code block when the host renderer returns null', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => null);

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```custom-chart\nconst option = {};\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('custom-chart');
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const option = {};',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('falls back to the default code block when the host renderer returns false', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => false);

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```custom-chart\nconst option = {};\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('custom-chart');
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const option = {};',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('does not call host renderers when markdown source is omitted', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => createElement('div', null, 'custom'));

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```echarts-fulldata\nconst option = {};\n```',
          }),
        ),
      );
    });

    expect(renderCodeBlock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('echarts-fulldata');
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const option = {};',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('does not call host renderers for inline code', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => createElement('div', null, 'custom'));

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: 'Inline `const x = 1` example.',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).not.toHaveBeenCalled();
    expect(container.querySelector('code')?.textContent).toBe('const x = 1');

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('does not call host renderers for bare fenced code blocks', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => createElement('div', null, 'custom'));

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```\nhello world\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).not.toHaveBeenCalled();
    expect(container.querySelector('pre code')?.textContent).toContain(
      'hello world',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('does not call host renderers for unfenced multiline code blocks', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => createElement('div', null, 'custom'));

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '    const x = 1;\n    const y = 2;',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).not.toHaveBeenCalled();
    expect(container.querySelector('pre code')?.textContent).toContain(
      'const x = 1;',
    );

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('falls back to the default code block when the host renderer throws', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => {
      throw new Error('boom');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\nconst option = {};\n```',
              source: 'assistant',
            }),
          ),
        );
      });

      expect(renderCodeBlock).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[web-shell] custom code block renderer call failed (lang=%s):',
        'echarts-fulldata',
        expect.any(Error),
      );
      expect(container.textContent).toContain('echarts-fulldata');
      expect(container.querySelector('pre code')?.textContent).toContain(
        'const option = {};',
      );
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('falls back to the default code block when custom rendered content throws', async () => {
    function ThrowingChart(): never {
      throw new Error('render boom');
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => createElement(ThrowingChart));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\nconst option = {};\n```',
              source: 'assistant',
            }),
          ),
        );
      });

      expect(renderCodeBlock).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[web-shell] custom code block component render (lang=echarts-fulldata) failed:',
        expect.any(Error),
        expect.any(String),
      );
      expect(container.textContent).toContain('echarts-fulldata');
      expect(container.querySelector('pre code')?.textContent).toContain(
        'const option = {};',
      );
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('retries custom rendered content after the error boundary reset key changes', async () => {
    function ThrowingChart(): never {
      throw new Error('render boom');
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn((info: WebShellCodeBlockRenderInfo) => {
      if (info.code === 'bad') return createElement(ThrowingChart);
      return createElement('div', { 'data-custom-code': info.code }, info.code);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\nbad\n```',
              source: 'assistant',
            }),
          ),
        );
      });

      expect(container.querySelector('pre code')?.textContent).toContain('bad');

      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\ngood\n```',
              source: 'assistant',
            }),
          ),
        );
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[web-shell] custom code block component render (lang=echarts-fulldata) failed:',
        expect.any(Error),
        expect.any(String),
      );
      expect(
        container.querySelector('[data-custom-code="good"]'),
      ).not.toBeNull();
      expect(container.querySelector('pre code')).toBeNull();
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('retries custom rendered content when streaming settles', async () => {
    function ThrowingChart(): never {
      throw new Error('render boom');
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn((info: WebShellCodeBlockRenderInfo) => {
      if (info.isStreaming) return createElement(ThrowingChart);
      return createElement('div', { 'data-custom-code': 'settled' }, info.code);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\nfinal\n```',
              source: 'assistant',
              isStreaming: true,
            }),
          ),
        );
      });

      expect(container.querySelector('pre code')?.textContent).toContain(
        'final',
      );

      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\nfinal\n```',
              source: 'assistant',
              isStreaming: false,
            }),
          ),
        );
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[web-shell] custom code block component render (lang=echarts-fulldata) failed:',
        expect.any(Error),
        expect.any(String),
      );
      expect(
        container.querySelector('[data-custom-code="settled"]'),
      ).not.toBeNull();
      expect(container.querySelector('pre code')).toBeNull();
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('retries custom rendered content as streaming code changes', async () => {
    function ThrowingChart(): never {
      throw new Error('render boom');
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn((info: WebShellCodeBlockRenderInfo) => {
      if (info.code === 'bad') return createElement(ThrowingChart);
      return createElement('div', { 'data-custom-code': info.code }, info.code);
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\nbad\n```',
              source: 'assistant',
              isStreaming: true,
            }),
          ),
        );
      });

      expect(container.querySelector('pre code')?.textContent).toContain('bad');

      await act(async () => {
        root.render(
          createElement(
            WebShellCustomizationProvider,
            { value: { markdown: { renderCodeBlock } } },
            createElement(Markdown, {
              content: '```echarts-fulldata\ngood\n```',
              source: 'assistant',
              isStreaming: true,
            }),
          ),
        );
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[web-shell] custom code block component render (lang=echarts-fulldata) failed:',
        expect.any(Error),
        expect.any(String),
      );
      expect(
        container.querySelector('[data-custom-code="good"]'),
      ).not.toBeNull();
      expect(container.querySelector('pre code')).toBeNull();
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('retries custom rendered content when source or theme changes', async () => {
    function ThrowingChart(): never {
      throw new Error('render boom');
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn((info: WebShellCodeBlockRenderInfo) => {
      if (info.source === 'assistant' && info.theme === 'dark') {
        return createElement(ThrowingChart);
      }
      return createElement(
        'div',
        { 'data-custom-code': `${info.source}:${info.theme}` },
        info.code,
      );
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const tree = (source: 'assistant' | 'thinking', theme: 'dark' | 'light') =>
      createElement(
        ThemeProvider,
        { value: theme },
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { renderCodeBlock } } },
          createElement(Markdown, {
            content: '```echarts-fulldata\nsame\n```',
            source,
          }),
        ),
      );

    try {
      await act(async () => {
        root.render(tree('assistant', 'dark'));
      });

      expect(container.querySelector('pre code')?.textContent).toContain(
        'same',
      );

      await act(async () => {
        root.render(tree('thinking', 'light'));
      });

      expect(errorSpy).toHaveBeenCalledWith(
        '[web-shell] custom code block component render (lang=echarts-fulldata) failed:',
        expect.any(Error),
        expect.any(String),
      );
      expect(
        container.querySelector('[data-custom-code="thinking:light"]'),
      ).not.toBeNull();
      expect(container.querySelector('pre code')).toBeNull();
    } finally {
      errorSpy.mockRestore();
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('lets custom code components take precedence over renderCodeBlock', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderCodeBlock = vi.fn(() => createElement('div', null, 'custom'));

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          {
            value: {
              markdown: {
                renderCodeBlock,
                components: {
                  code({ children }: { children?: ReactNode }) {
                    return createElement(
                      'code',
                      { 'data-custom-code-component': 'true' },
                      children,
                    );
                  },
                },
              },
            },
          },
          createElement(Markdown, {
            content: '```echarts-fulldata\nconst option = {};\n```',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(renderCodeBlock).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-custom-code-component="true"]'),
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('applies transformMarkdown customization before rendering', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const transformMarkdown = vi.fn((content: string) =>
      content.replace('raw chart', 'transformed chart'),
    );

    await act(async () => {
      root.render(
        createElement(
          WebShellCustomizationProvider,
          { value: { markdown: { transformMarkdown } } },
          createElement(Markdown, {
            content: '**raw chart**',
            source: 'assistant',
          }),
        ),
      );
    });

    expect(transformMarkdown).toHaveBeenCalledWith('**raw chart**', {
      source: 'assistant',
    });
    expect(container.textContent).toContain('transformed chart');
    expect(container.textContent).not.toContain('raw chart');

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
