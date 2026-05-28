/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { useDaemonTranscriptStore } from './DaemonSessionProvider.js';
import {
  clearSidechannelFollowupSuggestion,
  getSidechannelFollowupSuggestion,
  subscribeSidechannelFollowupSuggestion,
} from './followupSidechannel.js';

const SUGGESTION_DELAY_MS = 300;
const ACCEPT_DEBOUNCE_MS = 100;

export interface FollowupState {
  suggestion: string | null;
  isVisible: boolean;
  shownAt: number;
}

const INITIAL_FOLLOWUP_STATE: Readonly<FollowupState> = Object.freeze({
  suggestion: null,
  isVisible: false,
  shownAt: 0,
});

export interface UseDaemonFollowupSuggestionOptions {
  enabled?: boolean;
  onAccept?: (suggestion: string) => void;
  onOutcome?: (params: {
    outcome: 'accepted' | 'ignored';
    accept_method?: 'tab' | 'enter' | 'right';
    time_ms: number;
    suggestion_length: number;
  }) => void;
}

interface DaemonFollowupController {
  setSuggestion: (text: string | null) => void;
  accept: (
    method?: 'tab' | 'enter' | 'right',
    options?: { skipOnAccept?: boolean },
  ) => void;
  dismiss: () => void;
  clear: () => void;
  cleanup: () => void;
}

function clearStoreFollowupSuggestion(
  store: ReturnType<typeof useDaemonTranscriptStore>,
): void {
  const maybeStore = store as typeof store & {
    clearFollowupSuggestion?: () => void;
  };
  maybeStore.clearFollowupSuggestion?.();
}

function createDaemonFollowupController(options: {
  enabled?: boolean;
  onStateChange: (state: FollowupState) => void;
  getOnAccept: () => ((suggestion: string) => void) | undefined;
  getOnOutcome: () => UseDaemonFollowupSuggestionOptions['onOutcome'];
}): DaemonFollowupController {
  const { enabled = true, onStateChange, getOnAccept, getOnOutcome } = options;
  let currentState: FollowupState = INITIAL_FOLLOWUP_STATE;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let accepting = false;
  let acceptTimeoutId: ReturnType<typeof setTimeout> | null = null;

  function applyState(next: FollowupState): void {
    currentState = next;
    onStateChange(next);
  }

  function clearTimers(): void {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (acceptTimeoutId) {
      clearTimeout(acceptTimeoutId);
      acceptTimeoutId = null;
    }
  }

  const setSuggestion = (text: string | null): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (!text) {
      applyState(INITIAL_FOLLOWUP_STATE);
      return;
    }
    if (!enabled) return;
    timeoutId = setTimeout(() => {
      applyState({ suggestion: text, isVisible: true, shownAt: Date.now() });
    }, SUGGESTION_DELAY_MS);
  };

  const accept = (
    method?: 'tab' | 'enter' | 'right',
    options?: { skipOnAccept?: boolean },
  ): void => {
    if (accepting) return;
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    accepting = true;

    const text = currentState.suggestion;
    const { shownAt } = currentState;
    if (!text) {
      accepting = false;
      return;
    }

    try {
      getOnOutcome()?.({
        outcome: 'accepted',
        accept_method: method,
        time_ms: shownAt > 0 ? Date.now() - shownAt : 0,
        suggestion_length: text.length,
      });
    } catch (error: unknown) {
      console.error('[followup] onOutcome callback threw:', error);
    }

    applyState(INITIAL_FOLLOWUP_STATE);

    queueMicrotask(() => {
      try {
        if (!options?.skipOnAccept) {
          getOnAccept()?.(text);
        }
      } catch (error: unknown) {
        console.error('[followup] onAccept callback threw:', error);
      } finally {
        if (acceptTimeoutId) {
          clearTimeout(acceptTimeoutId);
        }
        acceptTimeoutId = setTimeout(() => {
          accepting = false;
        }, ACCEPT_DEBOUNCE_MS);
      }
    });
  };

  const dismiss = (): void => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (!currentState.isVisible && !currentState.suggestion) return;
    if (currentState.isVisible && currentState.suggestion) {
      try {
        getOnOutcome()?.({
          outcome: 'ignored',
          time_ms:
            currentState.shownAt > 0 ? Date.now() - currentState.shownAt : 0,
          suggestion_length: currentState.suggestion.length,
        });
      } catch (error: unknown) {
        console.error('[followup] onOutcome callback threw:', error);
      }
    }
    applyState(INITIAL_FOLLOWUP_STATE);
  };

  const clear = (): void => {
    clearTimers();
    accepting = false;
    applyState(INITIAL_FOLLOWUP_STATE);
  };

  const cleanup = (): void => {
    clearTimers();
    accepting = false;
  };

  return { setSuggestion, accept, dismiss, clear, cleanup };
}

export interface UseDaemonFollowupSuggestionReturn {
  /**
   * Current follow-up suggestion display state — pass directly to
   * `<InputForm followupState={...} />`. Reflects the controller's
   * post-debounce visible state, not the raw daemon push.
   */
  followupState: FollowupState;
  /**
   * Accept the visible suggestion. Wire to `<InputForm onAcceptFollowup={...} />`.
   * Calls the underlying controller's accept (which invokes the
   * consumer-provided `onAccept` from options) AND clears the daemon
   * store's `lastFollowupSuggestion` so the same suggestion does not
   * re-push into the controller on the next render.
   */
  onAcceptFollowup: (
    method?: 'tab' | 'enter' | 'right',
    options?: { skipOnAccept?: boolean },
  ) => void;
  /**
   * Dismiss the visible suggestion. Wire to `<InputForm onDismissFollowup={...} />`.
   * Same store-clear semantics as `onAcceptFollowup`.
   */
  onDismissFollowup: () => void;
  /**
   * Explicit invalidation hook. Adapters call this just before invoking
   * `actions.sendPrompt(...)` so the prior turn's ghost-text disappears
   * synchronously — no wire round-trip needed (the daemon does not
   * emit a "suggestion cleared" event on prompt boundaries; clients
   * self-invalidate).
   */
  clear: () => void;
}

/**
 * Wire the daemon's server-pushed `followup_suggestion` event into the
 * webui's `<InputForm>`. Consumers:
 *
 *   1. Render `<InputForm followupState={...} onAcceptFollowup={...}
 *      onDismissFollowup={...} />` with the three values returned here.
 *   2. Call `clear()` from the hook just before `actions.sendPrompt(...)`
 *      so the prior turn's ghost-text disappears immediately.
 *
 * The hook subscribes to daemon follow-up sidechannels and drives a
 * daemon-local accept/dismiss controller. The controller is the source
 * of truth for what the input renders; the store/sidechannel is the
 * source of truth for what the daemon last sent for this session.
 *
 * Wiring `onAccept` and `onOutcome` propagates straight to the
 * daemon-local controller.
 *
 * Must be called within a `<DaemonSessionProvider>` — throws via
 * `useDaemonTranscriptStore` otherwise.
 */
export function useDaemonFollowupSuggestion(
  opts: UseDaemonFollowupSuggestionOptions = {},
): UseDaemonFollowupSuggestionReturn {
  const { enabled = true, onAccept, onOutcome } = opts;
  const store = useDaemonTranscriptStore();
  const [state, setState] = useState<FollowupState>(INITIAL_FOLLOWUP_STATE);
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;
  const lastFollowupSuggestion = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().lastFollowupSuggestion,
    () => store.getSnapshot().lastFollowupSuggestion,
  );
  const sidechannelFollowupSuggestion = useSyncExternalStore(
    subscribeSidechannelFollowupSuggestion,
    getSidechannelFollowupSuggestion,
    getSidechannelFollowupSuggestion,
  );
  const activeFollowupSuggestion =
    sidechannelFollowupSuggestion ?? lastFollowupSuggestion;

  const controller = useMemo(
    () =>
      createDaemonFollowupController({
        enabled,
        onStateChange: setState,
        getOnAccept: () => onAcceptRef.current,
        getOnOutcome: () => onOutcomeRef.current,
      }),
    [enabled],
  );
  const { setSuggestion } = controller;

  useEffect(() => {
    if (!enabled) {
      controller.clear();
    }
    return () => controller.cleanup();
  }, [controller, enabled]);

  // Push the store's latest suggestion into the controller exactly once
  // per (promptId, suggestion) pair. Tracking the last-pushed promptId
  // is what prevents the effect from re-pushing the same suggestion
  // after the user dismisses it locally — `dismiss` clears the
  // controller's React state, which would otherwise re-trigger this
  // effect on the next render and re-show the suggestion.
  const lastPushedPromptIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const nextPromptId = activeFollowupSuggestion?.promptId;
    if (nextPromptId === lastPushedPromptIdRef.current) return;
    lastPushedPromptIdRef.current = nextPromptId;
    setSuggestion(activeFollowupSuggestion?.suggestion ?? null);
  }, [activeFollowupSuggestion, setSuggestion]);

  const clear = useCallback(() => {
    // Clear local controller state immediately (no debounce) — the
    // user is about to type, so a 300ms-delayed display would be
    // jarring.
    controller.clear();
    // Drop the store's cached suggestion so the effect doesn't re-push
    // it. Also so that a reconnecting peer client doesn't see a stale
    // suggestion in the SDK reducer's sidechannel.
    clearStoreFollowupSuggestion(store);
    clearSidechannelFollowupSuggestion();
    lastPushedPromptIdRef.current = undefined;
  }, [controller, store]);

  const onAcceptFollowup = useCallback(
    (
      method?: 'tab' | 'enter' | 'right',
      options?: { skipOnAccept?: boolean },
    ) => {
      controller.accept(method, options);
      // Same invalidation rationale as `clear` — once the suggestion is
      // consumed, the store should not redeliver it.
      clearStoreFollowupSuggestion(store);
      clearSidechannelFollowupSuggestion();
      lastPushedPromptIdRef.current = undefined;
    },
    [controller, store],
  );

  const onDismissFollowup = useCallback(() => {
    controller.dismiss();
    clearStoreFollowupSuggestion(store);
    clearSidechannelFollowupSuggestion();
    lastPushedPromptIdRef.current = undefined;
  }, [controller, store]);

  return useMemo(
    () => ({
      followupState: state,
      onAcceptFollowup,
      onDismissFollowup,
      clear,
    }),
    [state, onAcceptFollowup, onDismissFollowup, clear],
  );
}
