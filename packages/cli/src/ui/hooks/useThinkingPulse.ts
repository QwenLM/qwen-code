/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { useUIState } from '../contexts/UIStateContext.js';
import { useEffectiveVerbose } from '../contexts/DisplayModeContext.js';
import { StreamingState } from '../types.js';

/**
 * Ephemeral "model is thinking" indicator state.
 *
 * The new compact UI hides `gemini_thought` / `gemini_thought_content`
 * history items, which leaves a silent gap while the model reasons.
 * This hook derives a transient indicator from existing state — no new
 * event bus needed:
 *
 *   - active when streamingState === Responding AND the most recent
 *     pending history item is a thought.
 *   - elapsed clock starts the first time the indicator becomes active
 *     in the current turn and is reset whenever the indicator goes
 *     inactive.
 *
 * Returns `null` in verbose / transcript mode where thoughts already
 * render inline.
 */
export function useThinkingPulse(): {
  active: boolean;
  elapsedMs: number;
} | null {
  const ui = useUIState();
  const verbose = useEffectiveVerbose();

  // Defensive: some lightweight test harnesses mock UIState without these
  // fields. They are guaranteed to exist in the production AppContainer.
  const pendingHistoryItems = ui.pendingHistoryItems ?? [];
  const streamingState = ui.streamingState ?? StreamingState.Idle;

  const lastItem = pendingHistoryItems.at(-1);
  const isThinking =
    streamingState === StreamingState.Responding &&
    !!lastItem &&
    (lastItem.type === 'gemini_thought' ||
      lastItem.type === 'gemini_thought_content');

  const startedAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isThinking) {
      startedAtRef.current = null;
      setElapsedMs(0);
      return;
    }
    if (startedAtRef.current === null) {
      startedAtRef.current = Date.now();
    }
    const interval = setInterval(() => {
      if (startedAtRef.current !== null) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [isThinking]);

  if (verbose) return null;
  return { active: isThinking, elapsedMs };
}
