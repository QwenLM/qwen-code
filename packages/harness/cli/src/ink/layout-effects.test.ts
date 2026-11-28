/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, it, expect, vi } from 'vitest';
import { createAfterLayoutRegistry } from './layout-effects.js';

describe('createAfterLayoutRegistry', () => {
  it('runs a registered callback once per arming', () => {
    const registry = createAfterLayoutRegistry();
    const callback = vi.fn();
    registry.register(callback, 0);

    // Registration arms it, so the first layout picks it up.
    registry.runPending();
    expect(callback).toHaveBeenCalledTimes(1);

    // Nothing committed since, so it must not run again.
    registry.runPending();
    expect(callback).toHaveBeenCalledTimes(1);

    registry.markPending(callback);
    registry.runPending();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('reports pending work so the settle loop knows to keep going', () => {
    const registry = createAfterLayoutRegistry();
    const callback = vi.fn();
    registry.register(callback, 0);

    expect(registry.hasPending()).toBe(true);
    registry.runPending();
    expect(registry.hasPending()).toBe(false);

    registry.markPending(callback);
    expect(registry.hasPending()).toBe(true);
  });

  it('runs lower priorities first regardless of registration order', () => {
    const registry = createAfterLayoutRegistry();
    const order: string[] = [];
    // Registered child-first, which is the order React runs layout effects in.
    registry.register(() => order.push('items'), 1);
    registry.register(() => order.push('diagnostics'), 9);
    registry.register(() => order.push('container'), 0);

    registry.runPending();
    expect(order).toEqual(['container', 'items', 'diagnostics']);
  });

  it('stops calling a callback after it unregisters', () => {
    const registry = createAfterLayoutRegistry();
    const callback = vi.fn();
    const unregister = registry.register(callback, 0);

    unregister();
    registry.runPending();
    expect(callback).not.toHaveBeenCalled();
    expect(registry.hasPending()).toBe(false);

    // markPending on a gone entry is a no-op, not a crash.
    registry.markPending(callback);
    expect(registry.hasPending()).toBe(false);
  });

  it('does not run callbacks armed by a callback in the same pass', () => {
    // Otherwise a callback that re-arms itself would spin forever inside one
    // pass instead of yielding to the settle loop's cap.
    const registry = createAfterLayoutRegistry();
    let runs = 0;
    const callback = () => {
      runs++;
      registry.markPending(callback);
    };
    registry.register(callback, 0);

    registry.runPending();
    expect(runs).toBe(1);
    expect(registry.hasPending()).toBe(true);
  });

  it('is inert when nothing is registered', () => {
    const registry = createAfterLayoutRegistry();
    expect(registry.hasPending()).toBe(false);
    expect(() => registry.runPending()).not.toThrow();
  });
});
