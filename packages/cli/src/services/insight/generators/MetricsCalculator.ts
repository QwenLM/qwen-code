/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  read as readJsonlFile,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import type {
  InsightData,
  HeatMapData,
  StreakData,
  InsightProgressCallback,
} from '../types/StaticInsightTypes.js';

const logger = createDebugLogger('MetricsCalculator');

/**
 * Calculates quantitative metrics from chat history files:
 * heatmaps, streaks, active hours, tool usage, session durations, etc.
 */
export class MetricsCalculator {
  // Helper function to format date as YYYY-MM-DD
  formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // Calculate streaks from activity dates
  calculateStreaks(dates: string[]): StreakData {
    if (dates.length === 0) {
      return { currentStreak: 0, longestStreak: 0, dates: [] };
    }

    // Convert string dates to Date objects and sort them
    const dateObjects = dates.map((dateStr) => new Date(dateStr));
    dateObjects.sort((a, b) => a.getTime() - b.getTime());

    let currentStreak = 1;
    let maxStreak = 1;
    let currentDate = new Date(dateObjects[0]);
    currentDate.setHours(0, 0, 0, 0); // Normalize to start of day

    for (let i = 1; i < dateObjects.length; i++) {
      const nextDate = new Date(dateObjects[i]);
      nextDate.setHours(0, 0, 0, 0); // Normalize to start of day

      // Calculate difference in days
      const diffDays = Math.floor(
        (nextDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60 * 24),
      );

      if (diffDays === 1) {
        // Consecutive day
        currentStreak++;
        maxStreak = Math.max(maxStreak, currentStreak);
      } else if (diffDays > 1) {
        // Gap in streak
        currentStreak = 1;
      }
      // If diffDays === 0, same day, so streak continues

      currentDate = nextDate;
    }

    // Check if the streak is still ongoing (if last activity was yesterday or today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (
      currentDate.getTime() === today.getTime() ||
      currentDate.getTime() === yesterday.getTime()
    ) {
      // The streak might still be active, so we don't reset it
    }

    return {
      currentStreak,
      longestStreak: maxStreak,
      dates,
    };
  }

  async generateMetrics(
    files: Array<{ path: string; mtime: number }>,
    onProgress?: InsightProgressCallback,
  ): Promise<Omit<InsightData, 'facets' | 'qualitative'>> {
    // Initialize data structures
    const heatmap: HeatMapData = {};
    const activeHours: { [hour: number]: number } = {};
    const sessionStartTimes: { [sessionId: string]: Date } = {};
    const sessionEndTimes: { [sessionId: string]: Date } = {};
    let totalMessages = 0;
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;
    const uniqueFiles = new Set<string>();
    const toolUsage: Record<string, number> = {};

    // Process files in batches to avoid OOM and blocking the event loop
    const BATCH_SIZE = 50;
    const totalFiles = files.length;

    for (let i = 0; i < totalFiles; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, totalFiles);
      const batch = files.slice(i, batchEnd);

      // Process batch sequentially to minimize memory usage
      for (const fileInfo of batch) {
        try {
          const records = await readJsonlFile<ChatRecord>(fileInfo.path);

          // Process each record
          for (const record of records) {
            const timestamp = new Date(record.timestamp);
            const dateKey = this.formatDate(timestamp);
            const hour = timestamp.getHours();

            // Count user messages and slash commands (actual user interactions)
            const isUserMessage = record.type === 'user';
            const isSlashCommand =
              record.type === 'system' && record.subtype === 'slash_command';
            if (isUserMessage || isSlashCommand) {
              totalMessages++;

              // Update heatmap (count of user interactions per day)
              heatmap[dateKey] = (heatmap[dateKey] || 0) + 1;

              // Update active hours
              activeHours[hour] = (activeHours[hour] || 0) + 1;
            }

            // Track session times
            if (!sessionStartTimes[record.sessionId]) {
              sessionStartTimes[record.sessionId] = timestamp;
            }
            sessionEndTimes[record.sessionId] = timestamp;

            // Track tool usage
            if (record.type === 'assistant' && record.message?.parts) {
              for (const part of record.message.parts) {
                if ('functionCall' in part) {
                  const name = part.functionCall!.name!;
                  toolUsage[name] = (toolUsage[name] || 0) + 1;
                }
              }
            }

            // Track lines and files from tool results
            if (
              record.type === 'tool_result' &&
              record.toolCallResult?.resultDisplay
            ) {
              const display = record.toolCallResult.resultDisplay;
              // Check if it matches FileDiff shape
              if (
                typeof display === 'object' &&
                display !== null &&
                'fileName' in display
              ) {
                // Cast to any to avoid importing FileDiff type which might not be available here
                const diff = display as {
                  fileName: unknown;
                  diffStat?: {
                    model_added_lines?: number;
                    model_removed_lines?: number;
                  };
                };
                if (typeof diff.fileName === 'string') {
                  uniqueFiles.add(diff.fileName);
                }

                if (diff.diffStat) {
                  totalLinesAdded += diff.diffStat.model_added_lines || 0;
                  totalLinesRemoved += diff.diffStat.model_removed_lines || 0;
                }
              }
            }
          }
        } catch (error) {
          logger.error(
            `Failed to process metrics for file ${fileInfo.path}:`,
            error,
          );
          // Continue to next file
        }
      }

      // Update progress (mapped to 10-20% range of total progress)
      if (onProgress) {
        const percentComplete = batchEnd / totalFiles;
        const overallProgress = 10 + Math.round(percentComplete * 10);
        onProgress(
          `Crunching the numbers (${batchEnd}/${totalFiles})`,
          overallProgress,
        );
      }

      // Yield to event loop to allow GC and UI updates
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    // Calculate streak data
    const streakData = this.calculateStreaks(Object.keys(heatmap));

    // Calculate longest work session and total hours
    let longestWorkDuration = 0;
    let longestWorkDate: string | null = null;
    let totalDurationMs = 0;

    const sessionIds = Object.keys(sessionStartTimes);
    const totalSessions = sessionIds.length;

    for (const sessionId of sessionIds) {
      const start = sessionStartTimes[sessionId];
      const end = sessionEndTimes[sessionId];
      const durationMs = end.getTime() - start.getTime();
      const durationMinutes = Math.round(durationMs / (1000 * 60));

      totalDurationMs += durationMs;

      if (durationMinutes > longestWorkDuration) {
        longestWorkDuration = durationMinutes;
        longestWorkDate = this.formatDate(start);
      }
    }

    const totalHours = Math.round(totalDurationMs / (1000 * 60 * 60));

    // Calculate latest active time
    let latestActiveTime: string | null = null;
    let latestTimestamp = new Date(0);
    for (const dateStr in heatmap) {
      const date = new Date(dateStr);
      if (date > latestTimestamp) {
        latestTimestamp = date;
        latestActiveTime = date.toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
      }
    }

    // Calculate top tools
    const topTools = Object.entries(toolUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

    return {
      heatmap,
      currentStreak: streakData.currentStreak,
      longestStreak: streakData.longestStreak,
      longestWorkDate,
      longestWorkDuration,
      activeHours,
      latestActiveTime,
      totalSessions,
      totalMessages,
      totalHours,
      topTools,
      totalLinesAdded,
      totalLinesRemoved,
      totalFiles: uniqueFiles.size,
    };
  }
}
