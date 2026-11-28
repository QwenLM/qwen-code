/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { useContext, useLayoutEffect, useRef } from 'react';
import AfterLayoutContext from '../components/AfterLayoutContext.js';

function isActEnvironment(): boolean {
  return (
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT === true
  );
}

/** Runs before children so a parent's measurement can feed their props. */
export const AFTER_LAYOUT_PRIORITY = {
  /** Container geometry that other consumers derive their props from. */
  container: 0,
  /** Per-item measurement that depends on container geometry. */
  items: 1,
  /** Diagnostics — must never influence what the others see. */
  diagnostics: 9,
} as const;

/**
 * Run `callback` once per frame, after yoga layout, for every frame in which
 * this component committed.
 *
 * Replaces the pattern of a dependency-less `useLayoutEffect` that reads
 * `yogaNode.getComputedHeight()`. That worked only because layout ran inside
 * the reconciler's commit; now layout runs at frame time, so a layout effect
 * would read the previous frame's geometry with no way to notice it changed.
 *
 * State set by the callback is flushed synchronously and, if it dirties the
 * tree, the frame lays out again — so a frame is still painted from converged
 * state, just once per frame instead of once per commit.
 *
 * Outside an Ink root (no registry in context) this falls back to running on
 * every commit, which is the pre-existing behavior.
 */
export function useAfterLayout(
  callback: () => void,
  priority: number = AFTER_LAYOUT_PRIORITY.container,
): void {
  const contextRegistry = useContext(AfterLayoutContext);
  // Under `act()`, React routes updates through the act queue instead of
  // flushing them synchronously, so Ink's settle loop cannot bring the tree to
  // a fixed point inside one frame — measurement-driven state would land a
  // frame late and tests would assert against a stale frame. In that
  // environment fall back to a per-commit layout effect, which is exactly the
  // behavior this hook replaced. Test mode also paints synchronously per
  // commit (see reconciler.ts), so layout is already fresh when it runs.
  const registry = isActEnvironment() ? null : contextRegistry;
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  // Stable identity so the registry can key on it across renders.
  const stableRef = useRef<() => void>(undefined);
  stableRef.current ??= () => callbackRef.current();
  const stable = stableRef.current;

  useLayoutEffect(() => {
    if (!registry) return undefined;
    return registry.register(stable, priority);
  }, [registry, stable, priority]);

  // No dependency array: every commit of this component arms the callback for
  // the next layout, mirroring the per-commit effect this replaces.
  useLayoutEffect(() => {
    if (registry) {
      registry.markPending(stable);
    } else {
      stable();
    }
  });
}
