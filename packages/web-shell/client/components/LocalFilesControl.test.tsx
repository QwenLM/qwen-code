/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonCapabilities,
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import {
  createLocalFilesRewarm,
  resolveLocalFilesWorkspaceRoute,
} from './LocalFilesControl';

const capturedHookOptions = vi.hoisted(() => ({
  current: undefined as unknown,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => ({ sessionId: 'session-1', workspaceCwd: '/primary' }),
  useWorkspace: () => ({
    baseUrl: 'https://daemon.example/',
    token: undefined,
    capabilities: {
      qwenCodeVersion: '1.2.3',
      workspaceCwd: '/primary',
      features: ['dynamic_workspace_registration'],
      workspaces: [
        {
          id: 'ws-1',
          cwd: '/primary',
          kind: 'directory',
          primary: true,
          trusted: false,
        },
      ],
    },
    client: {},
  }),
  useWorkspaceActions: () => ({ preheatAcp: vi.fn() }),
}));

vi.mock('../local-files/useLocalFilesBridge', () => ({
  useLocalFilesBridge: (options: unknown) => {
    capturedHookOptions.current = options;
    return {
      status: { phase: 'idle', blocker: null },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  },
}));

const primary = {
  id: 'ws-1',
  cwd: '/primary',
  kind: 'directory',
  primary: true,
  trusted: true,
} as unknown as DaemonWorkspaceCapability;

const locked = {
  id: 'locked-ws',
  cwd: '/locked',
  kind: 'directory',
  primary: false,
  trusted: true,
} as unknown as DaemonWorkspaceCapability;

const capabilities = {
  qwenCodeVersion: '1.2.3',
  workspaceCwd: '/primary',
  features: ['dynamic_workspace_registration'],
  workspaces: [primary],
} as unknown as DaemonCapabilities;

describe('resolveLocalFilesWorkspaceRoute', () => {
  it('resolves a locked workspace only from the merged list', () => {
    const base = {
      capabilities,
      workspaceCwd: '/locked',
      sessionId: 'session-1',
    };
    // The bare snapshot lacks the locked entry: both sibling voice call sites
    // pass the merged list for exactly this reason.
    expect(resolveLocalFilesWorkspaceRoute(base)).toBeUndefined();
    expect(
      resolveLocalFilesWorkspaceRoute({
        ...base,
        workspaces: [primary, locked],
      }),
    ).toEqual({
      kind: 'qualified',
      selector: { kind: 'id', value: 'locked-ws' },
    });
  });

  it('keeps the legacy route for the primary workspace', () => {
    expect(
      resolveLocalFilesWorkspaceRoute({
        capabilities,
        workspaces: [primary, locked],
        workspaceCwd: '/primary',
        sessionId: 'session-1',
      }),
    ).toEqual({ kind: 'legacy' });
  });

  it('withholds the bridge for untrusted, live and ambiguous workspaces', () => {
    const untrusted = {
      ...locked,
      id: 'untrusted-ws',
      cwd: '/untrusted',
      trusted: false,
    } as unknown as DaemonWorkspaceCapability;
    const live = {
      ...locked,
      id: 'live-ws',
      cwd: '/live',
      kind: 'live',
    } as unknown as DaemonWorkspaceCapability;
    const base = { capabilities, sessionId: 'session-1' };
    expect(
      resolveLocalFilesWorkspaceRoute({
        ...base,
        workspaces: [primary, untrusted],
        workspaceCwd: '/untrusted',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveLocalFilesWorkspaceRoute({
        ...base,
        workspaces: [primary, live],
        workspaceCwd: '/live',
      }),
    ).toEqual({ kind: 'none' });
    expect(
      resolveLocalFilesWorkspaceRoute({
        ...base,
        workspaces: [primary, locked, { ...locked }],
        workspaceCwd: '/locked',
      }),
    ).toEqual({ kind: 'none' });
    // A session with no workspace cwd against a known registry cannot be
    // mapped to any eligible workspace either.
    expect(
      resolveLocalFilesWorkspaceRoute({
        ...base,
        workspaces: [primary],
        workspaceCwd: undefined,
      }),
    ).toEqual({ kind: 'none' });
  });

  it('withholds the bridge for an untrusted or live primary workspace', () => {
    // The shared resolver exempts the primary workspace from its trust/live
    // test, but the bare /acp mount performs no trust check at registration.
    const untrustedPrimary = {
      ...primary,
      trusted: false,
    } as unknown as DaemonWorkspaceCapability;
    const livePrimary = {
      ...primary,
      kind: 'live',
    } as unknown as DaemonWorkspaceCapability;
    for (const entry of [untrustedPrimary, livePrimary]) {
      expect(
        resolveLocalFilesWorkspaceRoute({
          capabilities,
          workspaces: [entry],
          workspaceCwd: '/primary',
          sessionId: 'session-1',
        }),
      ).toEqual({ kind: 'none' });
    }
  });

  it('stays undecided while the capabilities snapshot is pending', () => {
    expect(
      resolveLocalFilesWorkspaceRoute({
        capabilities: undefined,
        workspaceCwd: '/primary',
        sessionId: 'session-1',
      }),
    ).toBeUndefined();
    expect(
      resolveLocalFilesWorkspaceRoute({
        capabilities,
        workspaces: [primary],
        workspaceCwd: '/not-in-snapshot-yet',
        sessionId: 'session-1',
      }),
    ).toBeUndefined();
  });
});

describe('createLocalFilesRewarm', () => {
  it('warms the qualified runtime for a secondary selector', async () => {
    const ensureRuntime = vi.fn().mockResolvedValue({});
    const workspaceById = vi.fn(() => ({ ensureRuntime }));
    const client = { workspaceById } as unknown as DaemonClient;
    const preheat = vi.fn();

    await createLocalFilesRewarm({
      client,
      selector: { kind: 'id', value: 'ws-2' },
      preheat,
    })();

    expect(workspaceById).toHaveBeenCalledWith('ws-2');
    expect(ensureRuntime).toHaveBeenCalled();
    expect(preheat).not.toHaveBeenCalled();
  });

  it('falls back to the legacy preheat without a selector or on route failure', async () => {
    const ensureRuntime = vi
      .fn()
      .mockRejectedValue(new DaemonHttpError(404, {}, 'no such route'));
    const client = {
      workspaceById: vi.fn(() => ({ ensureRuntime })),
    } as unknown as DaemonClient;
    const preheat = vi.fn();

    await createLocalFilesRewarm({
      client,
      selector: { kind: 'id', value: 'ws-2' },
      preheat,
    })();
    expect(preheat).toHaveBeenCalledTimes(1);

    await createLocalFilesRewarm({ client, selector: undefined, preheat })();
    expect(preheat).toHaveBeenCalledTimes(2);
  });

  it('propagates non-404 ensureRuntime failures instead of preheating primary', async () => {
    // Silently warming the primary runtime for a secondary session is the
    // exact failure the qualified rewarm exists to prevent.
    const ensureRuntime = vi
      .fn()
      .mockRejectedValue(new DaemonHttpError(500, {}, 'runtime spawn failed'));
    const client = {
      workspaceById: vi.fn(() => ({ ensureRuntime })),
    } as unknown as DaemonClient;
    const preheat = vi.fn();

    await expect(
      createLocalFilesRewarm({
        client,
        selector: { kind: 'id', value: 'ws-2' },
        preheat,
      })(),
    ).rejects.toThrow(/runtime spawn failed/);
    expect(preheat).not.toHaveBeenCalled();
  });
});

describe('LocalFilesControl wiring', () => {
  it('passes the withheld blocker into the bridge hook for an untrusted primary', async () => {
    // The resolver's decision is pinned above; this pins its APPLICATION -
    // without the wiring line the hook never sees the blocker and the trust
    // fix never reaches the bridge.
    const { act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('../i18n');
    const { LocalFilesControl } = await import('./LocalFilesControl');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <I18nProvider language="en">
          <LocalFilesControl triggerClassName="t" />
        </I18nProvider>,
      );
    });
    const options = capturedHookOptions.current as {
      withheldBlocker?: string;
    };
    expect(options.withheldBlocker).toBe('workspace-ineligible');
    act(() => root.unmount());
    container.remove();
  });
});
