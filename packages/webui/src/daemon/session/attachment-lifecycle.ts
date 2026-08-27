/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionClient } from '@qwen-code/sdk/daemon';
import type { PendingSessionLoad } from './types.js';

interface StartPendingSessionLoad {
  sessionId: string;
  mode: PendingSessionLoad['mode'];
  watchdogTimeoutMs?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  replaySource?: PendingSessionLoad['replaySource'];
  onTimeout: () => unknown;
}

export class SessionAttachmentLifecycle {
  private loadGeneration = 0;
  private currentLoad: PendingSessionLoad | undefined;
  private manuallyCleared = false;
  private cleanupDetachExemption:
    | { session: DaemonSessionClient; load: PendingSessionLoad | undefined }
    | undefined;

  get pendingLoad(): PendingSessionLoad | undefined {
    return this.currentLoad;
  }

  get generation(): number {
    return this.loadGeneration;
  }

  get isManuallyCleared(): boolean {
    return this.manuallyCleared;
  }

  startPendingLoad({
    sessionId,
    mode,
    watchdogTimeoutMs,
    requestTimeoutMs,
    signal,
    replaySource,
    onTimeout,
  }: StartPendingSessionLoad): Promise<void> {
    const id = ++this.loadGeneration;
    this.cancelPendingLoad(
      new DOMException(
        `Session ${mode} superseded by a newer request`,
        'AbortError',
      ),
    );

    return new Promise<void>((resolve, reject) => {
      const load: PendingSessionLoad = {
        id,
        sessionId,
        mode,
        resolve,
        reject,
        ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
        ...(signal ? { signal } : {}),
        ...(replaySource ? { replaySource } : {}),
      };
      if (watchdogTimeoutMs !== undefined) {
        load.timeout = setTimeout(() => {
          if (!this.releasePendingLoad(load)) return;
          let timeoutError: unknown;
          try {
            timeoutError = onTimeout();
          } catch (error) {
            timeoutError = error;
          }
          reject(timeoutError);
        }, watchdogTimeoutMs);
      }
      this.currentLoad = load;
    });
  }

  isCurrentLoad(load: PendingSessionLoad | undefined): boolean {
    return load !== undefined && this.currentLoad === load;
  }

  resolvePendingLoad(load: PendingSessionLoad): boolean {
    if (!this.releasePendingLoad(load)) return false;
    load.resolve();
    return true;
  }

  rejectPendingLoad(load: PendingSessionLoad, error: unknown): boolean {
    if (!this.releasePendingLoad(load)) return false;
    this.releaseCleanupDetachExemptionForSession(load.sessionId);
    load.reject(error);
    return true;
  }

  cancelPendingLoad(error: unknown): boolean {
    const load = this.currentLoad;
    return load ? this.rejectPendingLoad(load, error) : false;
  }

  releasePendingLoad(load: PendingSessionLoad): boolean {
    if (this.currentLoad !== load) return false;
    this.currentLoad = undefined;
    if (load.timeout !== undefined) clearTimeout(load.timeout);
    return true;
  }

  markManuallyCleared(): void {
    this.manuallyCleared = true;
  }

  allowAutomaticAttachment(): void {
    this.manuallyCleared = false;
  }

  preserveCleanupDetach(
    session: DaemonSessionClient,
    load?: PendingSessionLoad,
  ): void {
    this.cleanupDetachExemption = { session, load };
  }

  isCleanupDetachPreserved(session: DaemonSessionClient | undefined): boolean {
    return (
      session !== undefined && this.cleanupDetachExemption?.session === session
    );
  }

  releaseCleanupDetachExemption(
    session?: DaemonSessionClient | undefined,
    load?: PendingSessionLoad,
  ): void {
    const exemption = this.cleanupDetachExemption;
    if (exemption === undefined) return;
    if (session !== undefined && exemption.session !== session) return;
    // Two overlapping reloads of the same session share the session object,
    // so identity alone cannot tell a switch's own exemption from the one a
    // superseding switch re-preserved. A release tied to a superseded load
    // must not clear the successor's exemption.
    if (
      load !== undefined &&
      exemption.load !== undefined &&
      exemption.load !== load
    ) {
      return;
    }
    this.cleanupDetachExemption = undefined;
  }

  releaseCleanupDetachExemptionForSession(sessionId: string): void {
    if (this.cleanupDetachExemption?.session.sessionId === sessionId) {
      this.cleanupDetachExemption = undefined;
    }
  }
}
