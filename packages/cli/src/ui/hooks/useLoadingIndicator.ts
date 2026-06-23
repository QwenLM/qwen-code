/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamingState } from '../types.js';
import type { ThoughtSummary } from '../types.js';
import { useTimer } from './useTimer.js';
import { usePhraseCycler } from './usePhraseCycler.js';
import { useState, useEffect, useRef } from 'react';
import { escapeAnsiCtrlCodes } from '../utils/textUtils.js';

const MAX_LOADING_PHRASE_LENGTH = 80;

function truncateLoadingPhrase(phrase: string): string {
  if (phrase.length <= MAX_LOADING_PHRASE_LENGTH) return phrase;
  return phrase.slice(0, MAX_LOADING_PHRASE_LENGTH - 1).trimEnd() + '…';
}

export const useLoadingIndicator = (
  streamingState: StreamingState,
  customWittyPhrases?: string[],
  currentCandidatesTokens?: number,
  currentStreamingChars?: number,
  thought?: ThoughtSummary | null,
) => {
  const [timerResetKey, setTimerResetKey] = useState(0);
  const isTimerActive = streamingState === StreamingState.Responding;

  const elapsedTimeFromTimer = useTimer(isTimerActive, timerResetKey);

  const isPhraseCyclingActive = streamingState === StreamingState.Responding;
  const isWaiting = streamingState === StreamingState.WaitingForConfirmation;
  const currentLoadingPhrase = usePhraseCycler(
    isPhraseCyclingActive,
    isWaiting,
    customWittyPhrases,
  );

  const [retainedElapsedTime, setRetainedElapsedTime] = useState(0);
  const [taskStartTokens, setTaskStartTokens] = useState(0);
  const [taskStartStreamingChars, setTaskStartStreamingChars] = useState(0);
  const prevStreamingStateRef = useRef<StreamingState | null>(null);

  useEffect(() => {
    if (
      prevStreamingStateRef.current === StreamingState.WaitingForConfirmation &&
      streamingState === StreamingState.Responding
    ) {
      setTimerResetKey((prevKey) => prevKey + 1);
      setRetainedElapsedTime(0);
      setTaskStartTokens(currentCandidatesTokens ?? 0);
      setTaskStartStreamingChars(currentStreamingChars ?? 0);
    } else if (
      streamingState === StreamingState.Idle &&
      prevStreamingStateRef.current === StreamingState.Responding
    ) {
      setTimerResetKey((prevKey) => prevKey + 1);
      setRetainedElapsedTime(0);
      setTaskStartTokens(0);
      setTaskStartStreamingChars(0);
    } else if (
      streamingState === StreamingState.Responding &&
      prevStreamingStateRef.current !== StreamingState.Responding
    ) {
      setTaskStartTokens(currentCandidatesTokens ?? 0);
      setTaskStartStreamingChars(currentStreamingChars ?? 0);
    } else if (streamingState === StreamingState.WaitingForConfirmation) {
      setRetainedElapsedTime(elapsedTimeFromTimer);
    }

    prevStreamingStateRef.current = streamingState;
  }, [
    streamingState,
    elapsedTimeFromTimer,
    currentCandidatesTokens,
    currentStreamingChars,
  ]);

  // thought is transient — useGeminiStream clears it when content or tool
  // calls arrive, often in the same React batch as the setThought(value).
  // A ref captures the subject synchronously during render, surviving the
  // batch so the loading indicator keeps showing the model's intent
  // throughout the rest of the turn.
  // Falls back to description (first line) when subject is absent — many
  // models don't emit **bold** subjects in their thinking.
  const thoughtText = escapeAnsiCtrlCodes(
    thought?.subject?.trim() ||
      thought?.description?.trim().split('\n')[0] ||
      '',
  );
  const retainedThoughtRef = useRef<string | null>(null);
  if (thoughtText) retainedThoughtRef.current = thoughtText;
  if (streamingState === StreamingState.Idle) retainedThoughtRef.current = null;

  const activeThoughtPhrase = thoughtText || retainedThoughtRef.current;
  const loadingPhrase =
    streamingState === StreamingState.Responding && activeThoughtPhrase
      ? truncateLoadingPhrase(activeThoughtPhrase)
      : currentLoadingPhrase;

  return {
    elapsedTime:
      streamingState === StreamingState.WaitingForConfirmation
        ? retainedElapsedTime
        : elapsedTimeFromTimer,
    currentLoadingPhrase: loadingPhrase,
    taskStartTokens,
    taskStartStreamingChars,
  };
};
