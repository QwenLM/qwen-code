/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import process from 'node:process';
import { type UseHistoryManagerReturn } from './useHistoryManager.js';

// Memory threshold for triggering automatic history trimming (5GB)
const MEMORY_TRIM_THRESHOLD = 5 * 1024 * 1024 * 1024;
// When trimming, keep only this many items
const TRIM_TO_HISTORY_SIZE = 50;

interface AutoTrimHistoryOptions {
  historyManager: UseHistoryManagerReturn;
}

export const useAutoTrimHistory = ({
  historyManager,
}: AutoTrimHistoryOptions) => {
  const checkIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Start memory monitoring interval
    checkIntervalRef.current = setInterval(() => {
      const usage = process.memoryUsage().rss;

      // If memory usage exceeds threshold, trim history
      if (usage > MEMORY_TRIM_THRESHOLD) {
        // Calculate how much memory we're over the threshold (in GB)
        const overThresholdGB =
          (usage - MEMORY_TRIM_THRESHOLD) / (1024 * 1024 * 1024);

        // Aggressively trim history based on how much over threshold we are
        // For every GB over threshold, reduce the preserved items by 10
        const preservedItems = Math.max(
          10,
          TRIM_TO_HISTORY_SIZE - Math.floor(overThresholdGB * 10),
        );

        historyManager.trimHistory(preservedItems);
      }
    }, 30000); // Check every 30 seconds

    // Clean up interval on unmount
    return () => {
      if (checkIntervalRef.current) {
        clearInterval(checkIntervalRef.current);
      }
    };
  }, [historyManager]);
};
