/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { StreamingState } from '../types.js';
import { useTimer } from './useTimer.js';
import { usePhraseCycler } from './usePhraseCycler.js';
import { useState, useEffect, useRef } from 'react';
import type { RetryAttemptPayload, UiLocale } from '@qwen-code/core';
import { useI18nService } from '../i18n/I18nServiceContext.js';

const LOW_VERBOSITY_RETRY_HINT_ATTEMPT_THRESHOLD = 2;

export interface UseLoadingIndicatorProps {
  streamingState: StreamingState;
  retryStatus: RetryAttemptPayload | null;
  showTips?: boolean;
  showWit?: boolean;
  customWittyPhrases?: string[];
  errorVerbosity?: 'low' | 'full';
  maxLength?: number;
  additionalTips?: readonly string[];
  locale?: UiLocale;
}

export const useLoadingIndicator = ({
  streamingState,
  retryStatus,
  showTips = true,
  showWit = false,
  customWittyPhrases,
  errorVerbosity = 'full',
  maxLength,
  additionalTips,
  locale = 'en',
}: UseLoadingIndicatorProps) => {
  const i18n = useI18nService();
  const [timerResetKey, setTimerResetKey] = useState(0);
  const isTimerActive = streamingState === StreamingState.Responding;

  const elapsedTimeFromTimer = useTimer(isTimerActive, timerResetKey);

  const isPhraseCyclingActive = streamingState === StreamingState.Responding;
  const isWaiting = streamingState === StreamingState.WaitingForConfirmation;

  const { currentTip, currentWittyPhrase } = usePhraseCycler(
    isPhraseCyclingActive,
    isWaiting,
    showTips,
    showWit,
    customWittyPhrases,
    maxLength,
    additionalTips,
    locale,
  );

  const prevStreamingStateRef = useRef<StreamingState | null>(null);

  useEffect(() => {
    if (
      streamingState === StreamingState.Idle &&
      prevStreamingStateRef.current !== null &&
      prevStreamingStateRef.current !== StreamingState.Idle
    ) {
      setTimerResetKey((prevKey) => prevKey + 1);
    }

    prevStreamingStateRef.current = streamingState;
  }, [streamingState]);

  const retryPhrase =
    streamingState === StreamingState.Responding && retryStatus
      ? errorVerbosity === 'low'
        ? retryStatus.attempt >= LOW_VERBOSITY_RETRY_HINT_ATTEMPT_THRESHOLD
          ? i18n.get('status.retry.slow')
          : null
        : i18n.get('status.retry.attempt', {
            model: retryStatus.model,
            attempt: retryStatus.attempt + 1,
            maxAttempts: retryStatus.maxAttempts,
          })
      : null;

  return {
    elapsedTime: elapsedTimeFromTimer,
    currentLoadingPhrase: retryPhrase || currentTip || currentWittyPhrase,
    currentTip,
    currentWittyPhrase,
  };
};
