/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ideContextStore } from '@qwen-code/qwen-code-core';
import {
  type DaemonTrustPolicySnapshot,
  readDaemonTrustPolicySnapshot,
} from './daemon-trust-policy.js';
import { onTrustedFoldersChanged } from './trustedFolders.js';

export type DaemonTrustPolicyChangeReason =
  | 'initial'
  | 'poll'
  | 'ide'
  | 'trusted_folders'
  | 'manual';

export interface DaemonTrustPolicyMonitor {
  start(): Promise<void>;
  requestReconcile(reason?: DaemonTrustPolicyChangeReason): Promise<void>;
  stop(): void;
}

export interface DaemonTrustPolicyMonitorOptions {
  readonly onSnapshot: (
    snapshot: DaemonTrustPolicySnapshot,
    reasons: ReadonlySet<DaemonTrustPolicyChangeReason>,
  ) => void | Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly pollIntervalMs?: number;
  readonly readSnapshot?: () => Promise<DaemonTrustPolicySnapshot>;
}

export function createDaemonTrustPolicyMonitor(
  options: DaemonTrustPolicyMonitorOptions,
): DaemonTrustPolicyMonitor {
  const readSnapshot = options.readSnapshot ?? readDaemonTrustPolicySnapshot;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const pendingReasons = new Set<DaemonTrustPolicyChangeReason>();
  let started = false;
  let stopped = false;
  let lastRevision: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribeIde: (() => void) | undefined;
  let unsubscribeTrustedFolders: (() => void) | undefined;
  let running: Promise<void> | undefined;

  const drain = async (): Promise<void> => {
    while (!stopped && pendingReasons.size > 0) {
      const reasons = new Set(pendingReasons);
      pendingReasons.clear();
      try {
        const snapshot = await readSnapshot();
        if (stopped) return;
        if (snapshot.revision !== lastRevision || reasons.has('manual')) {
          await options.onSnapshot(snapshot, reasons);
          lastRevision = snapshot.revision;
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  const requestReconcile = (
    reason: DaemonTrustPolicyChangeReason = 'manual',
  ): Promise<void> => {
    if (stopped) return Promise.resolve();
    pendingReasons.add(reason);
    if (!running) {
      running = drain().finally(() => {
        running = undefined;
        if (!stopped && pendingReasons.size > 0) {
          return requestReconcile();
        }
        return undefined;
      });
    }
    return running;
  };

  return {
    async start() {
      if (started) {
        await running;
        return;
      }
      started = true;
      unsubscribeIde = ideContextStore.subscribe(() => {
        void requestReconcile('ide');
      });
      unsubscribeTrustedFolders = onTrustedFoldersChanged(() => {
        void requestReconcile('trusted_folders');
      });
      timer = setInterval(() => {
        void requestReconcile('poll');
      }, pollIntervalMs);
      timer.unref?.();
      await requestReconcile('initial');
    },
    requestReconcile,
    stop() {
      if (stopped) return;
      stopped = true;
      pendingReasons.clear();
      if (timer) clearInterval(timer);
      unsubscribeIde?.();
      unsubscribeTrustedFolders?.();
    },
  };
}
