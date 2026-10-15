/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ManagedBackgroundShellRegistry,
  type BackgroundShellReceipt,
} from './managed-background-shell-registry.js';
import type { ManagedChildRunProcess } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';
import type {
  ManagedShellCapturePublisher,
  ManagedShellCaptureSink,
} from './managed-runtime-tool-executor.js';
import type { ToolResultExpectedIdentity } from '@qwen-code/qwen-code-core/managed-runtime/managed-tool-result-store.js';

// H3 of #12827: the managed-runtime worker's registry of supervised
// Monitor watches. Monitor maintenance is physically identical to the
// background Shell's — session holds, supervisor evidence ends, finished
// receipts retained until the worker ends, ordered drains — so this class
// delegates to the Shell registry rather than copying its machinery, while
// keeping the Monitor keyspace and quota bucket entirely its own.

export class ManagedMonitorRegistry {
  private readonly physical: ManagedBackgroundShellRegistry;

  constructor(eofGraceMs?: number) {
    this.physical = new ManagedBackgroundShellRegistry(eofGraceMs);
  }

  get size(): number {
    return this.physical.size;
  }

  /** Read-only: a watching entry holds its Session's Runtime. */
  hasHolds(sessionId: string): boolean {
    return this.physical.hasHolds(sessionId);
  }

  countBySession(sessionId: string): number {
    return this.physical.countBySession(sessionId);
  }

  /** Registers a watching unit started by the admission flow. */
  register(params: {
    unitName: string;
    sessionId: string;
    process: ManagedChildRunProcess;
    sink: ManagedShellCaptureSink;
    publisher: ManagedShellCapturePublisher;
    identity: ToolResultExpectedIdentity;
  }): Promise<BackgroundShellReceipt> {
    return this.physical.register(params);
  }

  /** The live registration of one unit — or nothing if it already ended. */
  describe(unitName: string): { readonly sessionId: string } | undefined {
    return this.physical.describe(unitName);
  }

  /** The retained receipt of a watch that ended on this worker. */
  describeFinished(unitName: string):
    | {
        readonly sessionId: string;
        readonly receipt: BackgroundShellReceipt;
      }
    | undefined {
    return this.physical.describeFinished(unitName);
  }

  /**
   * Stops one watch with the same supervisor evidence rules as a Shell:
   * an end it cannot prove keeps every hold.
   */
  async terminate(
    unitName: string,
    graceMs: number,
  ): Promise<BackgroundShellReceipt | undefined> {
    return this.physical.terminate(unitName, graceMs);
  }

  /** Ordered close of one Session's watches with the Shell-side bounds. */
  async stopSession(sessionId: string, graceMs: number): Promise<void> {
    await this.physical.stopSession(sessionId, graceMs);
  }

  /** The worker-end drain: stop every watch everywhere, like the Shells. */
  async stopAll(graceMs: number): Promise<void> {
    await this.physical.stopAll(graceMs);
  }
}
