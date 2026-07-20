/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ideContextStore } from '@qwen-code/qwen-code-core';
import { createDaemonTrustPolicyMonitor } from './daemon-trust-policy-monitor.js';
import type { DaemonTrustPolicySnapshot } from './daemon-trust-policy.js';

function snapshot(revision: string): DaemonTrustPolicySnapshot {
  return {
    revision,
    folderTrustEnabled: true,
    ideTrust: undefined,
    trustedFolders: {},
  };
}

describe('daemon trust policy monitor', () => {
  afterEach(() => {
    vi.useRealTimers();
    ideContextStore.clear();
  });

  it('publishes only semantic changes', async () => {
    const readSnapshot = vi
      .fn<() => Promise<DaemonTrustPolicySnapshot>>()
      .mockResolvedValueOnce(snapshot('one'))
      .mockResolvedValueOnce(snapshot('one'))
      .mockResolvedValueOnce(snapshot('two'));
    const onSnapshot = vi.fn();
    const monitor = createDaemonTrustPolicyMonitor({
      readSnapshot,
      onSnapshot,
    });

    await monitor.start();
    await monitor.requestReconcile('poll');
    await monitor.requestReconcile('poll');

    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls[1]?.[0]).toMatchObject({ revision: 'two' });
    monitor.stop();
  });

  it('reacts immediately to IDE trust changes and stops cleanly', async () => {
    const readSnapshot = vi
      .fn<() => Promise<DaemonTrustPolicySnapshot>>()
      .mockResolvedValueOnce(snapshot('one'))
      .mockResolvedValueOnce(snapshot('two'));
    const onSnapshot = vi.fn();
    const monitor = createDaemonTrustPolicyMonitor({
      readSnapshot,
      onSnapshot,
      pollIntervalMs: 60_000,
    });

    await monitor.start();
    ideContextStore.set({ workspaceState: { isTrusted: false } });
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2));
    monitor.stop();
    ideContextStore.set({ workspaceState: { isTrusted: true } });
    await Promise.resolve();

    expect(readSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not publish a snapshot that finishes reading after stop', async () => {
    let releaseRead!: (value: DaemonTrustPolicySnapshot) => void;
    const pendingRead = new Promise<DaemonTrustPolicySnapshot>((resolve) => {
      releaseRead = resolve;
    });
    const readSnapshot = vi
      .fn<() => Promise<DaemonTrustPolicySnapshot>>()
      .mockResolvedValueOnce(snapshot('one'))
      .mockReturnValueOnce(pendingRead);
    const onSnapshot = vi.fn();
    const monitor = createDaemonTrustPolicyMonitor({
      readSnapshot,
      onSnapshot,
      pollIntervalMs: 60_000,
    });

    await monitor.start();
    const reconciling = monitor.requestReconcile('manual');
    await vi.waitFor(() => expect(readSnapshot).toHaveBeenCalledTimes(2));
    monitor.stop();
    releaseRead(snapshot('two'));
    await reconciling;

    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });
});
