/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { ModelAvailabilityService } from './model-availability-service.js';

describe('ModelAvailabilityService', () => {
  let service: ModelAvailabilityService;
  const model = 'test-model';

  beforeEach(() => {
    service = new ModelAvailabilityService();
  });

  it('returns available snapshot when no state recorded', () => {
    expect(service.snapshot(model)).toEqual({ available: true });
  });

  it('tracks retry-once-per-turn failures', () => {
    service.markRetryOncePerTurn(model);
    expect(service.snapshot(model)).toEqual({ available: true });

    service.consumeStickyAttempt(model);
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'retry_once_per_turn',
    });

    service.resetTurn();
    expect(service.snapshot(model)).toEqual({ available: true });
  });

  it('tracks terminal failures', () => {
    service.markTerminal(model, 'quota');
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'quota',
    });
  });

  it('tracks a terminal capacity failure and upgrades a consumed sticky mark', () => {
    // markTerminal is retained ported API (its terminal/quota-marking caller is
    // a separate feature); pin both terminal reasons and that a terminal mark
    // upgrades an already-consumed sticky mark rather than being ignored.
    service.markRetryOncePerTurn(model);
    service.consumeStickyAttempt(model);
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'retry_once_per_turn',
    });

    service.markTerminal(model, 'capacity');
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'capacity',
    });

    // A turn boundary must not revive the terminal mark.
    service.resetTurn();
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'capacity',
    });
  });

  it('does not override terminal failure with sticky failure', () => {
    service.markTerminal(model, 'quota');
    service.markRetryOncePerTurn(model);
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'quota',
    });
  });

  it('preserves consumed state when marking retry-once-per-turn again', () => {
    service.markRetryOncePerTurn(model);
    service.consumeStickyAttempt(model);

    // It is currently consumed
    expect(service.snapshot(model).available).toBe(false);

    // Marking it again should not reset the consumed flag
    service.markRetryOncePerTurn(model);
    expect(service.snapshot(model).available).toBe(false);
  });

  it('clears consumed state when marked healthy', () => {
    service.markRetryOncePerTurn(model);
    service.consumeStickyAttempt(model);
    expect(service.snapshot(model).available).toBe(false);

    service.markHealthy(model);
    expect(service.snapshot(model).available).toBe(true);

    // If we mark it sticky again, it should be fresh (not consumed)
    service.markRetryOncePerTurn(model);
    expect(service.snapshot(model).available).toBe(true);
  });

  it('resetTurn resets consumed state for multiple sticky models', () => {
    const model2 = 'model-2';
    service.markRetryOncePerTurn(model);
    service.markRetryOncePerTurn(model2);

    service.consumeStickyAttempt(model);
    service.consumeStickyAttempt(model2);

    expect(service.snapshot(model).available).toBe(false);
    expect(service.snapshot(model2).available).toBe(false);

    service.resetTurn();

    expect(service.snapshot(model).available).toBe(true);
    expect(service.snapshot(model2).available).toBe(true);
  });

  it('resetTurn does not affect terminal models', () => {
    service.markTerminal(model, 'quota');
    service.resetTurn();
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'quota',
    });
  });

  it('beginTurn re-probes sticky models only when the turn key changes', () => {
    service.beginTurn('turn-1');
    service.markRetryOncePerTurn(model);
    service.consumeStickyAttempt(model);
    expect(service.snapshot(model).available).toBe(false);

    // Same turn: consumed state survives repeated requests.
    service.beginTurn('turn-1');
    expect(service.snapshot(model).available).toBe(false);

    // New turn: sticky model is re-probed once.
    service.beginTurn('turn-2');
    expect(service.snapshot(model).available).toBe(true);
  });

  it('beginTurn does not revive terminal models', () => {
    service.beginTurn('turn-1');
    service.markTerminal(model, 'quota');
    service.beginTurn('turn-2');
    expect(service.snapshot(model)).toEqual({
      available: false,
      reason: 'quota',
    });
  });
});
