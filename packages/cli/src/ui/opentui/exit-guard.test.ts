/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createExitGuard, exitGuardHint } from './exit-guard.js';

describe('createExitGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('first press arms, second press inside the window exits', () => {
    const guard = createExitGuard();
    expect(guard.press('ctrl-c')).toBe('armed');
    expect(guard.armedKey()).toBe('ctrl-c');
    vi.advanceTimersByTime(500);
    expect(guard.press('ctrl-c')).toBe('exit');
    expect(guard.armedKey()).toBeNull();
  });

  it('a press after the window expired arms again instead of exiting', () => {
    const onWindowExpired = vi.fn();
    const guard = createExitGuard({ onWindowExpired });
    expect(guard.press('ctrl-c')).toBe('armed');
    vi.advanceTimersByTime(1000);
    expect(onWindowExpired).toHaveBeenCalledWith('ctrl-c');
    expect(guard.armedKey()).toBeNull();
    expect(guard.press('ctrl-c')).toBe('armed');
  });

  it('ctrl-d arms with its own hint key and confirms on the same key', () => {
    const guard = createExitGuard();
    expect(guard.press('ctrl-d')).toBe('armed');
    expect(guard.armedKey()).toBe('ctrl-d');
    expect(guard.press('ctrl-d')).toBe('exit');
  });

  it('a different exit key re-arms instead of confirming (ink keeps per-key windows)', () => {
    const guard = createExitGuard();
    expect(guard.press('ctrl-d')).toBe('armed');
    // Ink: ctrlCPressedOnce / ctrlDPressedOnce are separate flags, and
    // handleExit fast-quits only on the pressed key's own flag.
    expect(guard.press('ctrl-c')).toBe('armed');
    expect(guard.armedKey()).toBe('ctrl-c');
    expect(guard.press('ctrl-c')).toBe('exit');
  });

  it('disarm cancels a pending confirmation', () => {
    const onWindowExpired = vi.fn();
    const guard = createExitGuard({ onWindowExpired });
    expect(guard.press('ctrl-c')).toBe('armed');
    guard.disarm();
    vi.advanceTimersByTime(5000);
    expect(onWindowExpired).not.toHaveBeenCalled();
    expect(guard.press('ctrl-c')).toBe('armed');
  });

  it('dispose stops the pending timer', () => {
    const onWindowExpired = vi.fn();
    const guard = createExitGuard({ onWindowExpired });
    guard.press('ctrl-c');
    guard.dispose();
    vi.advanceTimersByTime(5000);
    expect(onWindowExpired).not.toHaveBeenCalled();
  });

  it('honours a custom window length', () => {
    const guard = createExitGuard({ windowMs: 250 });
    guard.press('ctrl-c');
    vi.advanceTimersByTime(249);
    expect(guard.press('ctrl-c')).toBe('exit');
    guard.press('ctrl-c');
    vi.advanceTimersByTime(251);
    expect(guard.press('ctrl-c')).toBe('armed');
  });
});

describe('exitGuardHint', () => {
  it('matches the ink footer wording per key', () => {
    expect(exitGuardHint('ctrl-c')).toBe('Press Ctrl+C again to exit.');
    expect(exitGuardHint('ctrl-d')).toBe('Press Ctrl+D again to exit.');
  });
});
