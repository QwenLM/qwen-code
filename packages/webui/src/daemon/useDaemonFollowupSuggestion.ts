/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSyncExternalStore } from 'react';
import { useDaemonTranscriptStore } from './DaemonSessionProvider.js';
import {
  useFollowupSuggestions,
  type UseFollowupSuggestionsOptions,
} from '../hooks/useFollowupSuggestions.js';
import type { FollowupState } from '../types/followup.js';

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
 * The hook subscribes to the daemon store's `lastFollowupSuggestion`
 * sidechannel field and drives the existing `useFollowupSuggestions`
 * controller (timing / accept-dismiss state machine) — the controller
 * is the source of truth for what the InputForm renders. The store
 * is the source of truth for "what did the daemon last send for this
 * session" so reconnecting clients see the latest suggestion replayed
 * out of the daemon's SSE ring.
 *
 * Wiring `onAccept` and `onOutcome` propagates straight to the
 * controller; see `useFollowupSuggestions` for the contract.
 *
 * Must be called within a `<DaemonSessionProvider>` — throws via
 * `useDaemonTranscriptStore` otherwise.
 */
export function useDaemonFollowupSuggestion(
  opts: UseFollowupSuggestionsOptions = {},
): UseDaemonFollowupSuggestionReturn {
  const store = useDaemonTranscriptStore();
  const lastFollowupSuggestion = useSyncExternalStore(
    store.subscribe,
    () => store.getSnapshot().lastFollowupSuggestion,
    () => store.getSnapshot().lastFollowupSuggestion,
  );

  const controller = useFollowupSuggestions(opts);
  const { setSuggestion } = controller;

  // Push the store's latest suggestion into the controller exactly once
  // per (promptId, suggestion) pair. Tracking the last-pushed promptId
  // is what prevents the effect from re-pushing the same suggestion
  // after the user dismisses it locally — `dismiss` clears the
  // controller's React state, which would otherwise re-trigger this
  // effect on the next render and re-show the suggestion.
  const lastPushedPromptIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const nextPromptId = lastFollowupSuggestion?.promptId;
    if (nextPromptId === lastPushedPromptIdRef.current) return;
    lastPushedPromptIdRef.current = nextPromptId;
    setSuggestion(lastFollowupSuggestion?.suggestion ?? null);
  }, [lastFollowupSuggestion, setSuggestion]);

  const clear = useCallback(() => {
    // Clear local controller state immediately (no debounce) — the
    // user is about to type, so a 300ms-delayed display would be
    // jarring.
    controller.clear();
    // Drop the store's cached suggestion so the effect doesn't re-push
    // it. Also so that a reconnecting peer client doesn't see a stale
    // suggestion in the SDK reducer's sidechannel.
    store.clearFollowupSuggestion();
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
      store.clearFollowupSuggestion();
      lastPushedPromptIdRef.current = undefined;
    },
    [controller, store],
  );

  const onDismissFollowup = useCallback(() => {
    controller.dismiss();
    store.clearFollowupSuggestion();
    lastPushedPromptIdRef.current = undefined;
  }, [controller, store]);

  return useMemo(
    () => ({
      followupState: controller.state,
      onAcceptFollowup,
      onDismissFollowup,
      clear,
    }),
    [controller.state, onAcceptFollowup, onDismissFollowup, clear],
  );
}
