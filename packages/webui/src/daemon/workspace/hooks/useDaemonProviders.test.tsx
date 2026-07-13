/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stable actions object (the real provider memoizes it) so the resource's
// `load`/`reload` identities stay put across renders — a fresh object each
// render would loop the auto-load effect. `signals` is a mutable holder so a
// test can advance `settingsVersion` between renders to drive the reload.
const { loadProviders, actions, signals } = vi.hoisted(() => {
  const fn = vi.fn();
  return {
    loadProviders: fn,
    actions: { loadProviders: fn },
    signals: { current: { settingsVersion: 1 } as { settingsVersion: number } },
  };
});
vi.mock('../DaemonWorkspaceProvider.js', () => ({
  useDaemonWorkspaceActions: () => actions,
}));
vi.mock('../../session/DaemonSessionProvider.js', () => ({
  useDaemonWorkspaceEventSignals: () => signals.current,
}));

const { useDaemonProviders } = await import('./useDaemonProviders.js');

describe('useDaemonProviders', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadProviders.mockReset();
    signals.current = { settingsVersion: 1 };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('auto-loads and normalizes the provider/current output', async () => {
    const status = {
      providers: [{ authType: 'openai', models: [{ modelId: 'gpt-4o' }] }],
      current: 'gpt-4o',
    };
    loadProviders.mockResolvedValue(status);
    let result: ReturnType<typeof useDaemonProviders> | undefined;

    function TestComponent() {
      result = useDaemonProviders({ autoLoad: true });
      return null;
    }

    await act(async () => {
      root.render((<TestComponent />) as ReactNode);
    });

    expect(loadProviders).toHaveBeenCalledTimes(1);
    expect(result?.status).toEqual(status);
    expect(result?.providers).toEqual(status.providers);
    expect(result?.current).toBe('gpt-4o');
  });

  it('defaults providers to an empty array before data arrives', async () => {
    loadProviders.mockResolvedValue({ providers: [], current: undefined });
    let result: ReturnType<typeof useDaemonProviders> | undefined;

    function TestComponent() {
      result = useDaemonProviders();
      return null;
    }

    await act(async () => {
      root.render((<TestComponent />) as ReactNode);
    });

    // No autoLoad → no request, and the normalized accessors stay safe.
    expect(loadProviders).not.toHaveBeenCalled();
    expect(result?.providers).toEqual([]);
    expect(result?.current).toBeUndefined();
  });

  it('reloads exactly once when settingsVersion advances', async () => {
    loadProviders.mockResolvedValue({
      providers: [{ authType: 'openai', models: [] }],
      current: undefined,
    });

    function TestComponent() {
      useDaemonProviders({ autoLoad: true });
      return null;
    }

    await act(async () => {
      root.render((<TestComponent />) as ReactNode);
    });
    // Auto-load only; the first settings-version observation must not reload.
    expect(loadProviders).toHaveBeenCalledTimes(1);

    signals.current = { settingsVersion: 2 };
    await act(async () => {
      root.render((<TestComponent />) as ReactNode);
    });

    // The advance triggers a single reload — not zero, not one-per-render.
    expect(loadProviders).toHaveBeenCalledTimes(2);
  });
});
