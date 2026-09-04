/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThinkToolCall } from './ThinkToolCall.js';

describe('ThinkToolCall collapsible output', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
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

  const renderThoughts = (thoughts: string) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ThinkToolCall
          toolCall={{
            toolCallId: 'think-1',
            kind: 'think',
            title: 'Thinking',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: thoughts },
              },
            ],
          }}
        />,
      );
    });
  };

  it('preserves long thoughts and exposes expand and collapse controls', () => {
    const tailMarker = '__THOUGHT_TAIL__';
    renderThoughts(`${'x'.repeat(501)}${tailMarker}`);

    expect(container?.textContent).toContain(tailMarker);

    const toggle = container?.querySelector(
      'button[aria-label="Expand output"]',
    ) as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const collapsibleContent = container?.querySelector(
      '.toolcall-collapsible-output-content',
    ) as HTMLDivElement;
    expect(collapsibleContent.style.maxHeight).toBe('200px');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent).toContain('Collapse');
    expect(collapsibleContent.style.maxHeight).toBe('');

    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('Show more');
    expect(collapsibleContent.style.maxHeight).toBe('200px');
  });

  it('keeps short thoughts in the compact layout without a toggle', () => {
    renderThoughts('short thought');

    expect(container?.textContent).toContain('short thought');
    expect(container?.querySelector('.toolcall-card')).toBeNull();
    expect(
      container?.querySelector('button[aria-label="Expand output"]'),
    ).toBeNull();
  });
});
