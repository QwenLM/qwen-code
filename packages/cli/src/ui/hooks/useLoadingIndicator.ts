/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamingState } from '../types.js';
import { useTimer } from './useTimer.js';
import { usePhraseCycler } from './usePhraseCycler.js';
import { useState, useEffect, useRef } from 'react';

export const useLoadingIndicator = (
  streamingState: StreamingState,
  customWittyPhrases?: string[],
  currentCandidatesTokens?: number,
  currentStreamingChars?: number,
  isToolExecuting = false,
) => {
  const [timerResetKey, setTimerResetKey] = useState(0);
  const isTimerActive = streamingState === StreamingState.Responding;

  const elapsedTimeFromTimer = useTimer(
    isTimerActive,
    timerResetKey,
    isTimerActive && isToolExecuting,
  );

  const isPhraseCyclingActive = streamingState === StreamingState.Responding;
  const isWaiting = streamingState === StreamingState.WaitingForConfirmation;
  const currentLoadingPhrase = usePhraseCycler(
    isPhraseCyclingActive,
    isWaiting,
    customWittyPhrases,
  );

  const [retainedElapsedTime, setRetainedElapsedTime] = useState(0);
  const [taskStartTokens, setTaskStartTokensState] = useState(0);
  const [taskStartStreamingChars, setTaskStartStreamingCharsState] =
    useState(0);
  const taskStartTokensRef = useRef(0);
  const taskStartStreamingCharsRef = useRef(0);
  const pauseStartTokensRef = useRef<number | null>(null);
  const pauseStartStreamingCharsRef = useRef<number | null>(null);
  const pauseBaseTaskStartTokensRef = useRef(0);
  const pauseBaseTaskStartStreamingCharsRef = useRef(0);
  const prevStreamingStateRef = useRef<StreamingState | null>(null);

  useEffect(() => {
    const currentTokens = currentCandidatesTokens ?? 0;
    const currentChars = currentStreamingChars ?? 0;
    const setTaskStartTokens = (tokens: number) => {
      if (taskStartTokensRef.current === tokens) {
        return;
      }
      taskStartTokensRef.current = tokens;
      setTaskStartTokensState(tokens);
    };
    const setTaskStartStreamingChars = (chars: number) => {
      if (taskStartStreamingCharsRef.current === chars) {
        return;
      }
      taskStartStreamingCharsRef.current = chars;
      setTaskStartStreamingCharsState(chars);
    };

    if (
      prevStreamingStateRef.current === StreamingState.WaitingForConfirmation &&
      streamingState === StreamingState.Responding
    ) {
      setTimerResetKey((prevKey) => prevKey + 1);
      setRetainedElapsedTime(0);
      setTaskStartTokens(currentTokens);
      setTaskStartStreamingChars(currentChars);
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
      setTaskStartTokens(currentTokens);
      setTaskStartStreamingChars(currentChars);
    } else if (streamingState === StreamingState.WaitingForConfirmation) {
      setRetainedElapsedTime(elapsedTimeFromTimer);
    }

    if (streamingState === StreamingState.Responding && isToolExecuting) {
      if (pauseStartTokensRef.current === null) {
        pauseStartTokensRef.current = currentTokens;
        pauseStartStreamingCharsRef.current = currentChars;
        pauseBaseTaskStartTokensRef.current = taskStartTokensRef.current;
        pauseBaseTaskStartStreamingCharsRef.current =
          taskStartStreamingCharsRef.current;
      }

      setTaskStartTokens(
        pauseBaseTaskStartTokensRef.current +
          Math.max(0, currentTokens - pauseStartTokensRef.current),
      );
      setTaskStartStreamingChars(
        pauseBaseTaskStartStreamingCharsRef.current +
          Math.max(
            0,
            currentChars - (pauseStartStreamingCharsRef.current ?? 0),
          ),
      );
    } else {
      pauseStartTokensRef.current = null;
      pauseStartStreamingCharsRef.current = null;
    }

    prevStreamingStateRef.current = streamingState;
  }, [
    streamingState,
    elapsedTimeFromTimer,
    currentCandidatesTokens,
    currentStreamingChars,
    isToolExecuting,
  ]);

  return {
    elapsedTime:
      streamingState === StreamingState.WaitingForConfirmation
        ? retainedElapsedTime
        : elapsedTimeFromTimer,
    currentLoadingPhrase,
    taskStartTokens,
    taskStartStreamingChars,
  };
};
