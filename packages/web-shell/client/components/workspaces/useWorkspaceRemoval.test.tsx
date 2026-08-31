// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import {
  useWorkspaceRemoval,
  type UseWorkspaceRemovalOptions,
  type WorkspaceRemovalController,
} from './useWorkspaceRemoval';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const workspace: DaemonWorkspaceCapability = {
  id: 'ws-api',
  cwd: '/tmp/api',
  primary: false,
  trusted: true,
  removable: true,
};

const activity = {
  sessions: 2,
  activePrompts: 1,
  pendingSessionStarts: 0,
  acpConnections: 1,
  memoryTasks: 0,
  channelWorkers: 0,
};

let root: Root;
let container: HTMLDivElement;
let latest: WorkspaceRemovalController | undefined;

function Probe({ options }: { options: UseWorkspaceRemovalOptions }) {
  latest = useWorkspaceRemoval(options);
  return null;
}

async function render(options: UseWorkspaceRemovalOptions): Promise<void> {
  await act(async () => {
    root.render(<Probe options={options} />);
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  latest = undefined;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function baseOptions(
  overrides: Partial<UseWorkspaceRemovalOptions> = {},
): UseWorkspaceRemovalOptions {
  return {
    removeWorkspace: vi.fn().mockResolvedValue({ removed: true }),
    onRemoved: vi.fn(),
    onError: vi.fn(),
    errorMessage: 'removal failed',
    ...overrides,
  };
}

describe('useWorkspaceRemoval', () => {
  it('removes the candidate and reconciles before clearing the dialog', async () => {
    const options = baseOptions();
    await render(options);
    act(() => latest!.request(workspace));
    expect(latest?.candidate).toEqual(workspace);
    await act(async () => {
      await latest!.confirm();
    });
    expect(options.removeWorkspace).toHaveBeenCalledWith('ws-api', {
      force: false,
    });
    expect(options.onRemoved).toHaveBeenCalledWith(workspace);
    expect(latest?.candidate).toBeNull();
  });

  it('keeps the dialog open until the caller finishes reconciling', async () => {
    let resolveReconcile: () => void = () => {};
    const options = baseOptions({
      onRemoved: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveReconcile = resolve;
          }),
      ),
    });
    await render(options);
    act(() => latest!.request(workspace));
    let confirmDone: Promise<void>;
    act(() => {
      confirmDone = latest!.confirm();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The daemon confirmed, but the caller is still reconciling (in the
    // panel this is a capabilities round-trip): the dialog state must not
    // clear yet — clearing first would close the dialog before a failed
    // or hung refresh settles, leaving a ghost row with nothing to retry.
    expect(options.onRemoved).toHaveBeenCalledWith(workspace);
    expect(latest?.candidate).toEqual(workspace);
    await act(async () => {
      resolveReconcile();
      await confirmDone!;
    });
    expect(latest?.candidate).toBeNull();
  });

  it('surfaces workspace_busy activity and retries with force', async () => {
    const removeWorkspace = vi
      .fn()
      .mockRejectedValueOnce(
        new DaemonHttpError(409, { code: 'workspace_busy', activity }, 'busy'),
      )
      .mockResolvedValueOnce({ removed: true });
    const options = baseOptions({ removeWorkspace });
    await render(options);
    act(() => latest!.request(workspace));
    await act(async () => {
      await latest!.confirm();
    });
    expect(latest?.activity).toEqual(activity);
    expect(latest?.candidate).toEqual(workspace);
    expect(options.onError).not.toHaveBeenCalled();
    await act(async () => {
      await latest!.confirm();
    });
    expect(removeWorkspace).toHaveBeenLastCalledWith('ws-api', {
      force: true,
    });
    expect(options.onRemoved).toHaveBeenCalledWith(workspace);
    expect(latest?.candidate).toBeNull();
  });

  it('treats workspace_mismatch as already removed', async () => {
    const removeWorkspace = vi
      .fn()
      .mockRejectedValue(
        new DaemonHttpError(400, { code: 'workspace_mismatch' }, 'gone'),
      );
    const options = baseOptions({ removeWorkspace });
    await render(options);
    act(() => latest!.request(workspace));
    await act(async () => {
      await latest!.confirm();
    });
    expect(options.onRemoved).toHaveBeenCalledWith(workspace);
    expect(options.onError).not.toHaveBeenCalled();
    expect(latest?.candidate).toBeNull();
  });

  it('refuses a forced confirm the caller blocks', async () => {
    const removeWorkspace = vi
      .fn()
      .mockRejectedValueOnce(
        new DaemonHttpError(409, { code: 'workspace_busy', activity }, 'busy'),
      );
    const options = baseOptions({
      removeWorkspace,
      blockForce: () => true,
    });
    await render(options);
    act(() => latest!.request(workspace));
    await act(async () => {
      await latest!.confirm();
    });
    expect(latest?.activity).toEqual(activity);
    await act(async () => {
      await latest!.confirm();
    });
    // The forced retry never reached the daemon.
    expect(removeWorkspace).toHaveBeenCalledTimes(1);
    expect(options.onRemoved).not.toHaveBeenCalled();
  });

  it('reports other errors through onError and keeps the dialog open', async () => {
    const removeWorkspace = vi
      .fn()
      .mockRejectedValue(new Error('network down'));
    const options = baseOptions({ removeWorkspace });
    await render(options);
    act(() => latest!.request(workspace));
    await act(async () => {
      await latest!.confirm();
    });
    expect(options.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'network down' }),
      'removal failed',
    );
    expect(latest?.candidate).toEqual(workspace);
    expect(latest?.submitting).toBe(false);
  });

  it('retries an in-progress removal until the daemon converges', async () => {
    vi.useFakeTimers();
    try {
      const removeWorkspace = vi
        .fn()
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        )
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_registration_in_progress' },
            'in progress',
          ),
        )
        .mockResolvedValueOnce({ removed: true });
      const options = baseOptions({ removeWorkspace });
      await render(options);
      act(() => latest!.request(workspace));
      let confirmDone: Promise<void>;
      act(() => {
        confirmDone = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(latest?.remoteInProgress).toBe(true);
      for (let tick = 0; tick < 2; tick += 1) {
        await act(async () => {
          vi.advanceTimersByTime(250);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      await act(async () => {
        await confirmDone!;
      });
      expect(removeWorkspace).toHaveBeenCalledTimes(3);
      expect(options.onRemoved).toHaveBeenCalledWith(workspace);
      expect(options.onError).not.toHaveBeenCalled();
      expect(latest?.candidate).toBeNull();
      expect(latest?.remoteInProgress).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces workspace_busy discovered mid-retry and stops retrying', async () => {
    vi.useFakeTimers();
    try {
      const removeWorkspace = vi
        .fn()
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        )
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_busy', activity },
            'busy',
          ),
        );
      const options = baseOptions({ removeWorkspace });
      await render(options);
      act(() => latest!.request(workspace));
      let confirmDone: Promise<void>;
      act(() => {
        confirmDone = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await confirmDone!;
      });
      expect(removeWorkspace).toHaveBeenCalledTimes(2);
      expect(latest?.remoteInProgress).toBe(false);
      expect(latest?.activity).toEqual(activity);
      expect(latest?.candidate).toEqual(workspace);
      expect(options.onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the in-progress retry loop when the dialog is dismissed', async () => {
    vi.useFakeTimers();
    try {
      const removeWorkspace = vi
        .fn()
        .mockRejectedValue(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        );
      const options = baseOptions({ removeWorkspace });
      await render(options);
      act(() => latest!.request(workspace));
      let confirmDone: Promise<void>;
      act(() => {
        confirmDone = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(latest?.remoteInProgress).toBe(true);
      act(() => latest!.dismiss());
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await confirmDone!;
      });
      // The dismissed loop never retried and reported nothing.
      expect(removeWorkspace).toHaveBeenCalledTimes(1);
      expect(options.onError).not.toHaveBeenCalled();
      expect(options.onRemoved).not.toHaveBeenCalled();
      expect(latest?.candidate).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports exhausted in-progress retries through onError', async () => {
    vi.useFakeTimers();
    try {
      const removeWorkspace = vi
        .fn()
        .mockRejectedValue(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        );
      const options = baseOptions({ removeWorkspace });
      await render(options);
      act(() => latest!.request(workspace));
      let confirmDone: Promise<void>;
      act(() => {
        confirmDone = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      for (let tick = 0; tick < 20; tick += 1) {
        await act(async () => {
          vi.advanceTimersByTime(250);
          await Promise.resolve();
          await Promise.resolve();
          await Promise.resolve();
        });
      }
      await act(async () => {
        await confirmDone!;
      });
      expect(removeWorkspace).toHaveBeenCalledTimes(21);
      expect(options.onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Workspace removal remained in progress after retries.',
        }),
        'removal failed',
      );
      expect(latest?.remoteInProgress).toBe(false);
      expect(latest?.candidate).toEqual(workspace);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a mid-retry workspace_mismatch as already removed', async () => {
    vi.useFakeTimers();
    try {
      const removeWorkspace = vi
        .fn()
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        )
        .mockRejectedValueOnce(
          new DaemonHttpError(400, { code: 'workspace_mismatch' }, 'gone'),
        );
      const options = baseOptions({ removeWorkspace });
      await render(options);
      act(() => latest!.request(workspace));
      let confirmDone: Promise<void>;
      act(() => {
        confirmDone = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await confirmDone!;
      });
      expect(options.onRemoved).toHaveBeenCalledWith(workspace);
      expect(options.onError).not.toHaveBeenCalled();
      expect(latest?.candidate).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards a mid-retry non-transient error instead of the synthetic message', async () => {
    vi.useFakeTimers();
    try {
      const boom = new DaemonHttpError(500, { code: 'internal' }, 'daemon 500');
      const removeWorkspace = vi
        .fn()
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        )
        .mockRejectedValueOnce(boom);
      const options = baseOptions({ removeWorkspace });
      await render(options);
      act(() => latest!.request(workspace));
      let confirmDone: Promise<void>;
      act(() => {
        confirmDone = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await confirmDone!;
      });
      // The real daemon error surfaces, not the exhausted-retries text.
      expect(options.onError).toHaveBeenCalledWith(boom, 'removal failed');
      expect(options.onRemoved).not.toHaveBeenCalled();
      expect(latest?.remoteInProgress).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a second removal retry after a dismissed in-progress loop', async () => {
    vi.useFakeTimers();
    try {
      const removeWorkspace = vi
        .fn()
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        )
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'workspace_removal_in_progress' },
            'in progress',
          ),
        )
        .mockResolvedValueOnce({ removed: true });
      const options = baseOptions({ removeWorkspace });
      await render(options);
      act(() => latest!.request(workspace));
      let firstConfirm: Promise<void>;
      act(() => {
        firstConfirm = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(latest?.remoteInProgress).toBe(true);
      act(() => latest!.dismiss());
      await act(async () => {
        vi.advanceTimersByTime(250);
        await firstConfirm!;
      });
      // request() must clear the stale dismiss so the next loop can run.
      const second = { ...workspace, id: 'ws-two', cwd: '/tmp/two' };
      act(() => latest!.request(second));
      let secondConfirm: Promise<void>;
      act(() => {
        secondConfirm = latest!.confirm();
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        await secondConfirm!;
      });
      expect(options.onRemoved).toHaveBeenCalledWith(second);
      expect(options.onError).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears stale busy state when a new removal is requested', async () => {
    const removeWorkspace = vi
      .fn()
      .mockRejectedValueOnce(
        new DaemonHttpError(409, { code: 'workspace_busy', activity }, 'busy'),
      )
      .mockResolvedValueOnce({ removed: true });
    const options = baseOptions({ removeWorkspace });
    await render(options);
    act(() => latest!.request(workspace));
    await act(async () => {
      await latest!.confirm();
    });
    expect(latest?.activity).toEqual(activity);
    const second = { ...workspace, id: 'ws-two', cwd: '/tmp/two' };
    act(() => latest!.request(second));
    // The previous workspace's busy report must not leak into the new
    // dialog, and the first attempt must not inherit force.
    expect(latest?.activity).toBeNull();
    expect(latest?.remoteInProgress).toBe(false);
    await act(async () => {
      await latest!.confirm();
    });
    expect(removeWorkspace).toHaveBeenLastCalledWith('ws-two', {
      force: false,
    });
  });

  it('resets submitting after success so a second removal can run', async () => {
    const options = baseOptions();
    await render(options);
    act(() => latest!.request(workspace));
    await act(async () => {
      await latest!.confirm();
    });
    expect(latest?.submitting).toBe(false);
    const second = { ...workspace, id: 'ws-two', cwd: '/tmp/two' };
    act(() => latest!.request(second));
    await act(async () => {
      await latest!.confirm();
    });
    expect(options.removeWorkspace).toHaveBeenNthCalledWith(2, 'ws-two', {
      force: false,
    });
    expect(options.onRemoved).toHaveBeenLastCalledWith(second);
    expect(latest?.candidate).toBeNull();
  });

  it('ignores request() while a removal is submitting', async () => {
    let resolveRemove: (value: unknown) => void = () => {};
    const removeWorkspace = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRemove = resolve;
        }),
    );
    const options = baseOptions({ removeWorkspace });
    await render(options);
    act(() => latest!.request(workspace));
    let confirmDone: Promise<void>;
    act(() => {
      confirmDone = latest!.confirm();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest?.submitting).toBe(true);
    act(() =>
      latest!.request({ ...workspace, id: 'ws-other', cwd: '/tmp/other' }),
    );
    expect(latest?.candidate?.id).toBe('ws-api');
    await act(async () => {
      resolveRemove({ removed: true });
      await confirmDone!;
    });
    expect(options.onRemoved).toHaveBeenCalledWith(workspace);
  });
});
