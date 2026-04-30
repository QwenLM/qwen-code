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
import { MessageMeta } from './MessageMeta.js';

describe('MessageMeta', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    vi.useRealTimers();
  });

  it('renders message time and copy action', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <MessageMeta
          timestamp={Date.UTC(2026, 3, 30, 1, 2)}
          copyText="hello"
        />,
      );
    });

    const html = container.innerHTML;
    expect(html).toMatch(/dateTime="\d{2}:\d{2}"/);
    expect(html).not.toContain('2026-04-30');
    expect(html).toContain('Copy message');
  });

  it('shows copied state after copying', async () => {
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
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
            copyToClipboard,
            features: { canCopy: true },
          }}
        >
          <MessageMeta timestamp={Date.UTC(2026, 3, 30, 1, 2)} copyText="hi" />
        </PlatformProvider>,
      );
    });

    const button = container.querySelector(
      'button[aria-label="Copy message"]',
    ) as HTMLButtonElement;
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(copyToClipboard).toHaveBeenCalledWith('hi');
    expect(
      container.querySelector('button[aria-label="Copied"]'),
    ).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1400);
    });

    expect(
      container.querySelector('button[aria-label="Copy message"]'),
    ).not.toBeNull();
  });
});
