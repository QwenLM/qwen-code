/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import process from 'node:process';
import os from 'node:os';
import v8 from 'v8';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { type HistoryItemWithoutId, MessageType } from '../types.js';

const debugLogger = createDebugLogger('MEMORY_MONITOR');

// Warn at the lower of 7 GB or 85% of system RAM — prevents OOM on
// machines with less than ~8 GB while keeping the threshold high enough
// on larger systems to avoid false positives.
export const MEMORY_WARNING_THRESHOLD = Math.min(
  7 * 1024 * 1024 * 1024,
  Math.floor(os.totalmem() * 0.85),
);
export const MEMORY_UI_COMPACT_THRESHOLD = () =>
  Math.floor(v8.getHeapStatistics().heap_size_limit * 0.65);
export const MEMORY_CHECK_INTERVAL = 60 * 1000; // one minute
export const MEMORY_DEBUG_INTERVAL = 30 * 1000; // 30 seconds for debug logging
export const UI_COMPACT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

interface MemoryMonitorOptions {
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
  compactOldItems?: () => void;
}

export const useMemoryMonitor = ({
  addItem,
  compactOldItems,
}: MemoryMonitorOptions) => {
  const lastCompactRef = useRef(0);

  useEffect(() => {
    // Debug logging + UI compaction interval — runs every 30 s, never cleared.
    // UI compaction lives here (not in the warning interval) because the
    // warning interval self-destructs via clearInterval once RSS exceeds 7 GB,
    // which would also kill the compaction check.
    const debugIntervalId = setInterval(() => {
      const memUsage = process.memoryUsage();
      const heapUsed = memUsage.heapUsed / 1024 / 1024;
      const heapTotal = memUsage.heapTotal / 1024 / 1024;
      const rss = memUsage.rss / 1024 / 1024;
      const external = memUsage.external / 1024 / 1024;
      const arrayBuffers = memUsage.arrayBuffers / 1024 / 1024;

      if (debugLogger.isEnabled()) {
        debugLogger.debug(
          `[MEMORY_USAGE] ` +
            `heapUsed=${heapUsed.toFixed(1)}MB, ` +
            `heapTotal=${heapTotal.toFixed(1)}MB, ` +
            `rss=${rss.toFixed(1)}MB, ` +
            `external=${external.toFixed(1)}MB, ` +
            `arrayBuffers=${arrayBuffers.toFixed(1)}MB, ` +
            `heapUtilization=${((heapUsed / heapTotal) * 100).toFixed(1)}%`,
        );
      }

      // UI history compaction when heap exceeds threshold
      const now = Date.now();
      if (
        compactOldItems &&
        memUsage.heapUsed > MEMORY_UI_COMPACT_THRESHOLD() &&
        now - lastCompactRef.current > UI_COMPACT_COOLDOWN_MS
      ) {
        lastCompactRef.current = now;
        if (debugLogger.isEnabled()) {
          debugLogger.debug(
            `[UI_COMPACT] heapUsed=${heapUsed.toFixed(1)}MB ` +
              `exceeds ${(MEMORY_UI_COMPACT_THRESHOLD() / 1024 / 1024).toFixed(0)}MB threshold, ` +
              `compacting UI history`,
          );
        }
        try {
          compactOldItems();
        } catch (err) {
          debugLogger.error(
            `[UI_COMPACT] compactOldItems failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }, MEMORY_DEBUG_INTERVAL);

    // Warning interval — warns once then self-destructs.
    const warningIntervalId = setInterval(() => {
      const usage = process.memoryUsage();

      if (usage.rss > MEMORY_WARNING_THRESHOLD) {
        debugLogger.warn(
          `[MEMORY_WARNING] High memory usage detected: ${(usage.rss / (1024 * 1024 * 1024)).toFixed(2)} GB`,
        );
        addItem(
          {
            type: MessageType.WARNING,
            text:
              `High memory usage detected: ${(
                usage.rss /
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
  }, [addItem, compactOldItems]);
};
