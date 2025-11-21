/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import process from 'node:process';
import { type HistoryItemWithoutId, MessageType } from '../types.js';

export const DEFAULT_MEMORY_WARNING_THRESHOLD = 7 * 1024 * 1024 * 1024; // 7GB in bytes
export const MEMORY_CHECK_INTERVAL = 60 * 1000; // one minute
export const MEMORY_WARNING_THRESHOLD_HIGH = 10 * 1024 * 1024 * 1024; // 10GB in bytes

interface MemoryMonitorOptions {
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
}

export const useMemoryMonitor = ({ addItem }: MemoryMonitorOptions) => {
  // Use the default memory warning threshold
  const memoryWarningThreshold = DEFAULT_MEMORY_WARNING_THRESHOLD;

  useEffect(() => {
    const intervalId = setInterval(() => {
      const usage = process.memoryUsage().rss;

      // Warn at the configured threshold
      if (
        usage > memoryWarningThreshold &&
        usage <= MEMORY_WARNING_THRESHOLD_HIGH
      ) {
        addItem(
          {
            type: MessageType.WARNING,
            text:
              `High memory usage detected: ${(
                usage /
                (1024 * 1024 * 1024)
              ).toFixed(2)} GB. ` +
              'Consider clearing history or reducing the session length to free up memory.',
          },
          Date.now(),
        );
      }
      // Critical warning at higher threshold
      else if (usage > MEMORY_WARNING_THRESHOLD_HIGH) {
        addItem(
          {
            type: MessageType.ERROR,
            text:
              `Critical memory usage detected: ${(
                usage /
                (1024 * 1024 * 1024)
              ).toFixed(2)} GB. ` +
              'The application may become unstable. Please clear history or restart the application.',
          },
          Date.now(),
        );
      }
    }, MEMORY_CHECK_INTERVAL);

    return () => clearInterval(intervalId);
  }, [addItem, memoryWarningThreshold]);
};
