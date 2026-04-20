/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { generateSessionRecap, type Config } from '@qwen-code/qwen-code-core';
import type { HistoryItemAwayRecap } from '../types.js';

const DEFAULT_AWAY_THRESHOLD_MINUTES = 5;

export interface UseAwaySummaryOptions {
  enabled: boolean;
  config: Config | null;
  isFocused: boolean;
  isIdle: boolean;
  setAwayRecapItem: (item: HistoryItemAwayRecap | null) => void;
  /**
   * Minutes the terminal must be blurred before an auto-recap fires on
   * the next focus-in. Falsy / non-positive values fall back to the
   * 5-minute default (matching Claude Code).
   */
  awayThresholdMinutes?: number;
}

/**
 * Generates and displays a 1-3 sentence "where you left off" recap when the
 * user returns to a terminal that has been blurred for ≥ AWAY_THRESHOLD_MS.
 *
 * Best-effort: silently no-ops on disabled, unavailable config, in-flight
 * turn, or any generation failure. The recap is debounced per blur cycle —
 * a single back-and-forth produces at most one recap.
 */
export function useAwaySummary(options: UseAwaySummaryOptions): void {
  const {
    enabled,
    config,
    isFocused,
    isIdle,
    setAwayRecapItem,
    awayThresholdMinutes,
  } = options;

  const blurredAtRef = useRef<number | null>(null);
  const recapPendingRef = useRef(false);
  const inFlightRef = useRef<AbortController | null>(null);

  const isIdleRef = useRef(isIdle);
  isIdleRef.current = isIdle;

  const thresholdMs =
    (awayThresholdMinutes && awayThresholdMinutes > 0
      ? awayThresholdMinutes
      : DEFAULT_AWAY_THRESHOLD_MINUTES) *
    60 *
    1000;

  useEffect(() => {
    if (!enabled || !config) {
      inFlightRef.current?.abort();
      inFlightRef.current = null;
      blurredAtRef.current = null;
      return;
    }

    if (!isFocused) {
      if (blurredAtRef.current === null) {
        blurredAtRef.current = Date.now();
      }
      return;
    }

    const blurredAt = blurredAtRef.current;
    if (blurredAt === null) return;

    if (Date.now() - blurredAt < thresholdMs) {
      // Brief blur; reset and wait for the next away cycle.
      blurredAtRef.current = null;
      return;
    }

    if (recapPendingRef.current) return;
    // Wait for idle; do NOT clear blurredAtRef so this effect re-fires
    // (with isIdle in the deps) when the streaming turn finishes.
    if (!isIdleRef.current) return;

    blurredAtRef.current = null;
    recapPendingRef.current = true;
    const controller = new AbortController();
    inFlightRef.current = controller;

    void generateSessionRecap(config, controller.signal)
      .then((recap) => {
        if (controller.signal.aborted || !recap) return;
        if (!isIdleRef.current) return;
        const item: HistoryItemAwayRecap = {
          type: 'away_recap',
          text: recap.text,
        };
        setAwayRecapItem(item);
      })
      .finally(() => {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
        recapPendingRef.current = false;
      });
  }, [enabled, config, isFocused, isIdle, setAwayRecapItem, thresholdMs]);

  useEffect(
    () => () => {
      inFlightRef.current?.abort();
    },
    [],
  );
}
