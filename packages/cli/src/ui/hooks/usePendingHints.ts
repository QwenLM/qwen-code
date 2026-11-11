/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Config, InjectionSource } from '@qwen-code/core';

export interface UsePendingHintsReturn {
  pendingHintCount: number;
  consumePendingHints: () => string | null;
}

/**
 * Buffers user_steering injections from the core injection service so the
 * input prompt can splice them into the next submission. background_completion
 * notifications go through `messageQueueManager` instead, so we ignore them
 * here.
 */
export function usePendingHints(config: Config): UsePendingHintsReturn {
  const pendingHintsRef = useRef<string[]>([]);
  const [pendingHintCount, setPendingHintCount] = useState(0);

  const consumePendingHints = useCallback(() => {
    if (pendingHintsRef.current.length === 0) {
      return null;
    }
    const hint = pendingHintsRef.current.join('\n');
    pendingHintsRef.current = [];
    setPendingHintCount(0);
    return hint;
  }, []);

  useEffect(() => {
    const hintListener = (text: string, source: InjectionSource) => {
      if (source !== 'user_steering') {
        return;
      }
      pendingHintsRef.current.push(text);
      setPendingHintCount((prev) => prev + 1);
    };
    config.injectionService.onInjection(hintListener);
    return () => {
      config.injectionService.offInjection(hintListener);
    };
  }, [config]);

  return { pendingHintCount, consumePendingHints };
}
