/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkExhaustive } from '@qwen-code/core';
import type { TextBuffer } from '../components/shared/text-buffer.js';

export type NextActionKind = 'model';

export interface NextActionSuggestion {
  kind: NextActionKind;
  label: string;
  text: string;
  category: 'security_scan' | 'other';
  securityMode?: 'L2' | 'L3' | 'project_file' | 'unknown';
}

export interface NextActionSuggestionSet {
  signature: string;
  items: NextActionSuggestion[];
}

export interface ModelNextActionSuggestionSet {
  id: number;
  promptId: string;
  items: readonly string[];
}

export interface UseNextActionSuggestionsOptions {
  buffer: TextBuffer;
  modelSuggestions?: ModelNextActionSuggestionSet | null;
  active: boolean;
}

export interface UseNextActionSuggestionsReturn {
  suggestions: NextActionSuggestion[];
  isVisible: boolean;
  accept: (index: number) => boolean;
  /**
   * Undo the most recent accept: if the buffer still holds exactly the
   * accepted suggestion text, clear it so the suggestions become visible
   * again. Returns true when a revert happened.
   */
  revertAccept: () => boolean;
  /**
   * Mark that the current buffer is being submitted. Only a submission that
   * begins from the armed state (buffer exactly holds the accepted text)
   * may later be re-armed by resolveFailedSubmission; submissions of
   * user-edited text stay non-revertable.
   */
  beginSubmission: () => void;
  /**
   * Resolve a failed submit. Pass the restored text when the buffer was
   * restored to its pre-submit content, or null when the user's own draft
   * was kept instead. Re-arms the ESC revert only for a restored
   * submission that began from armed and whose text is the accepted
   * suggestion; a kept draft is never re-armed, even when it happens to
   * match the accepted text.
   */
  resolveFailedSubmission: (restoredText: string | null) => void;
  clear: () => void;
  recordSubmission: (submittedText: string) => void;
}

const MAX_SUGGESTIONS = 1;

interface TrackedSuggestionSet {
  signature: string;
  items: NextActionSuggestion[];
}

/**
 * Accept/revert lifecycle as a single discriminated state so no forked
 * combination (e.g. armed without an accept record) is representable:
 * - idle:       no accepted suggestion.
 * - armed:      the buffer still holds the accepted text; ESC reverts
 *               (while vim is in INSERT mode the prompt defers the revert
 *               to the next ESC, which arrives from NORMAL mode).
 * - submitting: the accepted text is being submitted — the programmatic
 *               buffer clear before onSubmit must not count as a user
 *               edit. A failed submit resolves back to armed, success to
 *               idle.
 * - pending:    the buffer deviated through a user edit, or a failed
 *               submit restored non-accepted text / kept the user's own
 *               draft. Never re-armable.
 */
type AcceptState =
  | { phase: 'idle' }
  | {
      phase: 'armed' | 'submitting' | 'pending';
      tracked: TrackedSuggestionSet;
      index: number;
    };

const IDLE_ACCEPT_STATE: AcceptState = { phase: 'idle' };

function getAcceptedItem(state: AcceptState): NextActionSuggestion | undefined {
  return state.phase === 'idle'
    ? undefined
    : state.tracked.items[state.index];
}

type AcceptEvent =
  | { type: 'accepted'; tracked: TrackedSuggestionSet; index: number }
  | { type: 'buffer_changed'; text: string }
  | { type: 'reverted' }
  | { type: 'accept_abandoned' }
  | { type: 'submission_started'; text: string }
  | { type: 'submission_failed'; restoredText: string | null }
  | { type: 'submission_recorded' };

// Single transition function for the accept/revert lifecycle (per the CLI
// AGENTS.md rule to use reducers for complex state transitions). Every
// state change is routed through here so no phase branch can be missed by
// a stray mutation.
function acceptStateReducer(
  state: AcceptState,
  event: AcceptEvent,
): AcceptState {
  switch (event.type) {
    case 'accepted':
      return { phase: 'armed', tracked: event.tracked, index: event.index };
    case 'buffer_changed': {
      // A user edit that deviates from the accepted text disarms revert;
      // submitting is exempt because its buffer clear is programmatic.
      if (state.phase !== 'armed') return state;
      const acceptedItem = getAcceptedItem(state);
      return acceptedItem && event.text === acceptedItem.text
        ? state
        : { ...state, phase: 'pending' };
    }
    case 'reverted':
      return IDLE_ACCEPT_STATE;
    case 'accept_abandoned':
      // The accept record ends without a submission (set replaced,
      // dismissed, another accept, or session end).
      return IDLE_ACCEPT_STATE;
    case 'submission_started': {
      // Only a submission of the exact accepted text may later re-arm.
      if (state.phase !== 'armed') return state;
      const acceptedItem = getAcceptedItem(state);
      return acceptedItem && event.text === acceptedItem.text
        ? { ...state, phase: 'submitting' }
        : state;
    }
    case 'submission_failed': {
      if (state.phase !== 'submitting') return state;
      // A null restoredText means the buffer kept the user's own draft
      // rather than being restored, so this accept can never re-arm —
      // otherwise ESC would clear text the user typed themselves.
      if (event.restoredText === null) return { ...state, phase: 'pending' };
      const acceptedItem = getAcceptedItem(state);
      return acceptedItem && event.restoredText === acceptedItem.text
        ? { ...state, phase: 'armed' }
        : { ...state, phase: 'pending' };
    }
    case 'submission_recorded':
      return IDLE_ACCEPT_STATE;
    default:
      return checkExhaustive(event);
  }
}

const MODEL_SUGGESTION_PREFIX_RE = /^\s*(?:\d+[.)]|[-\u2022])\s*/u;

const SECURITY_L2_RE =
  /(?:\bL2\b.{0,24}(?:review|scan|security|审查|扫描|安全)|(?:review|scan|security|审查|扫描|安全).{0,24}\bL2\b|lightweight\s+(?:review|scan)|轻量(?:级)?(?:审查|扫描|检查))/iu;
const SECURITY_L3_RE =
  /(?:\bL3\b.{0,24}(?:review|scan|security|审查|扫描|安全)|(?:review|scan|security|审查|扫描|安全).{0,24}\bL3\b|deep\s+(?:review|scan)|深度(?:审查|扫描|检查))/iu;
const SECURITY_PROJECT_FILE_RE =
  /(?:\bL4\b.{0,24}(?:scan|security|扫描|安全)|(?:scan|security|扫描|安全).{0,24}\bL4\b|project\s*\/\s*file\s+scan|(?:scan|security).{0,24}(?:whole|entire)\s+(?:repository|repo)|(?:whole|entire)\s+(?:repository|repo).{0,24}(?:scan|security)|(?:扫描|检查|安全).{0,8}(?:全|整个)(?:项目|仓库|代码库)|全(?:项目|仓库|代码库).{0,8}(?:扫描|检查|安全)|整个(?:项目|仓库|代码库).{0,8}(?:扫描|检查|安全)|(?:项目|仓库|代码库|文件|路径).{0,8}(?:扫描|检查))/iu;
const SECURITY_CATEGORY_RE =
  /(?:security|vulnerab|安全|漏洞)/iu;

export function classifyNextActionSuggestion(text: string): Pick<
  NextActionSuggestion,
  'category' | 'securityMode'
> {
  if (SECURITY_L2_RE.test(text)) {
    return { category: 'security_scan', securityMode: 'L2' };
  }
  if (SECURITY_L3_RE.test(text)) {
    return { category: 'security_scan', securityMode: 'L3' };
  }
  if (SECURITY_PROJECT_FILE_RE.test(text)) {
    return { category: 'security_scan', securityMode: 'project_file' };
  }
  if (SECURITY_CATEGORY_RE.test(text)) {
    return { category: 'security_scan', securityMode: 'unknown' };
  }
  return { category: 'other' };
}

export function getModelNextActionSuggestions(
  modelSuggestions: ModelNextActionSuggestionSet | null | undefined,
): NextActionSuggestionSet | null {
  if (!modelSuggestions) {
    return null;
  }

  const seen = new Set<string>();
  const items = modelSuggestions.items
    .map((item) => item.replace(MODEL_SUGGESTION_PREFIX_RE, '').trim())
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    })
    .slice(0, MAX_SUGGESTIONS)
    .map((item): NextActionSuggestion => {
      const classification = classifyNextActionSuggestion(item);
      return {
        kind: 'model',
        label: item,
        text: item,
        ...classification,
      };
    });

  if (items.length === 0) {
    return null;
  }

  return {
    signature: `model:${modelSuggestions.id}`,
    items,
  };
}

export function useNextActionSuggestions({
  buffer,
  modelSuggestions,
  active,
}: UseNextActionSuggestionsOptions): UseNextActionSuggestionsReturn {
  const [suppressedSignature, setSuppressedSignature] = useState<string | null>(
    null,
  );

  const modelSuggestionSet = useMemo(
    () => getModelNextActionSuggestions(modelSuggestions),
    [modelSuggestions],
  );

  const isVisible =
    active &&
    buffer.text.length === 0 &&
    modelSuggestionSet !== null &&
    modelSuggestionSet.signature !== suppressedSignature;

  const trackedSetRef = useRef<TrackedSuggestionSet | null>(null);
  const acceptStateRef = useRef<AcceptState>(IDLE_ACCEPT_STATE);
  const dispatchAcceptEvent = useCallback((event: AcceptEvent) => {
    acceptStateRef.current = acceptStateReducer(acceptStateRef.current, event);
  }, []);

  // Route buffer changes through the reducer (armed → pending on user
  // edits that deviate from the accepted text).
  useEffect(() => {
    dispatchAcceptEvent({ type: 'buffer_changed', text: buffer.text });
  }, [buffer.text, dispatchAcceptEvent]);

  // Close a still-open accept record without a submission (set replaced,
  // dismissed, another accept, or session end).
  const abandonAcceptedSuggestion = useCallback(() => {
    if (acceptStateRef.current.phase === 'idle') return;
    dispatchAcceptEvent({ type: 'accept_abandoned' });
  }, [dispatchAcceptEvent]);

  useEffect(() => {
    const nextSignature = modelSuggestionSet?.signature;
    const tracked = trackedSetRef.current;
    if (tracked && nextSignature !== tracked.signature) {
      abandonAcceptedSuggestion();
      trackedSetRef.current = null;
    }

    if (!isVisible || !modelSuggestionSet) return;
    if (trackedSetRef.current?.signature === modelSuggestionSet.signature) {
      return;
    }

    trackedSetRef.current = {
      signature: modelSuggestionSet.signature,
      items: modelSuggestionSet.items,
    };
  }, [
    isVisible,
    modelSuggestionSet,
    abandonAcceptedSuggestion,
  ]);

  // An accept still open when the hook unmounts is discarded.
  useEffect(
    () => () => {
      abandonAcceptedSuggestion();
    },
    [abandonAcceptedSuggestion],
  );

  const clear = useCallback(() => {
    if (modelSuggestionSet) {
      // clear() 的调用点都由 isVisible（空 buffer）守卫，与持有已接受文本的
      // 'armed' 互斥，所以此处只需收尾仍开启的 accept 记录。
      abandonAcceptedSuggestion();
      setSuppressedSignature(modelSuggestionSet.signature);
    }
  }, [modelSuggestionSet, abandonAcceptedSuggestion]);

  const accept = useCallback(
    (index: number): boolean => {
      if (!modelSuggestionSet || !isVisible) {
        return false;
      }
      const suggestion = modelSuggestionSet.items[index];
      if (!suggestion) {
        return false;
      }
      let tracked = trackedSetRef.current;
      if (!tracked) {
        tracked = {
          signature: modelSuggestionSet.signature,
          items: modelSuggestionSet.items,
        };
        trackedSetRef.current = tracked;
      }
      // An earlier accept still open (e.g. edited into pending, then the
      // buffer emptied) ends as abandoned before the new accept opens.
      abandonAcceptedSuggestion();
      dispatchAcceptEvent({ type: 'accepted', tracked, index });
      // No suppression on accept: visibility is gated by the non-empty
      // buffer, so deleting the inserted text brings the suggestions back.
      buffer.setText(suggestion.text);
      return true;
    },
    [
      buffer,
      dispatchAcceptEvent,
      isVisible,
      modelSuggestionSet,
      abandonAcceptedSuggestion,
    ],
  );

  const revertAccept = useCallback((): boolean => {
    const state = acceptStateRef.current;
    if (state.phase !== 'armed') {
      return false;
    }
    const acceptedItem = getAcceptedItem(state);
    if (!acceptedItem || buffer.text !== acceptedItem.text) {
      return false;
    }
    dispatchAcceptEvent({ type: 'reverted' });
    buffer.setText('');
    return true;
  }, [buffer, dispatchAcceptEvent]);

  const beginSubmission = useCallback(() => {
    dispatchAcceptEvent({ type: 'submission_started', text: buffer.text });
  }, [buffer, dispatchAcceptEvent]);

  const resolveFailedSubmission = useCallback(
    (restoredText: string | null) => {
      dispatchAcceptEvent({ type: 'submission_failed', restoredText });
    },
    [dispatchAcceptEvent],
  );

  const recordSubmission = useCallback(
    (_submittedText: string) => {
      dispatchAcceptEvent({ type: 'submission_recorded' });
    },
    [dispatchAcceptEvent],
  );

  return {
    suggestions: isVisible ? modelSuggestionSet.items : [],
    isVisible,
    accept,
    revertAccept,
    beginSubmission,
    resolveFailedSubmission,
    clear,
    recordSubmission,
  };
}
