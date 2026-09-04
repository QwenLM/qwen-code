/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollapsibleOutput } from './CollapsibleOutput.js';

describe('CollapsibleOutput', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  it('toggles the collapsed height while preserving all children', () => {
    act(() => {
      root?.render(
        <CollapsibleOutput isCollapsible>
          full content with __TAIL__
        </CollapsibleOutput>,
      );
    });

    expect(container?.textContent).toContain('__TAIL__');
    const content = container?.querySelector(
      '.toolcall-collapsible-output-content',
    ) as HTMLDivElement;
    const toggle = container?.querySelector(
      'button[aria-label="Expand output"]',
    ) as HTMLButtonElement;
    expect(content.style.maxHeight).toBe('200px');
    expect(content.style.maskImage).toContain('140px');
    expect(content.style.maskImage).toContain('200px');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(content.style.maxHeight).toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not clip or show a toggle when content is not collapsible', () => {
    act(() => {
      root?.render(
        <CollapsibleOutput isCollapsible={false}>
          short content
        </CollapsibleOutput>,
      );
    });

    const content = container?.querySelector(
      '.toolcall-collapsible-output-content',
    ) as HTMLDivElement;
    expect(content.style.maxHeight).toBe('');
    expect(container?.querySelector('button')).toBeNull();
  });
});
