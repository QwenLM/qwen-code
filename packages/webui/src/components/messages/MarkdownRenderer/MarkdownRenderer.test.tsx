// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from './MarkdownRenderer.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderMarkdown(
  content: string,
  onFileClick: ((filePath: string) => void) | null = vi.fn(),
  enableFileLinks = true,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  flushSync(() => {
    root?.render(
      <MarkdownRenderer
        content={content}
        onFileClick={onFileClick ?? undefined}
        enableFileLinks={enableFileLinks}
      />,
    );
  });

  return { onFileClick };
}

afterEach(() => {
  flushSync(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('MarkdownRenderer explicit file links', () => {
  it('opens markdown file links with decoded absolute paths', () => {
    const { onFileClick } = renderMarkdown(
      'Saved: [export.html](/tmp/my%20dir/export.html)',
      vi.fn(),
      false,
    );

    const anchor = container?.querySelector('a');
    expect(anchor).toBeTruthy();

    anchor?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(onFileClick).toHaveBeenCalledWith('/tmp/my dir/export.html');
  });

  it('opens Windows file URI links through the file click handler', () => {
    const { onFileClick } = renderMarkdown(
      'Saved: [export.md](file:///C:/Users/Me/My%20Exports/export.md)',
    );

    const anchor = container?.querySelector('a');
    expect(anchor).toBeTruthy();

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(anchor?.classList.contains('file-path-link')).toBe(false);
    expect(onFileClick).toHaveBeenCalledWith(
      'C:/Users/Me/My Exports/export.md',
    );
  });

  it('converts markdown file links with line fragments into vscode paths', () => {
    const { onFileClick } = renderMarkdown('[app.ts](/tmp/src/app.ts#L12)');

    const anchor = container?.querySelector('a');
    expect(anchor).toBeTruthy();

    anchor?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(onFileClick).toHaveBeenCalledWith('/tmp/src/app.ts:12');
  });

  it('opens POSIX file URI links with absolute filesystem paths', () => {
    const { onFileClick } = renderMarkdown(
      'Saved: [export.md](file:///tmp/exports/export.md)',
    );
    const anchor = container?.querySelector('a');
    expect(anchor).toBeTruthy();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onFileClick).toHaveBeenCalledWith('/tmp/exports/export.md');
  });

  it.each([
    [
      'localhost',
      'file://localhost/tmp/exports/export.md',
      '/tmp/exports/export.md',
    ],
    [
      'uppercase POSIX',
      'FILE:///tmp/exports/export.md',
      '/tmp/exports/export.md',
    ],
    [
      'uppercase localhost',
      'FiLe://LOCALHOST/tmp/exports/export.md',
      '/tmp/exports/export.md',
    ],
  ])('normalizes %s as a local file URI', (_label, href, expectedPath) => {
    const { onFileClick } = renderMarkdown('Saved: [export.md](' + href + ')');
    const anchor = container?.querySelector('a');
    expect(anchor).toBeTruthy();
    expect(anchor?.classList.contains('file-path-link')).toBe(false);

    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onFileClick).toHaveBeenCalledWith(expectedPath);
  });
  it.each([
    ['remote server', 'file://server/share/file.md'],
    ['attacker authority', 'file://attacker.example/share/file.md'],
    ['lookalike localhost authority', 'file://localhost.evil/share/file.md'],
    ['empty authority UNC', 'file:////server/share/file.md'],
    ['empty authority UNC with extra slash', 'file://///server/share/file.md'],
    ['encoded slash UNC', 'file:///%2F%2Fserver/share/file.md'],
    ['encoded backslash UNC', 'file:///%5C%5Cserver/share/file.md'],
  ])('rejects %s file URI links on the default path', (_label, href) => {
    const { onFileClick } = renderMarkdown('[open](' + href + ')');

    // Rejected file URIs must remain inert after both markdown rendering and
    // the default processFilePaths pass.
    expect(container?.querySelector('a.file-path-link')).toBeNull();
    expect(container?.querySelector('a[href^="file:"]')).toBeNull();
    expect(onFileClick).not.toHaveBeenCalled();
  });
  it('prevents local file URI navigation without a click handler', () => {
    renderMarkdown('[export.md](file:///tmp/export.md)', null);
    const anchor = container?.querySelector('a');
    expect(anchor).toBeTruthy();
    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    anchor?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('converts file URI line fragments without decoding literal path hashes', () => {
    const { onFileClick } = renderMarkdown(
      '[app.ts](file:///tmp/src/app.ts#L12) [hash.md](file:///tmp/hash%23name.md)',
    );
    const anchors = container?.querySelectorAll('a');
    expect(anchors).toHaveLength(2);
    anchors?.[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    anchors?.[1]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    expect(onFileClick).toHaveBeenNthCalledWith(1, '/tmp/src/app.ts:12');
    expect(onFileClick).toHaveBeenNthCalledWith(2, '/tmp/hash#name.md');
  });

  it('does not turn file URI images into live local images', () => {
    renderMarkdown('![private](file:///tmp/private.png)');
    expect(container?.querySelector('img[src^="file:"]')).toBeNull();
  });

  it('preserves safe links while rejecting javascript links', () => {
    renderMarkdown(
      '[docs](https://example.com/a.md) [bad](javascript:alert%281%29)',
    );
    expect(
      container?.querySelector('a[href="https://example.com/a.md"]'),
    ).toBeTruthy();
    expect(container?.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
