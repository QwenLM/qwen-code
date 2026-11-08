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
  readonly message: string;
}

export type ChannelRestoreFailureInput = ChannelRestoreFailure;

export interface CreateChannelRestoreFailuresOptions {
  /**
   * Whether a record no longer stands. Consulted on every read rather than
   * on the events that could retire a record, because those events are not
   * all observable here: a later restore by another workspace can commit the
   * name, and a workspace can be disposed while its own restore is still on
   * the channel-control lane. A predicate over current state answers both
   * without an event to hook, and cannot leave a stale record behind.
   *
   * Reads filter; they never delete. The predicate reads live state that can
   * dip — a workspace is briefly absent from the registry while its runtime
   * is replaced — and deleting on a dip would destroy a failure that is still
   * true, which is the defect this whole surface exists to prevent. Records
   * are bounded by the channels a daemon has tried to restore, so keeping a
   * retired one costs nothing worth that risk.
   */
  readonly isStale?: (failure: ChannelRestoreFailure) => boolean;
}

/**
 * Restore failures the daemon still stands behind, keyed by workspace and
 * channel. In memory only: a restarted daemon restores again and records what
 * that attempt did. A record is dropped when it goes stale (see `isStale`) or
 * when an operator acts on the channel or on the whole selection.
 */
export interface ChannelRestoreFailures {
  record(failures: readonly ChannelRestoreFailureInput[]): void;
  get(workspaceCwd: string, channel: string): ChannelRestoreFailure | undefined;
  list(): ChannelRestoreFailure[];
  clear(workspaceCwd: string, channel: string): void;
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
  options: CreateChannelRestoreFailuresOptions = {},
): ChannelRestoreFailures {
  const byWorkspace = new Map<string, Map<string, ChannelRestoreFailure>>();
  const isStale = options.isStale ?? (() => false);
  return {
    record(failures) {
      for (const failure of failures) {
        let channels = byWorkspace.get(failure.workspaceCwd);
        if (!channels) {
          channels = new Map();
          byWorkspace.set(failure.workspaceCwd, channels);
        }
        channels.set(failure.channel, {
          workspaceCwd: failure.workspaceCwd,
          channel: failure.channel,
          message: restoreFailureMessage(failure.message),
        });
      }
    },
    get(workspaceCwd, channel) {
      const failure = byWorkspace.get(workspaceCwd)?.get(channel);
      return failure && !isStale(failure) ? failure : undefined;
    },
    list() {
      return [...byWorkspace.values()]
        .flatMap((channels) => [...channels.values()])
        .filter((failure) => !isStale(failure));
    },
    clear(workspaceCwd, channel) {
      const channels = byWorkspace.get(workspaceCwd);
      if (!channels) return;
      channels.delete(channel);
      if (channels.size === 0) byWorkspace.delete(workspaceCwd);
    },
    clearAll() {
      byWorkspace.clear();
    },
  };
}
