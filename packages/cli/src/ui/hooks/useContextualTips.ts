/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook that evaluates contextual tips after each model response
 * and injects them as INFO messages into the conversation history.
 */

import { useEffect, useRef } from 'react';
import { type Config } from '@qwen-code/qwen-code-core';
import {
  StreamingState,
  MessageType,
  type HistoryItemWithoutId,
} from '../types.js';
import { t } from '../../i18n/index.js';
import {
  selectTip,
  tipRegistry,
  type TipContext,
  type TipHistory,
} from '../../services/tips/index.js';

const DEFAULT_TOKEN_LIMIT = 1_048_576;
const COMPRESSION_TOKEN_THRESHOLD = 0.7;

interface UseContextualTipsOptions {
  streamingState: StreamingState;
  lastPromptTokenCount: number;
  sessionPromptCount: number;
  config: Config;
  tipHistory: TipHistory | null;
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
  hideTips: boolean;
}

export function useContextualTips({
  streamingState,
  lastPromptTokenCount,
  sessionPromptCount,
  config,
  tipHistory,
  addItem,
  hideTips,
}: UseContextualTipsOptions): void {
  const prevStreamingState = useRef<StreamingState>(StreamingState.Idle);
  // Track whether the model was responding at any point before going idle,
  // so we catch Responding → WaitingForConfirmation → Idle transitions too.
  const hadResponsePhase = useRef(false);

  useEffect(() => {
    if (
      streamingState === StreamingState.Responding ||
      (prevStreamingState.current === StreamingState.Responding &&
        streamingState === StreamingState.WaitingForConfirmation)
    ) {
      hadResponsePhase.current = true;
    }

    const isNowIdle = streamingState === StreamingState.Idle;
    prevStreamingState.current = streamingState;

    // Only evaluate tips when transitioning to Idle after a response phase
    if (!hadResponsePhase.current || !isNowIdle) {
      return;
    }
    // Reset regardless of hideTips to prevent stale state accumulation
    hadResponsePhase.current = false;

    if (hideTips || !tipHistory) {
      return;
    }

    const contentGeneratorConfig = config.getContentGeneratorConfig();
    const contextWindowSize =
      contentGeneratorConfig?.contextWindowSize ?? DEFAULT_TOKEN_LIMIT;
    const compressionThreshold =
      config.getChatCompression()?.contextPercentageThreshold ??
      COMPRESSION_TOKEN_THRESHOLD;

    const tipContext: TipContext = {
      lastPromptTokenCount,
      contextWindowSize,
      compressionThreshold,
      sessionPromptCount,
      sessionCount: tipHistory.sessionCount,
      platform: process.platform,
    };

    const tip = selectTip('post-response', tipContext, tipRegistry, tipHistory);
    if (tip) {
      tipHistory.recordShown(tip.id, sessionPromptCount);
      addItem(
        {
          type: MessageType.INFO,
          text: `💡 ${t(tip.content)}`,
        },
        Date.now(),
      );
    }
  }, [
    streamingState,
    lastPromptTokenCount,
    sessionPromptCount,
    config,
    tipHistory,
    addItem,
    hideTips,
  ]);
}
