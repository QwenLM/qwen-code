/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { normalizeWorkerDiagnostic } from './channel-worker-diagnostics.js';

/**
 * A channel a workspace's `serve.channels` asked for that the daemon did not
 * bring up. Nothing else records it: a name that failed to restore never
 * joins the committed selection, so the worker snapshots and the management
 * list would otherwise report it as simply stopped.
 */
export interface ChannelRestoreFailure {
  readonly workspaceCwd: string;
  readonly channel: string;
  /** `boot` for the listen-time restore, `late` for a workspace registered after it. */
  readonly source: 'boot' | 'late';
  readonly code?: string;
  readonly message: string;
  readonly at: string;
}

export type ChannelRestoreFailureInput = Omit<ChannelRestoreFailure, 'at'>;

/**
 * Restore failures the daemon still stands behind, keyed by workspace and
 * channel. In memory only: a restarted daemon restores again and records what
 * that attempt did. An entry lasts until the channel is committed, an operator
 * acts on it, or its workspace leaves.
 */
export interface ChannelRestoreFailures {
  record(failures: readonly ChannelRestoreFailureInput[]): void;
  get(workspaceCwd: string, channel: string): ChannelRestoreFailure | undefined;
  list(): ChannelRestoreFailure[];
  clear(workspaceCwd: string, channel: string): void;
  clearWorkspace(workspaceCwd: string): void;
  clearAll(): void;
}

// The recorded text is served over HTTP, and an adapter's own error text can
// carry its tokens: redacted and bounded the way the daemon log renders it.
function restoreFailureMessage(message: string): string {
  return sanitizeLogText(
    redactLogCredentials(normalizeWorkerDiagnostic(message)),
    512,
  );
}

export function createChannelRestoreFailures(
  now: () => Date = () => new Date(),
): ChannelRestoreFailures {
  const byWorkspace = new Map<string, Map<string, ChannelRestoreFailure>>();
  return {
    record(failures) {
      const at = now().toISOString();
      for (const failure of failures) {
        let channels = byWorkspace.get(failure.workspaceCwd);
        if (!channels) {
          channels = new Map();
          byWorkspace.set(failure.workspaceCwd, channels);
        }
        channels.set(failure.channel, {
          workspaceCwd: failure.workspaceCwd,
          channel: failure.channel,
          source: failure.source,
          ...(failure.code ? { code: failure.code } : {}),
          message: restoreFailureMessage(failure.message),
          at,
        });
      }
    },
    get(workspaceCwd, channel) {
      return byWorkspace.get(workspaceCwd)?.get(channel);
    },
    list() {
      return [...byWorkspace.values()].flatMap((channels) => [
        ...channels.values(),
      ]);
    },
    clear(workspaceCwd, channel) {
      const channels = byWorkspace.get(workspaceCwd);
      if (!channels) return;
      channels.delete(channel);
      if (channels.size === 0) byWorkspace.delete(workspaceCwd);
    },
    clearWorkspace(workspaceCwd) {
      byWorkspace.delete(workspaceCwd);
    },
    clearAll() {
      byWorkspace.clear();
    },
  };
}
