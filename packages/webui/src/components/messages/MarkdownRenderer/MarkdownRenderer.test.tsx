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
  onFileClick = vi.fn(),
  enableFileLinks = false,
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  flushSync(() => {
    root?.render(
      <MarkdownRenderer
        content={content}
        onFileClick={onFileClick}
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
    );

    const anchor = container?.querySelector('a');
    expect(anchor).toBeTruthy();

    anchor?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );

    expect(onFileClick).toHaveBeenCalledWith('/tmp/my dir/export.html');
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
});
