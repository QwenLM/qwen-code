/**
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./codeHighlighter', () => ({
  getCodeHighlighter: vi.fn(() => Promise.reject(new Error('load failed'))),
}));

const { StreamingCodeBlock } = await import('./StreamingCodeBlock');

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StreamingCodeBlock highlighter-failure fallback', () => {
  it('renders the code as plain text when the highlighter fails to load', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        createElement(StreamingCodeBlock, {
          code: 'const x = 1;',
          lang: 'typescript',
          theme: 'github-dark-default',
        }),
      );
    });
    // Let the rejected getCodeHighlighter() promise settle.
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('const x = 1;');
    expect(container.querySelector('.shiki-stream')).toBeNull();
    expect(warn).toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
