/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { generateSessionRecap, type Config } from '@qwen-code/qwen-code-core';
import type {
  HistoryItem,
  HistoryItemAwayRecap,
  HistoryItemWithoutId,
} from '../types.js';

const DEFAULT_AWAY_THRESHOLD_MINUTES = 5;

// Dedup thresholds, matching Claude Code's `Sc1`/`Rc1`:
// - need at least MIN_USER_MESSAGES_TO_FIRE user turns total
// - if a recap is already in history, need at least
//   MIN_USER_MESSAGES_SINCE_LAST_RECAP new user turns since then before
//   another can fire. Prevents back-to-back recaps when the user briefly
//   alt-tabs twice without doing any new work in between.
const MIN_USER_MESSAGES_TO_FIRE = 3;
const MIN_USER_MESSAGES_SINCE_LAST_RECAP = 2;

export interface UseAwaySummaryOptions {
  enabled: boolean;
  config: Config | null;
  isFocused: boolean;
  isIdle: boolean;
  addItem: (item: HistoryItemWithoutId, baseTimestamp: number) => number;
  /**
   * The current chat history. Read at fire time only (via a ref) to apply
   * the dedup gate; not added to the effect's deps so it doesn't re-fire
   * on every history change.
   */
  history: HistoryItem[];
  /**
   * Minutes the terminal must be blurred before an auto-recap fires on
   * the next focus-in. Falsy / non-positive values fall back to the
   * 5-minute default (matching Claude Code).
   */
  awayThresholdMinutes?: number;
}

/**
 * Whether enough new user activity has happened since the last recap to
 * justify another one. Mirrors Claude Code's `Ic1` gate.
 */
function shouldFireRecap(history: HistoryItem[]): boolean {
  let userMessageCount = 0;
  let lastRecapIndex = -1;
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    if (item.type === 'user') userMessageCount++;
    if (item.type === 'away_recap') lastRecapIndex = i;
  }
  if (userMessageCount < MIN_USER_MESSAGES_TO_FIRE) return false;
  if (lastRecapIndex === -1) return true;
  let userSinceLast = 0;
  for (let i = lastRecapIndex + 1; i < history.length; i++) {
    if (history[i].type === 'user') userSinceLast++;
  }
  return userSinceLast >= MIN_USER_MESSAGES_SINCE_LAST_RECAP;
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
    addItem,
    history,
    awayThresholdMinutes,
  } = options;

  const blurredAtRef = useRef<number | null>(null);
  const recapPendingRef = useRef(false);
  const inFlightRef = useRef<AbortController | null>(null);

  const isIdleRef = useRef(isIdle);
  isIdleRef.current = isIdle;

  // Latest history snapshot, read at fire time only — keeps history out
  // of the effect's deps so we don't re-evaluate on every message.
  const historyRef = useRef(history);
  historyRef.current = history;

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

    // Skip if the conversation hasn't moved enough since the last recap —
    // a brief alt-tab cycle right after a recap shouldn't produce a near-
    // duplicate one.
    if (!shouldFireRecap(historyRef.current)) {
      blurredAtRef.current = null;
      return;
    }

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
        addItem(item, Date.now());
      })
      .finally(() => {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
        }
        recapPendingRef.current = false;
      });
  }, [enabled, config, isFocused, isIdle, addItem, thresholdMs]);

  useEffect(
    () => () => {
      inFlightRef.current?.abort();
    },
    [],
  );
}
