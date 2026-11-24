/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-model health ledger ported from the Qoder preview `availability` module
 * (Option B capability port). It remembers, across requests within a session,
 * which models recently failed so the fallback chain can skip an exhausted
 * model instead of re-trying it on every request. Pure state machine: no I/O,
 * no zod, no external dependencies.
 */

export type ModelId = string;

type TerminalUnavailabilityReason = 'quota' | 'capacity';
export type TurnUnavailabilityReason = 'retry_once_per_turn';

export type UnavailabilityReason =
  | TerminalUnavailabilityReason
  | TurnUnavailabilityReason
  | 'unknown';

type HealthState =
  | { status: 'terminal'; reason: TerminalUnavailabilityReason }
  | {
      status: 'sticky_retry';
      reason: TurnUnavailabilityReason;
      consumed: boolean;
    };

export interface ModelAvailabilitySnapshot {
  available: boolean;
  reason?: UnavailabilityReason;
}

export class ModelAvailabilityService {
  private readonly health = new Map<ModelId, HealthState>();
  private lastTurnKey: string | undefined;

  /**
   * Turn-aware reset for hosts without an explicit turn-boundary hook: when the
   * turn key (main uses the user prompt id) changes, re-probe sticky models
   * once. Same-key calls are no-ops, so repeated requests within one turn keep
   * their consumed state.
   */
  beginTurn(turnKey: string) {
    if (this.lastTurnKey !== turnKey) {
      this.lastTurnKey = turnKey;
      this.resetTurn();
    }
  }

  markTerminal(model: ModelId, reason: TerminalUnavailabilityReason) {
    this.setState(model, {
      status: 'terminal',
      reason,
    });
  }

  markHealthy(model: ModelId) {
    this.clearState(model);
  }

  markRetryOncePerTurn(model: ModelId) {
    const currentState = this.health.get(model);
    // Do not override a terminal failure with a transient one.
    if (currentState?.status === 'terminal') {
      return;
    }

    // Only reset consumption if we are not already in the sticky_retry state.
    // This prevents infinite loops if the model fails repeatedly in the same
    // turn.
    let consumed = false;
    if (currentState?.status === 'sticky_retry') {
      consumed = currentState.consumed;
    }

    this.setState(model, {
      status: 'sticky_retry',
      reason: 'retry_once_per_turn',
      consumed,
    });
  }

  consumeStickyAttempt(model: ModelId) {
    const state = this.health.get(model);
    if (state?.status === 'sticky_retry') {
      this.setState(model, { ...state, consumed: true });
    }
  }

  snapshot(model: ModelId): ModelAvailabilitySnapshot {
    const state = this.health.get(model);

    if (!state) {
      return { available: true };
    }

    if (state.status === 'terminal') {
      return { available: false, reason: state.reason };
    }

    if (state.status === 'sticky_retry' && state.consumed) {
      return { available: false, reason: state.reason };
    }

    return { available: true };
  }

  resetTurn() {
    for (const [model, state] of this.health.entries()) {
      if (state.status === 'sticky_retry') {
        this.setState(model, { ...state, consumed: false });
      }
    }
  }

  private setState(model: ModelId, nextState: HealthState) {
    this.health.set(model, nextState);
  }

  private clearState(model: ModelId) {
    this.health.delete(model);
  }
}
