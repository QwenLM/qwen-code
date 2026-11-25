// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonClient,
  DaemonWorkspaceCapability,
} from '@qwen-code/sdk/daemon';
import {
  useWorkspaceTrustGrant,
  type UseWorkspaceTrustGrantOptions,
  type WorkspaceTrustGrantState,
} from './use-workspace-trust-grant';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const untrusted: DaemonWorkspaceCapability = {
  id: 'ws-doc',
  cwd: '/work/doc',
  primary: false,
  trusted: false,
};
const trusted: DaemonWorkspaceCapability = { ...untrusted, trusted: true };

let root: Root;
let container: HTMLDivElement;
let latest: WorkspaceTrustGrantState | undefined;

function Probe({ options }: { options: UseWorkspaceTrustGrantOptions }) {
  latest = useWorkspaceTrustGrant(options);
  return null;
}

async function render(options: UseWorkspaceTrustGrantOptions): Promise<void> {
  await act(async () => {
    root.render(<Probe options={options} />);
  });
}

function harness(overrides: Partial<UseWorkspaceTrustGrantOptions> = {}) {
  const grantWorkspaceTrust = vi.fn().mockResolvedValue(undefined);
  const workspaceByCwd = vi.fn(() => ({ grantWorkspaceTrust }));
  const options: UseWorkspaceTrustGrantOptions = {
    client: { workspaceByCwd } as unknown as DaemonClient,
    workspaces: [untrusted],
    refreshCapabilities: vi.fn().mockResolvedValue(undefined),
    onError: vi.fn(),
    errorMessage: 'trust failed',
    ...overrides,
  };
  return { options, grantWorkspaceTrust, workspaceByCwd };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('useWorkspaceTrustGrant', () => {
  it('grants the clicked workspace and stays pending until the rebuild reports trusted', async () => {
    const { options, grantWorkspaceTrust, workspaceByCwd } = harness();
    await render(options);

    act(() => latest!.grantTrust(untrusted));
    expect(latest?.trustPendingCwd).toBe('/work/doc');
    await act(async () => {
      await Promise.resolve();
    });

    expect(workspaceByCwd).toHaveBeenCalledWith('/work/doc');
    expect(grantWorkspaceTrust).toHaveBeenCalledTimes(1);
    expect(options.refreshCapabilities).toHaveBeenCalledTimes(1);
    // The grant is written, but the runtime rebuild has not landed yet.
    expect(latest?.trustPendingCwd).toBe('/work/doc');

    await render({ ...options, workspaces: [trusted] });
    expect(latest?.trustPendingCwd).toBeNull();
  });

  it('reports a rejected grant and returns the control to a clickable state', async () => {
    const { options, grantWorkspaceTrust } = harness();
    const failure = new Error('daemon refused');
    grantWorkspaceTrust.mockRejectedValueOnce(failure);
    await render(options);

    await act(async () => {
      latest!.grantTrust(untrusted);
      await Promise.resolve();
    });

    expect(options.onError).toHaveBeenCalledWith(failure, 'trust failed');
    expect(latest?.trustPendingCwd).toBeNull();
    expect(options.refreshCapabilities).not.toHaveBeenCalled();
  });

  it('ignores a second grant while one is still pending', async () => {
    const { options, grantWorkspaceTrust } = harness();
    let settle: () => void = () => {};
    grantWorkspaceTrust.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    await render(options);

    act(() => latest!.grantTrust(untrusted));
    act(() =>
      latest!.grantTrust({ ...untrusted, id: 'ws-other', cwd: '/work/other' }),
    );

    expect(grantWorkspaceTrust).toHaveBeenCalledTimes(1);
    expect(latest?.trustPendingCwd).toBe('/work/doc');

    await act(async () => {
      settle();
      await Promise.resolve();
    });
  });

  it('polls while the rebuild is outstanding and gives up at the deadline', async () => {
    vi.useFakeTimers();
    const { options } = harness();
    await render(options);

    await act(async () => {
      latest!.grantTrust(untrusted);
      await Promise.resolve();
    });
    const refresh = vi.mocked(options.refreshCapabilities!);
    refresh.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(latest?.trustPendingCwd).toBe('/work/doc');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    // A refresh that never lands must still hand the action back at the
    // deadline, rather than leaving the row disabled forever.
    expect(latest?.trustPendingCwd).toBeNull();

    refresh.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('still releases at the deadline when every poll refresh rejects', async () => {
    vi.useFakeTimers();
    const { options } = harness({
      // A fresh rejection per call, so each poll tick really does reject.
      refreshCapabilities: vi.fn(() =>
        Promise.reject(new Error('capabilities refresh failed')),
      ),
    });
    await render(options);

    await act(async () => {
      latest!.grantTrust(untrusted);
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // A failed reconcile must not strand the row: the deadline still fires.
    expect(latest?.trustPendingCwd).toBeNull();
  });

  it('handles the rejection of the poll refresh, not just the post-grant one', async () => {
    vi.useFakeTimers();
    // This worker never delivers `unhandledRejection` (measured with and
    // without fake timers), so the observable contract is that each refresh
    // gets a rejection handler attached.
    const handlers: Array<ReturnType<typeof vi.fn>> = [];
    const { options } = harness({
      refreshCapabilities: vi.fn(() => {
        const handler = vi.fn();
        handlers.push(handler);
        return { catch: handler } as unknown as Promise<unknown>;
      }),
    });
    await render(options);

    await act(async () => {
      latest!.grantTrust(untrusted);
      await Promise.resolve();
    });
    expect(handlers).toHaveLength(1);
    expect(handlers[0]).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(handlers).toHaveLength(2);
    expect(handlers[1]).toHaveBeenCalledTimes(1);
  });
});
