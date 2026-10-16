// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReactNode } from 'react';
import { act } from 'react';
// The module mock below overrides only the default export, so this named
// import is the real createRoot — used to mount the boot gate for real.
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
  containers: [] as Array<Element | null>,
  rendered: [] as Array<ReactNode>,
  resolveToken: undefined as ((token: string) => void) | undefined,
  removeToken: vi.fn(),
  storedToken: null as string | null,
}));

vi.mock('react-dom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom/client')>()),
  default: {
    createRoot: (container: Element | null) => {
      testState.containers.push(container);
      return {
        render: vi.fn((element: ReactNode) => {
          testState.rendered.push(element);
        }),
      };
    },
  },
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DaemonWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/WorkspaceSessionProvider', () => ({
  WorkspaceSessionProvider: () => null,
}));
vi.mock('./config/daemon', () => ({
  getDaemonBaseUrl: () => '',
  getAllowedDaemonOrigin: (value: string) => value,
  confirmDaemonTarget: vi.fn(),
  isKnownDaemonTarget: () => false,
  // No token in the URL, so boot blocks on the postMessage handshake — the
  // window in which the watchdog's grace period can expire.
  getDaemonToken: () => testState.storedToken,
  navigateToDaemon: vi.fn(),
  persistDaemonToken: vi.fn(),
  removeDaemonTokenFromUrl: testState.removeToken,
  waitForDaemonTokenMessage: () =>
    new Promise<string>((resolve) => {
      testState.resolveToken = resolve;
    }),
}));

describe('web shell boot', () => {
  beforeEach(() => {
    testState.containers = [];
    testState.rendered = [];
    testState.resolveToken = undefined;
    testState.removeToken.mockClear();
    testState.storedToken = null;
    vi.resetModules();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute(
      'data-web-shell-unsupported-browser',
    );
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('keeps the native HTML update message on unsupported browsers', async () => {
    document.documentElement.setAttribute(
      'data-web-shell-unsupported-browser',
      'Update required',
    );
    document.body.innerHTML =
      '<div id="root"><div data-boot-fallback>Update required</div></div>';
    await import('./main');
    expect(testState.containers).toHaveLength(0);
    expect(testState.resolveToken).toBeUndefined();
    expect(testState.removeToken).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-boot-fallback]')?.textContent).toBe(
      'Update required',
    );
  });

  it('keeps only the fragment token when the daemon target is invalid', async () => {
    window.history.replaceState(
      null,
      '',
      '/?daemon=invalid&token=query-token#token=fragment-token',
    );
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    await vi.waitFor(() => expect(testState.containers).toHaveLength(1));
    expect(new URL(window.location.href).searchParams.has('token')).toBe(false);
    expect(window.location.hash).toBe('#token=fragment-token');
    expect(testState.removeToken).not.toHaveBeenCalled();
    expect(testState.resolveToken).toBeUndefined();
  });

  it('never exchanges a pairing code for an invalid daemon target', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    window.history.replaceState(null, '', '/?daemon=invalid#pairing=one-time');
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    await vi.waitFor(() => expect(testState.containers).toHaveLength(1));
    // The single-use invitation is scrubbed locally but must not be POSTed to
    // the page's own origin: booting with an invalid ?daemon= burns nothing.
    expect(window.location.hash).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('connects with the stored token when the pairing exchange fails', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      headers: new Headers(),
      json: async () => ({ error: 'expired' }),
    });
    vi.stubGlobal('fetch', fetch);
    testState.storedToken = 'still-valid-device-credential';
    window.history.replaceState(null, '', '/#pairing=expired-code');
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    await vi.waitFor(() => expect(testState.rendered).toHaveLength(1));

    // Mount the gate main() produced and let its probe effect run: a failed
    // exchange must fall back to the credential this tab already holds.
    const gate = document.createElement('div');
    document.body.appendChild(gate);
    await act(async () => {
      createRoot(gate).render(testState.rendered[0]);
    });

    const exchange = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/web-shell/pairing/exchange'),
    );
    expect(exchange).toHaveLength(1);
    // StrictMode mounts the gate's effect twice; every probe must carry the
    // stored credential, and pre-fix there is no probe at all.
    const probes = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/capabilities'),
    );
    expect(probes.length).toBeGreaterThan(0);
    for (const [, init] of probes) {
      expect(init).toMatchObject({
        headers: { Authorization: 'Bearer still-valid-device-credential' },
      });
    }
  });

  it('offers the rescan recovery when the stored credential is also rejected', async () => {
    const fetch = vi.fn().mockResolvedValue({
      status: 401,
      ok: false,
      headers: new Headers(),
      json: async () => ({ error: 'expired' }),
    });
    vi.stubGlobal('fetch', fetch);
    // Session storage outlives a daemon restart: this tab still holds a
    // device credential the (restarted) daemon no longer recognizes.
    testState.storedToken = 'stale-device-credential';
    window.history.replaceState(null, '', '/#pairing=expired-code');
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    await vi.waitFor(() => expect(testState.rendered).toHaveLength(1));

    const gate = document.createElement('div');
    document.body.appendChild(gate);
    await act(async () => {
      createRoot(gate).render(testState.rendered[0]);
    });

    // The stored credential is still probed…
    const probes = fetch.mock.calls.filter(([url]) =>
      String(url).endsWith('/capabilities'),
    );
    expect(probes.length).toBeGreaterThan(0);
    for (const [, init] of probes) {
      expect(init).toMatchObject({
        headers: { Authorization: 'Bearer stale-device-credential' },
      });
    }
    // …but its rejection must surface the rescan recovery, not the
    // terminal-token copy a phone user cannot act on.
    expect(gate.textContent).toContain('Pairing failed or the QR code expired');
    expect(gate.textContent).not.toContain('Invalid or expired token');
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
  }, 15_000);

  it('mounts into #root on a normal boot', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root') as HTMLElement;

    await import('./main');
    testState.resolveToken?.('token');
    await vi.waitFor(() => expect(testState.containers).toHaveLength(1));

    expect(testState.containers[0]).toBe(root);
  });
});
