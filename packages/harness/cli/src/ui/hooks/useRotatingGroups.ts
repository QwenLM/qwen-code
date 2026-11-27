/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';

/** Default interval between rotations of the info line, in milliseconds. */
export const ROTATING_GROUPS_INTERVAL_MS = 4000;

export interface UseRotatingGroupsOptions {
  /** Milliseconds between rotations. Defaults to {@link ROTATING_GROUPS_INTERVAL_MS}. */
  intervalMs?: number;
  /** When false, rotation is frozen on index 0. Defaults to true. */
  enabled?: boolean;
  /** When true, rotation is frozen on the current index. Defaults to false. */
  paused?: boolean;
}

/**
 * Cycles an index sequentially over `0..groupCount-1` on a fixed interval.
 *
 * The caller is expected to pass the count of already-filtered (non-empty)
 * groups. The returned index is always kept in range, so it is safe to use
 * directly to read from the group array even while the count changes.
 *
 * Rotation is skipped (no timer) when disabled, paused, when there is at most
 * one group, or when the interval is non-positive.
 */
export function useRotatingGroups(
  groupCount: number,
  options?: UseRotatingGroupsOptions,
): number {
  const {
    intervalMs = ROTATING_GROUPS_INTERVAL_MS,
    enabled = true,
    paused = false,
  } =
    options ?? {};
  const [index, setIndex] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Keep the index in range when the group count shrinks, avoiding a transient
  // out-of-range read / blank frame.
  useEffect(() => {
    setIndex((prev) => (groupCount === 0 ? 0 : prev % groupCount));
  }, [groupCount]);

  useEffect(() => {
    const clear = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
    clear();

    if (!enabled || paused || groupCount <= 1 || intervalMs <= 0) {
      // Disabling freezes on the first group. Pausing keeps the current index.
      if (!enabled) setIndex(0);
      return clear;
    }

    intervalRef.current = setInterval(() => {
      setIndex((prev) => (prev + 1) % groupCount);
    }, intervalMs);

    return clear;
  }, [groupCount, intervalMs, enabled, paused]);

  return groupCount === 0 ? 0 : index % groupCount;
}

/**
 * Number of intermediate frames rendered for each fade direction. Each frame is
 * a `setIntensity` call, so the consuming component re-renders ~FADE_STEPS times
 * per direction (every `fadeMs / FADE_STEPS` ms, ≈33ms at the defaults). This
 * high-frequency re-render is intentional and strictly bounded to the brief
 * fade window (~2·fadeMs per swap); the hook is fully idle between swaps. Keep
 * this small — raising it multiplies render churn during transitions.
 */
const FADE_STEPS = 6;

/** Default duration of a single fade direction (out or in), in milliseconds. */
export const ROTATING_GROUPS_FADE_MS = 200;

export interface UseCrossfadeRotationOptions extends UseRotatingGroupsOptions {
  /**
   * When true (default), the index change is wrapped in a fade-out → swap →
   * fade-in transition and {@link UseCrossfadeRotationResult.intensity} ramps
   * between 0 and 1. When false the swap is instant and intensity stays at 1.
   */
  animate?: boolean;
  /** Duration of each fade direction. Defaults to {@link ROTATING_GROUPS_FADE_MS}. */
  fadeMs?: number;
  /**
   * Per-item dwell time (ms), one entry per group. When provided AND its length
   * matches `groupCount`, each group is held for its own duration; otherwise
   * every group uses the single `intervalMs` (fully backward compatible). Pass a
   * memoized array so the effect does not re-run on every render.
   */
  itemDurations?: number[];
}

export interface UseCrossfadeRotationResult {
  /** Currently displayed group index, always kept in range. */
  index: number;
  /** Visibility in [0, 1]: 1 = fully shown, 0 = faded out (swap point). */
  intensity: number;
}

/**
 * Like {@link useRotatingGroups} but cross-fades between groups instead of
 * swapping instantly: the current group fades out, the index advances at the
 * darkest point, then the new group fades in. Re-renders only happen during the
 * short transition window; the rest of the interval is idle.
 *
 * The caller maps `intensity` to a color. Disable the animation (instant swap)
 * by passing `animate: false` — typically under a screen reader.
 */
export function useCrossfadeRotation(
  groupCount: number,
  options?: UseCrossfadeRotationOptions,
): UseCrossfadeRotationResult {
  const {
    intervalMs = ROTATING_GROUPS_INTERVAL_MS,
    enabled = true,
    paused = false,
    animate = true,
    fadeMs = ROTATING_GROUPS_FADE_MS,
    itemDurations,
  } = options ?? {};
  const [index, setIndex] = useState(0);
  const [intensity, setIntensity] = useState(1);
  // Live index for the timing closure, so per-item hold reads the current group
  // without re-running the rotation effect on every index change.
  const indexRef = useRef(0);

  // Serialize itemDurations for a stable effect dependency.
  const durationsKey =
    itemDurations && itemDurations.length === groupCount
      ? itemDurations.join(',')
      : '';

  // Keep the index in range when the group count shrinks.
  useEffect(() => {
    setIndex((prev) => {
      const next = groupCount === 0 ? 0 : prev % groupCount;
      indexRef.current = next;
      return next;
    });
  }, [groupCount]);

  useEffect(() => {
    setIntensity(1);
    if (!enabled || paused || groupCount <= 1 || intervalMs <= 0) {
      // Disabling rotation freezes on the first group, per the hook contract —
      // reset so a runtime toggle doesn't leave us parked on a later item.
      // Pausing is different: it freezes on the current group.
      if (!enabled) {
        setIndex(0);
        indexRef.current = 0;
      }
      return;
    }

    // The cycle is a strictly sequential chain (hold → fade-out frames → swap →
    // fade-in frames → hold …), so at most ONE timer is ever pending. A single
    // handle therefore suffices — no Set bookkeeping needed. The `cancelled`
    // guard lives in one place (here, after the timer fires but before the
    // callback runs): a timer that fired just as cleanup ran still no-ops, so
    // there is never a setIntensity after unmount nor a stray extra frame.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = (fn: () => void, ms: number) => {
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        fn();
      }, ms);
    };

    const willAnimate = animate && fadeMs > 0;
    const stepMs = willAnimate ? fadeMs / FADE_STEPS : 0;
    // Dwell time of the group currently shown — per-item when itemDurations
    // matches groupCount, else the single intervalMs.
    const usePerItem = !!itemDurations && itemDurations.length === groupCount;
    const durationFor = (i: number): number => {
      if (usePerItem && itemDurations) {
        const d = itemDurations[i];
        if (typeof d === 'number' && d > 0) return d;
      }
      return intervalMs;
    };
    const holdFor = (i: number): number =>
      Math.max(0, durationFor(i) - (willAnimate ? 2 * fadeMs : 0));
    const advance = () =>
      setIndex((prev) => {
        const next = (prev + 1) % groupCount;
        indexRef.current = next;
        return next;
      });

    // `runCycle` and the fade `tick`s only ever re-enter via `later`, whose
    // single cancelled-guard covers them — no per-callback guard needed.
    const runCycle = () => {
      if (!willAnimate) {
        later(() => {
          advance();
          runCycle();
        }, durationFor(indexRef.current));
        return;
      }
      later(fadeOut, holdFor(indexRef.current));
    };

    const fadeOut = () => {
      let step = 0;
      const tick = () => {
        step += 1;
        setIntensity(Math.max(0, 1 - step / FADE_STEPS));
        if (step < FADE_STEPS) {
          later(tick, stepMs);
        } else {
          advance();
          fadeIn();
        }
      };
      later(tick, stepMs);
    };

    const fadeIn = () => {
      let step = 0;
      const tick = () => {
        step += 1;
        setIntensity(Math.min(1, step / FADE_STEPS));
        if (step < FADE_STEPS) {
          later(tick, stepMs);
        } else {
          setIntensity(1);
          runCycle();
        }
      };
      later(tick, stepMs);
    };

    runCycle();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // itemDurations is intentionally tracked via durationsKey (serialized) to
    // avoid re-running on a new-but-equal array identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupCount, intervalMs, enabled, paused, animate, fadeMs, durationsKey]);

  return { index: groupCount === 0 ? 0 : index % groupCount, intensity };
}
