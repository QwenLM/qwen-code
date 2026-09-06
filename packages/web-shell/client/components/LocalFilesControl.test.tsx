/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
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

// Per-case capabilities/connection for the single file-level mock factory:
// the factory runs at module load, so per-test vi.doMock would override the
// file-level mock and never restore it, leaking the LAST factory into every
// test appended after it.
const capsOverride = vi.hoisted(() => ({
  current: undefined as unknown,
}));
// Sentinel for "render with the mock's default capabilities": a bare null
// override means "capabilities undefined" (pending snapshot), and `??`
// inside the factory would collapse null into the default.
const DEFAULT_CAPS = vi.hoisted(() => ({ sentinel: 'default-caps' }));
const connectionOverride = vi.hoisted(() => ({
  current: undefined as
    | { sessionId?: string; workspaceCwd?: string }
    | undefined,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => {
  const fallback = {
    qwenCodeVersion: '1.2.3',
    workspaceCwd: '/primary',
    features: ['dynamic_workspace_registration', 'client_mcp_over_ws'],
    workspaces: [
      {
        id: 'ws-1',
        cwd: '/primary',
        kind: 'directory',
        primary: true,
        trusted: false,
      },
    ],
  };
  return {
    useConnection: () => ({
      sessionId: 'session-1',
      workspaceCwd: '/primary',
      ...connectionOverride.current,
    }),
    useWorkspace: () => ({
      baseUrl: 'https://daemon.example/',
      token: undefined,
      capabilities:
        capsOverride.current === undefined ||
        capsOverride.current === DEFAULT_CAPS
          ? fallback
          : capsOverride.current || undefined,
      client: {},
    }),
    useWorkspaceActions: () => ({ preheatAcp: vi.fn() }),
  };
});

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
    // The bare snapshot lacks the locked entry: judgement waits (pending)
    // until the merged list (or a refreshed snapshot) arrives.
    expect(resolveLocalFilesWorkspaceRoute(base)).toEqual({ kind: 'pending' });
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
    const noTrustField = {
      ...locked,
      id: 'notrust-ws',
      cwd: '/notrust',
      trusted: undefined,
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
        workspaces: [primary, noTrustField],
        workspaceCwd: '/notrust',
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
    const noTrustFieldPrimary = {
      ...primary,
      trusted: undefined,
    } as unknown as DaemonWorkspaceCapability;
    for (const entry of [untrustedPrimary, livePrimary, noTrustFieldPrimary]) {
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
    ).toEqual({ kind: 'pending' });
    expect(
      resolveLocalFilesWorkspaceRoute({
        capabilities,
        workspaces: [primary],
        workspaceCwd: '/not-in-snapshot-yet',
        sessionId: 'session-1',
      }),
    ).toEqual({ kind: 'pending' });
  });

  it('resolves legacy for a single-workspace daemon without a registry', () => {
    expect(
      resolveLocalFilesWorkspaceRoute({
        capabilities: {
          ...capabilities,
          workspaces: undefined,
        } as unknown as DaemonCapabilities,
        workspaces: [],
        workspaceCwd: '/primary',
        sessionId: 'session-1',
      }),
    ).toEqual({ kind: 'legacy' });
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
  // `caps === undefined` keeps the file-level mock's default capabilities;
  // `caps === null` renders a pending snapshot (capabilities undefined).
  const renderCaptured = async (
    caps: unknown,
    connection?: { sessionId?: string; workspaceCwd?: string },
  ) => {
    capsOverride.current = caps === undefined ? DEFAULT_CAPS : caps;
    connectionOverride.current = connection;
    capturedHookOptions.current = undefined;
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
    const options = capturedHookOptions.current as
      | { withheldBlocker?: string }
      | undefined;
    act(() => root.unmount());
    container.remove();
    // Without this a render that never reached the hook would read as
    // "no blocker" and the positive control would pass vacuously.
    if (options === undefined) throw new Error('hook never ran');
    return options.withheldBlocker;
  };

  afterEach(() => {
    capsOverride.current = undefined;
    connectionOverride.current = undefined;
    capturedHookOptions.current = undefined;
  });

  it('passes the withheld blocker into the bridge hook for an untrusted primary', async () => {
    // The resolver's decision is pinned above; this pins its APPLICATION -
    // without the wiring line the hook never sees the blocker and the trust
    // fix never reaches the bridge. Default mock caps: untrusted primary.
    expect(await renderCaptured(undefined)).toBe('workspace-ineligible');
  });

  it('withholds when the daemon lacks the feature or the snapshot is pending', async () => {
    // Daemon without the reverse channel: no point offering Connect.
    expect(await renderCaptured({ ...capabilities })).toBe(
      'unsupported-daemon',
    );

    // Capabilities without a features array at all (version skew): the
    // preflight must withhold instead of throwing during render. Both cases
    // derive from one fixture, so they differ by exactly the `features` key.
    const noFeatures: Partial<DaemonCapabilities> = { ...capabilities };
    delete noFeatures.features;
    expect(await renderCaptured(noFeatures)).toBe('unsupported-daemon');

    // Snapshot pending: starting now would fail open onto the primary mount.
    expect(await renderCaptured(null)).toBe('workspace-resolving');
  });

  it('withholds nothing for eligible routes (positive control)', async () => {
    const capable = {
      ...capabilities,
      features: ['dynamic_workspace_registration', 'client_mcp_over_ws'],
    };
    // A mutation that maps an eligible route onto a blocker would silently
    // turn the feature off for everyone: legacy is the most common shape.
    expect(await renderCaptured(capable)).toBeUndefined();
    // Trusted secondary: the qualified route shares the same fall-through.
    expect(
      await renderCaptured(
        { ...capable, workspaces: [primary, locked] },
        { workspaceCwd: '/locked' },
      ),
    ).toBeUndefined();
  });
});
