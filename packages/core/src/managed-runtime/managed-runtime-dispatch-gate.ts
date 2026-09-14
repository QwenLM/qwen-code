/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ManagedSessionConflictError } from './managed-session-authority.js';
import type { ManagedSessionKey } from './managed-session-records.js';

export type ManagedRuntimeDispatchState = 'dispatch' | 'handed_off' | 'settled';

/**
 * Process-local coordinator gate: one executionCallId is dispatched at most
 * once. Handoff keeps the original invocation after Harness detach; settle
 * is the only legal end. Worker loss across process restart is recovery
 * blocked, not a second dispatch.
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
    this.states.set(executionCallId, 'settled');
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
