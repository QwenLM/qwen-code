// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  containers: [] as Array<Element | null>,
  resolveToken: undefined as ((token: string) => void) | undefined,
}));

vi.mock('react-dom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom/client')>()),
  default: {
    createRoot: (container: Element | null) => {
      testState.containers.push(container);
      return { render: vi.fn() };
    },
  },
}));
vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DaemonWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/WorkspaceSessionProvider', () => ({
  WorkspaceSessionProvider: () => null,
}));
vi.mock('./config/daemon', () => ({
  getDaemonBaseUrl: () => '',
  // No token in the URL, so boot blocks on the postMessage handshake — the
  // window in which the watchdog's grace period can expire.
  getDaemonToken: () => null,
  removeDaemonTokenFromUrl: vi.fn(),
  waitForDaemonTokenMessage: () =>
    new Promise<string>((resolve) => {
      testState.resolveToken = resolve;
    }),
}));

describe('web shell boot', () => {
  beforeEach(() => {
    testState.containers = [];
    testState.resolveToken = undefined;
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('clears the boot fallback when the app mounts after the grace period', async () => {
    document.body.innerHTML =
      '<div id="root"><div data-boot-fallback>failed to load</div></div>';
    const root = document.getElementById('root') as HTMLElement;

    await import('./main');
    // The watchdog gave up while the handshake was outstanding; the panel is
    // on screen when the token finally arrives.
    expect(root.querySelector('[data-boot-fallback]')).not.toBeNull();

    testState.resolveToken?.('token');
    await vi.waitFor(() => expect(testState.containers).toHaveLength(1));

    // React appends, so a surviving panel would sit above the recovered app.
    expect(testState.containers[0]).toBe(root);
    expect(root.querySelector('[data-boot-fallback]')).toBeNull();
  });

  it('mounts into #root on a normal boot', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root') as HTMLElement;

    await import('./main');
    testState.resolveToken?.('token');
    await vi.waitFor(() => expect(testState.containers).toHaveLength(1));

    expect(testState.containers[0]).toBe(root);
  });
});
