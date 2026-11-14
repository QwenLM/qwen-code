/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { I18nProvider } from '../i18n';
import { cleanupReact, flushReact, mountReact } from '../test/reactHarness';
import type {
  DaemonCapabilities,
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type { LocalFilesStatus } from '../local-files/useLocalFilesBridge';
import {
  LocalFilesControl,
  createLocalFilesRewarm,
  resolveLocalFilesWorkspaceRoute,
  getLocalFilesDotClass,
  getLocalFilesTooltip,
  deriveLocalFilesTunnelCommand,
} from './LocalFilesControl';

const bridgeLifecycle = vi.hoisted(() => ({
  mount: vi.fn(),
  cleanup: vi.fn(),
}));

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
    | { sessionId?: string; workspaceCwd?: string; displayName?: string }
    | undefined,
}));

// Per-case bridge status / connect spy for the wiring tests appended below.
const bridgeStatusOverride = vi.hoisted(() => ({
  current: undefined as unknown,
}));
// The real hook's connect() always returns a promise; the control chains
// .then() on it for the repick-failed toast.
const bridgeConnectSpy = vi.hoisted(() =>
  vi.fn(async (): Promise<{ kind: 'repick-failed' } | undefined> => undefined),
);
const toastSpy = vi.hoisted(() => vi.fn());
const newSessionSpy = vi.hoisted(() => vi.fn(async () => {}));

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
    useActions: () => ({ newSession: newSessionSpy }),
  };
});

vi.mock('../local-files/useLocalFilesBridge', () => ({
  useLocalFilesBridge: (options: unknown) => {
    useEffect(() => {
      bridgeLifecycle.mount();
      return bridgeLifecycle.cleanup;
    }, []);
    capturedHookOptions.current = options;
    return {
      status: bridgeStatusOverride.current ?? { phase: 'idle', blocker: null },
      connect: bridgeConnectSpy,
      disconnect: vi.fn(),
    };
  },
}));

vi.mock('./ToastHost', () => ({
  requestToast: toastSpy,
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
      // No session yet: the shared resolver matched the primary by the cwd
      // it derived itself, so keying the trust lookup on the undefined
      // workspaceCwd would miss and fail open.
      expect(
        resolveLocalFilesWorkspaceRoute({
          capabilities,
          workspaces: [entry],
          workspaceCwd: undefined,
          sessionId: undefined,
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
          features: [],
          workspaces: undefined,
        } as unknown as DaemonCapabilities,
        workspaces: [],
        workspaceCwd: '/primary',
        sessionId: 'session-1',
      }),
    ).toEqual({ kind: 'legacy' });
  });

  it('withholds while a registration-advertising daemon bootstraps', () => {
    // Bootstrap envelope: the features are advertised but the workspaces
    // array has not been published yet, so the trust verdict has not landed
    // and answering eligible would dial the bare mount without its check.
    expect(
      resolveLocalFilesWorkspaceRoute({
        capabilities: {
          ...capabilities,
          features: ['dynamic_workspace_registration', 'client_mcp_over_ws'],
          workspaces: undefined,
        } as unknown as DaemonCapabilities,
        workspaces: [],
        workspaceCwd: '/primary',
        sessionId: 'session-1',
      }),
    ).toEqual({ kind: 'pending' });
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
      | {
          withheldBlocker?: string;
          workspaceSelector?: { kind: string; value: string };
        }
      | undefined;
    act(() => root.unmount());
    container.remove();
    // Without this a render that never reached the hook would read as
    // "no blocker" and the positive control would pass vacuously.
    if (options === undefined) throw new Error('hook never ran');
    return options;
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
    expect((await renderCaptured(undefined)).withheldBlocker).toBe(
      'workspace-ineligible',
    );
    // The same verdict with no session at all: the resolver matched the
    // primary by its own derived cwd, so the trust lookup must not key on
    // the undefined workspaceCwd either.
    expect(
      (
        await renderCaptured(undefined, {
          sessionId: undefined,
          workspaceCwd: undefined,
        })
      ).withheldBlocker,
    ).toBe('workspace-ineligible');
  });

  it('withholds when the daemon lacks the feature or the snapshot is pending', async () => {
    // Daemon without the reverse channel: no point offering Connect.
    expect((await renderCaptured({ ...capabilities })).withheldBlocker).toBe(
      'unsupported-daemon',
    );

    // Capabilities without a features array at all (version skew): the
    // preflight must withhold instead of throwing during render. Both cases
    // derive from one fixture, so they differ by exactly the `features` key.
    const noFeatures: Partial<DaemonCapabilities> = { ...capabilities };
    delete noFeatures.features;
    expect((await renderCaptured(noFeatures)).withheldBlocker).toBe(
      'unsupported-daemon',
    );

    // Snapshot pending: starting now would fail open onto the primary mount.
    expect((await renderCaptured(null)).withheldBlocker).toBe(
      'workspace-resolving',
    );
  });

  it('withholds nothing for eligible routes (positive control)', async () => {
    const capable = {
      ...capabilities,
      features: ['dynamic_workspace_registration', 'client_mcp_over_ws'],
    };
    // A mutation that maps an eligible route onto a blocker would silently
    // turn the feature off for everyone: legacy is the most common shape.
    const legacy = await renderCaptured(capable);
    expect(legacy.withheldBlocker).toBeUndefined();
    // The other half of the wiring: the qualified route must forward the
    // resolver's selector, or the bridge dials the wrong mount.
    expect(legacy.workspaceSelector).toBeUndefined();
    const qualified = await renderCaptured(
      { ...capable, workspaces: [primary, locked] },
      { workspaceCwd: '/locked' },
    );
    expect(qualified.withheldBlocker).toBeUndefined();
    expect(qualified.workspaceSelector).toEqual({
      kind: 'id',
      value: 'locked-ws',
    });
  });
});

it('keeps the local-files bridge mounted while the More slot opens and closes', async () => {
  bridgeLifecycle.mount.mockClear();
  bridgeLifecycle.cleanup.mockClear();
  let setSlot: (slot: HTMLElement | null) => void = () => {};
  function Harness() {
    const [slot, updateSlot] = useState<HTMLElement | null>(null);
    setSlot = updateSlot;
    return (
      <I18nProvider language="en">
        <LocalFilesControl triggerClassName="" portalContainer={slot} />
      </I18nProvider>
    );
  }
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  try {
    mountReact(<Harness />);
    await flushReact();
    expect(bridgeLifecycle.mount).toHaveBeenCalledTimes(1);
    expect(slot.querySelector('button')).toBeNull();
    act(() => setSlot(slot));
    await flushReact();
    expect(slot.querySelector('button')?.getAttribute('aria-label')).toBe(
      'Local files',
    );
    act(() => setSlot(null));
    await flushReact();
    expect(slot.querySelector('button')).toBeNull();
    expect(bridgeLifecycle.cleanup).not.toHaveBeenCalled();
    act(() => setSlot(slot));
    await flushReact();
    expect(bridgeLifecycle.mount).toHaveBeenCalledTimes(1);
  } finally {
    cleanupReact();
    slot.remove();
  }
  expect(bridgeLifecycle.cleanup).toHaveBeenCalledTimes(1);
});

describe('getLocalFilesDotClass', () => {
  it.each<[LocalFilesStatus['phase'], string | null]>([
    ['connected', 'bg-primary'],
    ['held-elsewhere', 'bg-muted-foreground'],
    ['connecting', 'bg-muted-foreground'],
    ['registering', 'bg-muted-foreground'],
    ['reconnecting', 'bg-[var(--warning-color)]'],
    ['needs-gesture', 'bg-[var(--warning-color)]'],
    ['failed', 'bg-destructive'],
    ['idle', null],
    ['needs-session', null],
    ['unavailable', null],
  ])('maps %s to %s', (phase, expected) => {
    expect(getLocalFilesDotClass({ phase, blocker: null })).toBe(expected);
  });

  it('uses the theme-aware warning token for the warning states (R2-1)', () => {
    // A fixed palette color (bg-amber-500) is low-contrast in the light theme;
    // the warning states must resolve to the theme-aware token. Reverting to a
    // raw palette color makes this go red.
    for (const phase of ['reconnecting', 'needs-gesture'] as const) {
      expect(getLocalFilesDotClass({ phase, blocker: null })).toBe(
        'bg-[var(--warning-color)]',
      );
    }
  });

  it('keeps held-elsewhere visually distinct from a bridge this tab owns', () => {
    // A bridge held by another tab is live but not usable here; the trigger
    // must not show the same "connected" dot as one this tab owns.
    expect(
      getLocalFilesDotClass({ phase: 'held-elsewhere', blocker: null }),
    ).not.toBe(getLocalFilesDotClass({ phase: 'connected', blocker: null }));
  });
});

describe('getLocalFilesTooltip', () => {
  const t = (key: string) => key;
  it('names the state and the directory', () => {
    expect(
      getLocalFilesTooltip(
        { phase: 'connected', blocker: null, rootName: 'proj' },
        t,
      ),
    ).toBe('localFiles.trigger — localFiles.status.connected (proj)');
  });
  it('omits the directory when none is named', () => {
    expect(getLocalFilesTooltip({ phase: 'failed', blocker: null }, t)).toBe(
      'localFiles.trigger — localFiles.status.failed',
    );
  });
  it('uses the resolving label during a transient resolving blip (R1-7)', () => {
    expect(
      getLocalFilesTooltip(
        { phase: 'unavailable', blocker: 'workspace-resolving' },
        t,
      ),
    ).toBe('localFiles.trigger — localFiles.status.resolving');
  });
});

describe('deriveLocalFilesTunnelCommand (R1-3)', () => {
  it('clamps a privileged remote port to an unprivileged local bind', () => {
    // http://daemon.example/ has no explicit port → remote 80, which a non-root
    // user cannot bind locally. Without the clamp this copies -L 80:…:80.
    expect(deriveLocalFilesTunnelCommand('http://daemon.example/')).toBe(
      'ssh -L 8080:localhost:80 daemon.example',
    );
    expect(deriveLocalFilesTunnelCommand('https://daemon.example/')).toBe(
      'ssh -L 8443:localhost:443 daemon.example',
    );
  });
  it('keeps an unprivileged port unchanged', () => {
    expect(deriveLocalFilesTunnelCommand('http://host:4170/')).toBe(
      'ssh -L 4170:localhost:4170 host',
    );
  });
  it('strips IPv6 brackets so ssh gets a bare host', () => {
    expect(deriveLocalFilesTunnelCommand('http://[2001:db8::1]:4170/')).toBe(
      'ssh -L 4170:localhost:4170 2001:db8::1',
    );
  });
  it('returns undefined for a relative or base-less URL', () => {
    expect(
      deriveLocalFilesTunnelCommand('/api/agent/web-shell/v1'),
    ).toBeUndefined();
    expect(deriveLocalFilesTunnelCommand('')).toBeUndefined();
  });
});

describe('LocalFilesControl trigger and notices', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    bridgeStatusOverride.current = undefined;
    bridgeConnectSpy.mockClear();
    toastSpy.mockClear();
    newSessionSpy.mockClear();
    capsOverride.current = undefined;
    connectionOverride.current = undefined;
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });
  });

  async function renderControl() {
    const { createRoot } = await import('react-dom/client');
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const renderTree = () => (
      <I18nProvider language="en">
        <LocalFilesControl triggerClassName="t" />
      </I18nProvider>
    );
    act(() => {
      root.render(renderTree());
    });
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };
    return {
      container,
      rerender: () =>
        act(() => {
          root.render(renderTree());
        }),
    };
  }

  function triggerOf(container: HTMLElement): HTMLElement {
    const trigger = container.querySelector<HTMLElement>(
      'button[aria-label="Local files"]',
    );
    if (!trigger) throw new Error('trigger never rendered');
    return trigger;
  }

  it('renders a red dot and a state tooltip for a failed bridge', async () => {
    bridgeStatusOverride.current = {
      phase: 'failed',
      blocker: null,
      rootName: 'proj',
      message: 'x',
    };
    const { container } = await renderControl();
    const trigger = triggerOf(container);
    expect(trigger.getAttribute('title')).toBe('Local files — Failed (proj)');
    expect(trigger.querySelector('.bg-destructive')).not.toBeNull();
  });

  it('renders a warning-token dot for a grant that needs a gesture', async () => {
    bridgeStatusOverride.current = {
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'proj',
    };
    const { container } = await renderControl();
    const dot = triggerOf(container).querySelector('span[aria-hidden="true"]');
    expect(dot?.className).toContain('var(--warning-color)');
  });

  it('exposes the state as an accessible description, name unchanged (R1-8)', async () => {
    bridgeStatusOverride.current = {
      phase: 'failed',
      blocker: null,
      rootName: 'proj',
      message: 'x',
    };
    const { container } = await renderControl();
    const trigger = triggerOf(container);
    // The accessible name stays the stable trigger label…
    expect(trigger.getAttribute('aria-label')).toBe('Local files');
    // …while the state is reachable as a description for assistive tech.
    const describedBy = trigger.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy!);
    expect(description?.textContent).toBe('Local files — Failed (proj)');
  });

  it('tooltip says Resolving during a transient resolving blip (R1-7)', async () => {
    bridgeStatusOverride.current = {
      phase: 'unavailable',
      blocker: 'workspace-resolving',
    };
    const { container } = await renderControl();
    expect(triggerOf(container).getAttribute('title')).toBe(
      'Local files — Resolving…',
    );
  });

  it('warns once when a grant needs a gesture, and not on re-render', async () => {
    bridgeStatusOverride.current = {
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'proj',
    };
    const { rerender } = await renderControl();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('proj'),
    );
    // Force the effect to re-run with the same phase (rootName is a dep):
    // the dedupe ref must suppress a second toast.
    bridgeStatusOverride.current = {
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'other',
    };
    rerender();
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it('warns again when a later reload re-enters needs-gesture (R1-15)', async () => {
    bridgeStatusOverride.current = {
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'proj',
    };
    const { rerender } = await renderControl();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    // The user reconnects and works for a while…
    bridgeStatusOverride.current = {
      phase: 'connected',
      blocker: null,
      rootName: 'proj',
      toolCount: 4,
    };
    rerender();
    // …then a later reload falls back to needing re-authorization again. A
    // fire-once-per-mount latch (prev === undefined) would stay silent here.
    bridgeStatusOverride.current = {
      phase: 'needs-gesture',
      blocker: null,
      rootName: 'proj',
    };
    rerender();
    expect(toastSpy).toHaveBeenCalledTimes(2);
  });

  it('does not warn for a connected bridge', async () => {
    bridgeStatusOverride.current = {
      phase: 'connected',
      blocker: null,
      rootName: 'proj',
      toolCount: 4,
    };
    await renderControl();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('change directory calls connect with forcePicker', async () => {
    bridgeStatusOverride.current = {
      phase: 'connected',
      blocker: null,
      rootName: 'proj',
      toolCount: 4,
    };
    const { container } = await renderControl();
    const trigger = triggerOf(container);
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const change = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Change directory…',
    );
    if (!change) throw new Error('popover never opened');
    act(() => {
      change.click();
    });
    expect(bridgeConnectSpy).toHaveBeenCalledWith({ forcePicker: true });
  });

  it('toasts when a forced re-pick fails, and stays silent otherwise', async () => {
    bridgeStatusOverride.current = {
      phase: 'connected',
      blocker: null,
      rootName: 'proj',
      toolCount: 4,
    };
    const { container } = await renderControl();
    openPopover(container);
    bridgeConnectSpy.mockResolvedValueOnce({ kind: 'repick-failed' });
    await act(async () => {
      panelButton('Change directory…').click();
    });
    expect(toastSpy).toHaveBeenCalledWith(
      'error',
      'Could not change the directory. The current directory is still connected.',
    );
    toastSpy.mockClear();
    await act(async () => {
      panelButton('Change directory…').click();
    });
    expect(toastSpy).not.toHaveBeenCalled();
  });

  function openPopover(container: HTMLElement): void {
    act(() => {
      triggerOf(container).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
  }

  function panelButton(label: string): HTMLButtonElement {
    const button = Array.from(document.querySelectorAll('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (!button) throw new Error(`popover button never rendered: ${label}`);
    return button;
  }

  function stubClipboard() {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    return writeText;
  }

  it('copies the daemon startup command and reports success', async () => {
    const writeText = stubClipboard();
    bridgeStatusOverride.current = {
      phase: 'unavailable',
      blocker: 'unsupported-daemon',
    };
    const { container } = await renderControl();
    openPopover(container);
    await act(async () => {
      panelButton('Copy startup command').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Pin the literal, not the constant-to-constant tautology (R1-12): a
    // command that does not enable the reverse channel must go red.
    expect(writeText).toHaveBeenCalledWith(
      'QWEN_SERVE_CLIENT_MCP_OVER_WS=1 qwen serve',
    );
    expect(toastSpy).toHaveBeenCalledWith('success', 'Command copied');
  });

  it('reports a clipboard rejection instead of claiming success (R1-13)', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    bridgeStatusOverride.current = {
      phase: 'unavailable',
      blocker: 'unsupported-daemon',
    };
    const { container } = await renderControl();
    openPopover(container);
    await act(async () => {
      panelButton('Copy startup command').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(toastSpy).toHaveBeenCalledWith(
      'error',
      'Could not copy the command',
    );
    expect(toastSpy).not.toHaveBeenCalledWith('success', 'Command copied');
  });

  it('derives and copies the SSH tunnel command for an insecure origin', async () => {
    const writeText = stubClipboard();
    bridgeStatusOverride.current = {
      phase: 'unavailable',
      blocker: 'insecure-context',
    };
    const { container } = await renderControl();
    openPopover(container);
    await act(async () => {
      panelButton('Copy SSH tunnel command').click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Default mock baseUrl is https://daemon.example/ → remote 443, and a
    // non-root user cannot bind 443 locally, so the local port is clamped high.
    expect(writeText).toHaveBeenCalledWith(
      'ssh -L 8443:localhost:443 daemon.example',
    );
  });

  it('offers new session in needs-session and calls the session action', async () => {
    bridgeStatusOverride.current = { phase: 'needs-session', blocker: null };
    const { container } = await renderControl();
    openPopover(container);
    act(() => {
      panelButton('New session').click();
    });
    expect(newSessionSpy).toHaveBeenCalledOnce();
  });

  it('shows the bound session name from the connection', async () => {
    connectionOverride.current = { displayName: 'My task' };
    bridgeStatusOverride.current = {
      phase: 'connected',
      blocker: null,
      rootName: 'proj',
      toolCount: 4,
    };
    const { container } = await renderControl();
    openPopover(container);
    expect(document.body.textContent).toContain('My task');
  });
});
