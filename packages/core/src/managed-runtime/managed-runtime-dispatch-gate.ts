/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ManagedSessionConflictError } from './managed-session-authority.js';
import type { ManagedSessionKey } from './managed-session-records.js';

export type ManagedRuntimeDispatchState = 'dispatch' | 'handed_off' | 'settled';

/**
 * Settled entries are a fast in-process tripwire only. Inside an open turn the
 * checkpoint's `tools.items` refuses a repeat dispatch; across a turn boundary
 * `tools` is reset to null, so for an older id this window is the only
 * in-process refusal and nothing durable re-refuses it. Its size is therefore
 * a replay-protection decision as well as a memory one.
 */
export const MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT = 1024;

/**
 * Process-local coordinator gate: one executionCallId is dispatched at most
 * once while its state is retained; settled states past
 * MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT are pruned, so the in-process
 * refusal is a bounded window, not a durable fence. Handoff keeps the
 * original invocation after Harness detach; settle is the only legal end.
 * Worker loss across process restart is recovery blocked, not a second
 * dispatch.
 */
export class ManagedRuntimeDispatchGate {
  private readonly states = new Map<string, ManagedRuntimeDispatchState>();

  claim(executionCallId: string): void {
    const current = this.states.get(executionCallId);
    if (current !== undefined) {
      throw new ManagedSessionConflictError(
        'runtime invocation already dispatched.',
      );
    }
    this.states.set(executionCallId, 'dispatch');
  }

  unclaim(executionCallId: string): void {
    if (this.states.get(executionCallId) === 'dispatch') {
      this.states.delete(executionCallId);
    }
  }

  handoff(executionCallId: string): void {
    const current = this.states.get(executionCallId);
    if (current === 'handed_off' || current === 'settled') return;
    this.states.set(executionCallId, 'handed_off');
  }

  settle(executionCallId: string): void {
    const current = this.states.get(executionCallId);
    if (current === 'settled') return;
    // Move the id to the tail: the window is pruned by map order, and an id
    // claimed early but settled late must not be the first one evicted.
    this.states.delete(executionCallId);
    this.states.set(executionCallId, 'settled');
    this.pruneSettled();
  }

  /**
   * In-flight and handed-off entries are never dropped: they are what refuses
   * a second dispatch before the durable checkpoint records the call. Only
   * settled ones are pruned, oldest first.
   */
  private pruneSettled(): void {
    if (this.states.size <= MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT) return;
    for (const [executionCallId, state] of this.states) {
      if (this.states.size <= MANAGED_RUNTIME_DISPATCH_SETTLED_LIMIT) return;
      if (state === 'settled') this.states.delete(executionCallId);
    }
  }

  state(executionCallId: string): ManagedRuntimeDispatchState | undefined {
    return this.states.get(executionCallId);
  }

  isHandedOff(executionCallId: string): boolean {
    return this.states.get(executionCallId) === 'handed_off';
  }
}

const gates = new Map<string, ManagedRuntimeDispatchGate>();

function gateKey(sessionKey: ManagedSessionKey): string {
  return `${sessionKey.tenantId}\0${sessionKey.workspaceId}\0${sessionKey.sessionId}`;
}

export function managedRuntimeDispatchGate(
  sessionKey: ManagedSessionKey,
): ManagedRuntimeDispatchGate {
  const id = gateKey(sessionKey);
  const existing = gates.get(id);
  if (existing !== undefined) return existing;
  const created = new ManagedRuntimeDispatchGate();
  gates.set(id, created);
  return created;
}

export function resetManagedRuntimeDispatchGatesForTest(): void {
  gates.clear();
}
