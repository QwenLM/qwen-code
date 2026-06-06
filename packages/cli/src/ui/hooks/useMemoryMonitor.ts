/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import process from 'node:process';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { type HistoryItemWithoutId, MessageType } from '../types.js';

const debugLogger = createDebugLogger('MEMORY_MONITOR');

export const MEMORY_WARNING_THRESHOLD = 7 * 1024 * 1024 * 1024; // 7GB in bytes
export const MEMORY_CHECK_INTERVAL = 60 * 1000; // one minute
export const MEMORY_DEBUG_INTERVAL = 30 * 1000; // 30 seconds for debug logging

interface MemoryMonitorOptions {
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
}

export const useMemoryMonitor = ({ addItem }: MemoryMonitorOptions) => {
  useEffect(() => {
    // Debug logging interval - logs memory usage every 30 seconds
    const debugIntervalId = setInterval(() => {
      const memUsage = process.memoryUsage();
      const heapUsed = memUsage.heapUsed / 1024 / 1024;
      const heapTotal = memUsage.heapTotal / 1024 / 1024;
      const rss = memUsage.rss / 1024 / 1024;
      const external = memUsage.external / 1024 / 1024;
      const arrayBuffers = memUsage.arrayBuffers / 1024 / 1024;

      debugLogger.debug(
        `[MEMORY_USAGE] ` +
          `heapUsed=${heapUsed.toFixed(1)}MB, ` +
          `heapTotal=${heapTotal.toFixed(1)}MB, ` +
          `rss=${rss.toFixed(1)}MB, ` +
          `external=${external.toFixed(1)}MB, ` +
          `arrayBuffers=${arrayBuffers.toFixed(1)}MB, ` +
          `heapUtilization=${((heapUsed / heapTotal) * 100).toFixed(1)}%`,
      );
    }, MEMORY_DEBUG_INTERVAL);

    // Warning interval - warns user if memory exceeds threshold
    const warningIntervalId = setInterval(() => {
      const usage = process.memoryUsage().rss;
      if (usage > MEMORY_WARNING_THRESHOLD) {
        debugLogger.warn(
          `[MEMORY_WARNING] High memory usage detected: ${(usage / (1024 * 1024 * 1024)).toFixed(2)} GB`,
        );
        addItem(
          {
            type: MessageType.WARNING,
            text:
              `High memory usage detected: ${(
                usage /
                (1024 * 1024 * 1024)
              ).toFixed(2)} GB. ` +
              'If you experience a crash, please file a bug report by running `/bug`',
          },
          Date.now(),
        );
        clearInterval(warningIntervalId);
      }
    }, MEMORY_CHECK_INTERVAL);

    return () => {
      clearInterval(debugIntervalId);
      clearInterval(warningIntervalId);
    };
  }, [addItem]);
};
