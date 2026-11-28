/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import {
  WarningPriority,
  type StartupWarning,
} from '@qwen-code/core';
import { persistentState } from '../../utils/persistentState.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';

const MAX_LOW_PRIORITY_SHOW_COUNT = 3;

/**
 * Adds startup warnings to the conversation history once per UI session.
 *
 * Startup warnings are passive history entries: they must not take keyboard
 * focus or consume the first key the user types after launch.
 *
 * Low-priority warnings retain the existing cross-session display limit. High
 * priority warnings are shown once whenever a new UI session starts.
 */
export function useStartupWarningHistory(
  warnings: readonly StartupWarning[],
  addItem: (item: HistoryItemWithoutId, baseTimestamp?: number) => number,
): void {
  const handledWarningIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (warnings.length === 0) {
      return;
    }

    const counts = {
      ...(persistentState.get('startupWarningCounts') ?? {}),
    };
    let countsChanged = false;

    for (const warning of warnings) {
      if (handledWarningIdsRef.current.has(warning.id)) {
        continue;
      }
      handledWarningIdsRef.current.add(warning.id);

      if (warning.priority === WarningPriority.Low) {
        const showCount = counts[warning.id] ?? 0;
        if (showCount >= MAX_LOW_PRIORITY_SHOW_COUNT) {
          continue;
        }
        counts[warning.id] = showCount + 1;
        countsChanged = true;
      }

      addItem({
        type: MessageType.WARNING,
        text: warning.message,
      });
    }

    if (countsChanged) {
      persistentState.set('startupWarningCounts', counts);
    }
  }, [addItem, warnings]);
}
