/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import * as EnhancedTableModule from './EnhancedMarkdownTable';
import { isSafeHref, isSafeImageSrc, Markdown } from './Markdown';

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

    expect(container.textContent).toContain('Quick copy');
    expect(container.textContent).toContain('Details');

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
    vi.spyOn(console, 'error').mockImplementation(() => {});
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

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.textContent).toContain('A');
    expect(table?.textContent).toContain('1');
    expect(container.textContent).not.toContain('Quick copy');

    act(() => root.unmount());
    container.remove();
  });
});

describe('Markdown mermaid rendering', () => {
  it('keeps mermaid code blocks unrendered while deferred', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(Markdown, {
          content: '```mermaid\ngraph TD\nA --> B\n```',
          deferMermaid: true,
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
