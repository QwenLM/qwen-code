/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type {
  TextBuffer,
  TextBufferSnapshot,
} from '../components/shared/text-buffer.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { persistentState } from '../../utils/persistentState.js';
import { AppEvent, appEvents, TransientMessageType } from '../../utils/events.js';

/**
 * Length thresholds for the one-time stash hint. A draft that peaked above
 * HINT_PEAK_LENGTH and was whittled down below HINT_REMAINING_LENGTH one
 * keystroke at a time reads as "clearing the composer to ask something else" —
 * the moment stashing is worth teaching.
 */
const HINT_PEAK_LENGTH = 20;
const HINT_REMAINING_LENGTH = 5;

/** What a ctrl+s press actually did, so callers can stay silent on a no-op. */
export type StashToggleResult = 'push' | 'pop' | 'noop';

export interface PromptStashState {
  /** Whether a stashed draft is currently held. */
  hasStash: boolean;
  /** ctrl+s — push when the composer has text, pop when it is empty. */
  toggleStash: () => StashToggleResult;
  /** Arm one best-effort auto-restore attempt; ignored when nothing is stashed. */
  markRestorePending: () => void;
}

interface StashState {
  snapshot: TextBufferSnapshot | null;
  restorePending: boolean;
}

type StashAction =
  | { type: 'push'; snapshot: TextBufferSnapshot }
  | { type: 'pop' }
  | { type: 'armRestore' }
  | { type: 'consumeRestore' }
  | { type: 'reset' };

const initialStashState: StashState = {
  snapshot: null,
  restorePending: false,
};

/**
 * Invariant: any action that moves `snapshot` between null and non-null also
 * clears `restorePending`. A pending flag that outlives its snapshot would fire
 * against the *next* stash, popping a draft back the instant it was stashed.
 */
function stashReducer(state: StashState, action: StashAction): StashState {
  switch (action.type) {
    case 'push':
      return { snapshot: action.snapshot, restorePending: false };
    case 'pop':
    case 'reset':
      return initialStashState;
    case 'armRestore':
      if (!state.snapshot) return state;
      return { ...state, restorePending: true };
    case 'consumeRestore':
      if (!state.restorePending) return state;
      return { ...state, restorePending: false };
    default:
      return state;
  }
}

function isComposerEmpty(buffer: TextBuffer): boolean {
  return buffer.text.trim() === '';
}

export interface UsePromptStashOptions {
  buffer: TextBuffer;
  /**
   * Always-current buffer. The `buffer` memo is recreated on every edit, so the
   * auto-restore effect must go through the ref to reach the live object —
   * especially across an InputPrompt unmount.
   */
  bufferRef: MutableRefObject<TextBuffer | null>;
}

/**
 * Ctrl+S prompt stash: a single in-memory slot holding one draft.
 *
 * Lives beside the buffer rather than inside InputPrompt because InputPrompt
 * unmounts while a slash command runs — exactly the window the stash has to
 * survive to be restored afterwards.
 */
export function usePromptStash({
  buffer,
  bufferRef,
}: UsePromptStashOptions): PromptStashState {
  const { isInputActive, conversationKey } = useUIState();
  const [state, dispatch] = useReducer(stashReducer, initialStashState);

  // Read state through a ref so the callbacks keep a stable identity: they feed
  // InputPrompt's handleSubmitAndClear dependency array, which would otherwise
  // rebuild every frame.
  const stateRef = useRef(state);
  stateRef.current = state;

  const toggleStash = useCallback((): StashToggleResult => {
    const live = bufferRef.current ?? buffer;
    if (!isComposerEmpty(live)) {
      dispatch({ type: 'push', snapshot: live.getSnapshot() });
      live.setText('');
      if (persistentState.get('promptStashHintShown') !== true) {
        persistentState.set('promptStashHintShown', true);
      }
      return 'push';
    }
    if (stateRef.current.snapshot) {
      live.restoreSnapshot(stateRef.current.snapshot);
      dispatch({ type: 'pop' });
      return 'pop';
    }
    return 'noop';
  }, [buffer, bufferRef]);

  const markRestorePending = useCallback(() => {
    dispatch({ type: 'armRestore' });
  }, []);

  useEffect(() => {
    const { snapshot, restorePending } = state;
    if (!restorePending || !snapshot) return;
    // Keep the flag armed while the composer is down (slash command in flight);
    // the restore happens when input reactivates.
    if (!isInputActive) return;
    const live = bufferRef.current;
    if (!live) return;
    if (isComposerEmpty(live)) {
      live.restoreSnapshot(snapshot);
      dispatch({ type: 'pop' });
    } else {
      // The user started a new draft — abandon this attempt, keep the stash.
      dispatch({ type: 'consumeRestore' });
    }
  }, [state, isInputActive, bufferRef]);

  const previousConversationKeyRef = useRef(conversationKey);
  useEffect(() => {
    if (previousConversationKeyRef.current === conversationKey) return;
    previousConversationKeyRef.current = conversationKey;
    dispatch({ type: 'reset' });
  }, [conversationKey]);

  const previousLengthRef = useRef(buffer.text.length);
  const peakLengthRef = useRef(buffer.text.length);
  useEffect(() => {
    const length = buffer.text.length;
    const previousLength = previousLengthRef.current;
    const peakLength = peakLengthRef.current;
    previousLengthRef.current = length;

    if (length > peakLength) {
      peakLengthRef.current = length;
      return;
    }
    if (length === 0) {
      peakLengthRef.current = 0;
      return;
    }
    const clearedSubstantialDraft =
      peakLength >= HINT_PEAK_LENGTH && length <= HINT_REMAINING_LENGTH;
    // A single-step wipe (ctrl+u, esc esc) is a deliberate discard, not the
    // hesitant backspacing the hint is meant to catch.
    const wasSingleStepClear =
      previousLength >= HINT_PEAK_LENGTH && length <= HINT_REMAINING_LENGTH;
    if (!clearedSubstantialDraft || wasSingleStepClear) return;
    peakLengthRef.current = length;
    if (persistentState.get('promptStashHintShown') === true) return;
    persistentState.set('promptStashHintShown', true);
    appEvents.emit(AppEvent.TransientMessage, {
      id: 'prompt-stash-hint',
      message: 'Tip: press ctrl+s to stash your draft and bring it back later.',
      type: TransientMessageType.Hint,
    });
  }, [buffer.text]);

  return useMemo(
    () => ({
      hasStash: state.snapshot !== null,
      toggleStash,
      markRestorePending,
    }),
    [state.snapshot, toggleStash, markRestorePending],
  );
}
