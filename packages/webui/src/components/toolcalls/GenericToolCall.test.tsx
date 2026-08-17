/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GenericToolCall } from './GenericToolCall.js';

describe('GenericToolCall collapsible output', () => {
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

  const renderOutput = (output: string) => {
    act(() => {
      root?.render(
        <GenericToolCall
          toolCall={{
            toolCallId: 'generic-1',
            kind: 'custom_tool',
            title: 'Custom tool',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: output },
              },
            ],
          }}
        />,
      );
    });
  };

  it('preserves and collapses output longer than 400 characters', () => {
    const tailMarker = '__GENERIC_TAIL__';
    renderOutput(`${'x'.repeat(401)}${tailMarker}`);

    expect(container?.textContent).toContain(tailMarker);
    const content = container?.querySelector(
      '.toolcall-collapsible-output-content',
    ) as HTMLDivElement;
    expect(content.classList.contains('text-[13px]')).toBe(true);
    expect(content.classList.contains('opacity-90')).toBe(true);
    expect(content.style.maxHeight).toBe('200px');
    expect(
      container?.querySelector('button[aria-label="Expand output"]'),
    ).not.toBeNull();
  });

  it('does not add a toggle at the 400-character boundary', () => {
    const output = 'x'.repeat(400);
    renderOutput(output);

    expect(container?.textContent).toContain(output);
    const content = container?.querySelector(
      '.toolcall-collapsible-output-content',
    ) as HTMLDivElement;
    expect(content.classList.contains('text-[13px]')).toBe(true);
    expect(content.classList.contains('opacity-90')).toBe(true);
    expect(content.style.maxHeight).toBe('');
    expect(
      container?.querySelector('button[aria-label="Expand output"]'),
    ).toBeNull();
  });
});
