/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * U-7/G-2: follow-up suggestion generation, ported from ink's effect in
 * AppContainer. The entry owns the streaming edges (the shell deliberately
 * holds no stream state), so this hook runs there and publishes the finished
 * suggestion through the shell to the composer as the ghost placeholder.
 */

import { useEffect, useRef, useState } from 'react';
import {
  ApprovalMode,
  PromptSuggestionEvent,
  generatePromptSuggestion,
  logPromptSuggestion,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { WaitingCallInfo } from './live-session.js';
import type { LiveHistoryItem } from './live-session-model.js';

export interface FollowupGenerationParams {
  config: Config;
  settings: LoadedSettings;
  streaming: boolean;
  items: readonly LiveHistoryItem[];
  waitingCalls: readonly WaitingCallInfo[];
}

export function useFollowupSuggestionGeneration({
  config,
  settings,
  streaming,
  items,
  waitingCalls,
}: FollowupGenerationParams): {
  promptSuggestion: string | null;
  dismissPromptSuggestion: () => void;
} {
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(streaming);

  useEffect(() => {
    const wasStreaming = streamingRef.current;

    // ink clears on a disabled feature and on every turn boundary: a new
    // turn invalidates the previous suggestion.
    if (
      settings.merged.ui?.enableFollowupSuggestions === false ||
      wasStreaming !== streaming
    ) {
      abortRef.current?.abort();
      setPromptSuggestion(null);
    }

    // Responding→Idle edge with ink's gate set. Slash dialogs the shell
    // opened mid-turn are invisible here (shell state); while one is open
    // the composer is unmounted, and the next turn boundary clears anyway.
    if (
      settings.merged.ui?.enableFollowupSuggestions !== false &&
      config.isInteractive() &&
      !config.getSdkMode() &&
      wasStreaming &&
      !streaming &&
      items[items.length - 1]?.kind !== 'error' &&
      waitingCalls.length === 0 &&
      config.getApprovalMode() !== ApprovalMode.PLAN
    ) {
      const ac = new AbortController();
      abortRef.current = ac;
      // Only clone the tail — a full structuredClone of a large resumed
      // session causes transient heap peaks that trigger OOM (#4624).
      const conversationHistory = config
        .getLlmClient()
        .getHistoryTail(40, true);
      generatePromptSuggestion(config, conversationHistory, ac.signal, {
        enableCacheSharing: settings.merged.ui?.enableCacheSharing !== false,
      })
        .then((result) => {
          if (ac.signal.aborted) return;
          if (result.suggestion) {
            setPromptSuggestion(result.suggestion);
          } else if (result.filterReason) {
            logPromptSuggestion(
              config,
              new PromptSuggestionEvent({
                outcome: 'suppressed',
                reason: result.filterReason,
              }),
            );
          }
        })
        .catch(() => {
          // Silently degrade — don't disrupt the user experience.
        });
    }

    streamingRef.current = streaming;
  }, [config, settings, streaming, items, waitingCalls]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  return {
    promptSuggestion,
    dismissPromptSuggestion: () => setPromptSuggestion(null),
  };
}
