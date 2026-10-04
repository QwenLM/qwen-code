/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedChildRunProcess } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-run-supervisor.js';

// H3 of #12827: the managed-runtime worker's registry of supervised
// Monitor watches, mirroring the background Shell registry's evidence
// rules: a live entry holds its Session's Runtime, an end is answered
// only with the supervisor's own evidence, and a proven end's receipt
// stays answerable until the worker ends so maintainers can still learn
// the watch exited. Registration itself arrives with the Monitor start
// admission (the model-call flow that owns its quota); this registry
// guarantees holds, evidence and an ordered drain only.

export interface MonitorReceipt {
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
}

interface Entry {
  readonly sessionId: string;
  readonly process: ManagedChildRunProcess;
}

export class ManagedMonitorRegistry {
  private readonly entries = new Map<string, Entry>();
  // Same retention rule as the Shell side (H7): a repeated exited answer
  // is idempotent, so nothing is consumed on read.
  private readonly finished = new Map<
    string,
    { readonly sessionId: string; readonly receipt: MonitorReceipt }
  >();

  get size(): number {
    return this.entries.size;
  }

  /** Read-only: a watching entry holds its Session's Runtime. */
  hasHolds(sessionId: string): boolean {
    return this.countBySession(sessionId) > 0;
  }

  countBySession(sessionId: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.sessionId === sessionId) count++;
    }
    return count;
  }

  /** Registers a watching unit started by the admission flow. */
  register(params: {
    unitName: string;
    sessionId: string;
    process: ManagedChildRunProcess;
  }): void {
    if (this.entries.has(params.unitName))
      throw new Error(`Monitor unit ${params.unitName} is already registered.`);
    this.entries.set(params.unitName, {
      sessionId: params.sessionId,
      process: params.process,
    });
  }

  /** The live registration of one unit — or nothing if it already ended. */
  describe(unitName: string): { readonly sessionId: string } | undefined {
    const entry = this.entries.get(unitName);
    if (entry === undefined) return undefined;
    const evidence = entry.process.evidence;
    if (entry.process.exited && evidence !== null) {
      this.entries.delete(unitName);
      this.finished.set(unitName, {
        sessionId: entry.sessionId,
        receipt: evidence,
      });
      return undefined;
    }
    return { sessionId: entry.sessionId };
  }

  /** The retained receipt of a watch that ended on this worker. */
  describeFinished(
    unitName: string,
  ):
    | { readonly sessionId: string; readonly receipt: MonitorReceipt }
    | undefined {
    const live = this.entries.get(unitName);
    if (live !== undefined) {
      // Let the live entry surface its own end first.
      this.describe(unitName);
    }
    return this.finished.get(unitName);
  }

  /**
   * Stops one watch with the same supervisor evidence rules as a Shell:
   * an end it cannot prove answers `null` and keeps every hold, while an
   * unregistered unit is simply absent.
   */
  async terminate(
    unitName: string,
    graceMs: number,
  ): Promise<MonitorReceipt | null | undefined> {
    const entry = this.entries.get(unitName);
    if (entry === undefined) return undefined;
    const evidence = await entry.process.terminate(graceMs);
    if (evidence === null) return null;
    this.entries.delete(unitName);
    this.finished.set(unitName, {
      sessionId: entry.sessionId,
      receipt: evidence,
    });
    return evidence;
  }

  /** Ordered close of one Session's watches with the Shell-side bounds. */
  async stopSession(sessionId: string, graceMs: number): Promise<void> {
    await Promise.allSettled(
      [...this.entries.entries()]
        .filter(([, entry]) => entry.sessionId === sessionId)
        .map(async ([unitName]) => {
          await this.terminate(unitName, graceMs);
        }),
    );
  }
}
