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
import type { ManagedAgentProvider } from './components/managed/managed-agent-provider';
import { createJavaManagedAgentProvider } from './components/managed/java-managed-agent-provider';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const testState = vi.hoisted(() => ({
  bootEvents: [] as string[],
  containers: [] as Array<Element | null>,
  daemonBaseUrl: '' as string,
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
          testState.bootEvents.push('render');
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
  getDaemonBaseUrl: () => testState.daemonBaseUrl,
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
vi.mock('./config/shell-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config/shell-state')>();
  return {
    ...actual,
    hydrateShellState: vi.fn(async () => {
      testState.bootEvents.push('hydrate-start');
      // The delay keeps the ordering assertion meaningful, and delegating to
      // the real adapter lets a desktop-shape boot read a hydrated cache.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await actual.hydrateShellState();
      testState.bootEvents.push('hydrate-end');
    }),
  };
});

describe('web shell boot', () => {
  beforeEach(() => {
    testState.bootEvents = [];
    testState.containers = [];
    testState.daemonBaseUrl = '';
    testState.rendered = [];
    testState.resolveToken = undefined;
    testState.removeToken.mockClear();
    testState.storedToken = null;
    vi.resetModules();
  });

  afterEach(() => {
    delete (window as { __TAURI__?: unknown }).__TAURI__;
    document.body.innerHTML = '';
    document.documentElement.removeAttribute(
      'data-web-shell-unsupported-browser',
    );
    document.querySelector('meta[name="qwen-managed-app"]')?.remove();
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
  });

  it('hydrates shell state before the first render', async () => {
    testState.storedToken = 'boot-token';
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');

    await vi.waitFor(() =>
      expect(testState.bootEvents).toEqual([
        'hydrate-start',
        'hydrate-end',
        'render',
      ]),
    );
  });

  it('does not gate a daemon the desktop catalog already names', async () => {
    // The desktop shell keeps the saved-connection catalog in its own settings
    // file, so the boot-time confirmation decision cannot be made before
    // hydration: a module-scope read sees an empty store and asks the user to
    // confirm a host they added and saved themselves.
    // The mirror is cleared because this run's vitest shares one
    // `--localstorage-file` across files, and an unrelated catalog left by
    // another file would otherwise look like a newer local copy.
    window.localStorage.clear();
    const invoke = vi.fn(
      async (command: string, args?: Record<string, unknown>) => {
        if (command !== 'shell_state_read') return undefined;
        return args?.['key'] === 'qwen-remote-connections'
          ? '["https://daemon.test"]'
          : null;
      },
    );
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    testState.daemonBaseUrl = 'https://daemon.test';
    window.history.replaceState(null, '', '/?daemon=https://daemon.test');
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    await vi.waitFor(() => expect(testState.rendered).toHaveLength(1));

    const strictMode = testState.rendered[0] as React.ReactElement<{
      children: React.ReactElement<{
        baseUrl: string;
        unconfirmedTarget: boolean;
      }>;
    }>;
    const gate = strictMode.props.children;
    expect(gate.props.baseUrl).toBe('https://daemon.test');
    expect(gate.props.unconfirmedTarget).toBe(false);
  });

  it('gates a daemon no catalog names', async () => {
    // The case above pins only the false direction. Without this one,
    // replacing the computation with `const unconfirmedDaemonTarget = false`
    // would ship green and send a stored credential to an origin the user
    // never approved.
    window.localStorage.clear();
    const invoke = vi.fn(async () => null);
    (window as { __TAURI__?: unknown }).__TAURI__ = { core: { invoke } };
    testState.daemonBaseUrl = 'https://unknown.example';
    window.history.replaceState(null, '', '/?daemon=https://unknown.example');
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    await vi.waitFor(() => expect(testState.rendered).toHaveLength(1));

    const strictMode = testState.rendered[0] as React.ReactElement<{
      children: React.ReactElement<{
        baseUrl: string;
        unconfirmedTarget: boolean;
      }>;
    }>;
    const gate = strictMode.props.children;
    expect(gate.props.baseUrl).toBe('https://unknown.example');
    expect(gate.props.unconfirmedTarget).toBe(true);
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

  it('fixes Managed boot to the page origin and removes daemon and fanout overrides', async () => {
    const marker = document.createElement('meta');
    marker.name = 'qwen-managed-app';
    marker.content = 'true';
    document.head.appendChild(marker);
    window.history.replaceState(
      null,
      '',
      '/?daemon=https://attacker.example&fanout=https://other.example#token=browser-token',
    );
    testState.storedToken = 'browser-token';
    document.body.innerHTML = '<div id="root"></div>';
    await import('./main');
    await vi.waitFor(() => expect(testState.rendered).toHaveLength(1));
    const url = new URL(window.location.href);
    expect(url.searchParams.has('daemon')).toBe(false);
    expect(url.searchParams.has('fanout')).toBe(false);
    const strictMode = testState.rendered[0] as React.ReactElement<{
      children: React.ReactElement<{
        baseUrl: string;
        invalidTarget: boolean;
        children: (token: string) => React.ReactElement;
      }>;
    }>;
    const gate = strictMode.props.children;
    expect(gate.props.baseUrl).toBe(window.location.origin);
    expect(gate.props.invalidTarget).toBe(false);
    const managedBoot = gate.props.children(
      'browser-token',
    ) as React.ReactElement<{
      daemonToken: string;
      children: (provider: ManagedAgentProvider) => React.ReactElement<{
        daemonToken: string;
        managedAgentProvider: ManagedAgentProvider;
      }>;
    }>;
    expect(managedBoot.type).toBe(
      (await import('./ManagedStandaloneApp')).ManagedStandaloneApp,
    );
    expect(managedBoot.props.daemonToken).toBe('browser-token');
    const provider = createJavaManagedAgentProvider({
      baseUrl: window.location.origin,
      productScope: 'local:installation-1',
    });
    const shell = managedBoot.props.children(provider);
    expect(shell.type).toBe((await import('./main')).StandaloneApp);
    expect(shell.props.daemonToken).toBe('browser-token');
    expect(shell.props.managedAgentProvider).toBe(provider);
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
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer still-valid-device-credential',
      );
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
      expect(new Headers(init?.headers).get('Authorization')).toBe(
        'Bearer stale-device-credential',
      );
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

    await vi.waitFor(() => expect(testState.resolveToken).toBeDefined());
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
    await vi.waitFor(() => expect(testState.resolveToken).toBeDefined());
    testState.resolveToken?.('token');
    await vi.waitFor(() => expect(testState.containers).toHaveLength(1));

    expect(testState.containers[0]).toBe(root);
  });
});
