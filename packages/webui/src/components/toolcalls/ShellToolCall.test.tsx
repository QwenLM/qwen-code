/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformProvider } from '../../context/PlatformContext.js';
import { ShellToolCall } from './ShellToolCall.js';

describe('ShellToolCall collapsible output', () => {
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

  const renderToolCall = (
    kind: 'bash' | 'execute',
    output: string,
    openTempFile = vi.fn(),
  ) => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <PlatformProvider
          value={{
            platform: 'web',
            postMessage: vi.fn(),
            onMessage: () => () => {},
            openTempFile,
          }}
        >
          <ShellToolCall
            toolCall={{
              toolCallId: `${kind}-1`,
              kind,
              title: 'Run command',
              status: 'completed',
              rawInput: { command: 'run-command' },
              content: [
                {
                  type: 'content',
                  content: { type: 'text', text: output },
                },
              ],
            }}
          />
        </PlatformProvider>,
      );
    });

    return openTempFile;
  };

  it.each(['bash', 'execute'] as const)(
    'preserves and expands the full %s output without opening a temp file',
    (kind) => {
      const tailMarker = '__OUTPUT_TAIL__';
      const output = `${'x'.repeat(501)}${tailMarker}`;
      const openTempFile = renderToolCall(kind, output);

      expect(container?.textContent).toContain(tailMarker);

      const toggle = container?.querySelector(
        'button[aria-label="Expand output"]',
      ) as HTMLButtonElement;
      expect(toggle).not.toBeNull();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      const collapsibleContent = container?.querySelector(
        '.toolcall-collapsible-output-content',
      ) as HTMLDivElement;
      expect(collapsibleContent.style.maxHeight).toBe('60px');
      expect(collapsibleContent.style.maskImage).toContain('40px');
      expect(collapsibleContent.style.maskImage).toContain('60px');
      act(() => {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.textContent).toContain('Collapse');
      expect(collapsibleContent.style.maxHeight).toBe('');
      expect(openTempFile).not.toHaveBeenCalled();

      act(() => {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(collapsibleContent.style.maxHeight).toBe('60px');
      expect(openTempFile).not.toHaveBeenCalled();

      const outRow = Array.from(
        container?.querySelectorAll(`.${kind}-toolcall-row`) ?? [],
      ).find((row) => row.textContent?.includes('OUT'));
      expect(outRow).toBeDefined();

      act(() => {
        outRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(openTempFile).toHaveBeenCalledWith(
        output,
        `${kind}-output-${kind}-1`,
      );
    },
  );

  it('does not add a toggle at the 500-character boundary', () => {
    renderToolCall('bash', 'x'.repeat(500));

    expect(
      container?.querySelector('button[aria-label="Expand output"]'),
    ).toBeNull();
  });
});
