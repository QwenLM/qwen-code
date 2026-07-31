/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const { mockPostMessage } = vi.hoisted(() => ({
  mockPostMessage: vi.fn(),
}));

vi.mock('../../hooks/useVSCode.js', () => ({
  useVSCode: () => ({
    postMessage: mockPostMessage,
    getState: vi.fn(),
    setState: vi.fn(),
  }),
}));

import { ProviderSetupForm } from './ProviderSetupForm.js';

describe('ProviderSetupForm', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
  });

  it('leaves connecting state when auth flow is cancelled', () => {
    act(() => {
      root?.render(<ProviderSetupForm />);
    });

    const button = container?.querySelector('button');
    expect(button).toBeTruthy();

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'auth' });
    expect(container?.textContent).toContain('Connecting...');
    expect(button?.hasAttribute('disabled')).toBe(true);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'authCancelled' },
        }),
      );
    });

    expect(container?.textContent).toContain('Get Started');
    expect(button?.hasAttribute('disabled')).toBe(false);
  });
});
