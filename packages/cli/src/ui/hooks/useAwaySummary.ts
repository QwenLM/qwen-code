/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { generateSessionRecap, type Config } from '@qwen-code/qwen-code-core';
import type { HistoryItemAwayRecap } from '../types.js';

const AWAY_THRESHOLD_MS = 5 * 60 * 1000;

export interface UseAwaySummaryOptions {
  enabled: boolean;
  config: Config | null;
  isFocused: boolean;
  isIdle: boolean;
  setAwayRecapItem: (item: HistoryItemAwayRecap | null) => void;
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
  const { enabled, config, isFocused, isIdle, setAwayRecapItem } = options;

  const blurredAtRef = useRef<number | null>(null);
  const recapPendingRef = useRef(false);
  const inFlightRef = useRef<AbortController | null>(null);

  const isIdleRef = useRef(isIdle);
  isIdleRef.current = isIdle;

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

    if (Date.now() - blurredAt < AWAY_THRESHOLD_MS) {
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
  }, [enabled, config, isFocused, isIdle, setAwayRecapItem]);

  useEffect(
    () => () => {
      inFlightRef.current?.abort();
    },
    [],
  );
}
