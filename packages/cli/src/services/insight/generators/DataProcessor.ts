/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { read as readJsonlFile } from '@qwen-code/qwen-code-core';
import type {
  InsightData,
  HeatMapData,
  TokenUsageData,
  AchievementData,
  StreakData,
} from '../types/StaticInsightTypes.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core';

export class DataProcessor {
  // Helper function to format date as YYYY-MM-DD
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // Calculate streaks from activity dates
  private calculateStreaks(dates: string[]): StreakData {
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

  // Calculate achievements based on user behavior
  private calculateAchievements(
    activeHours: { [hour: number]: number },
    heatmap: HeatMapData,
    _tokenUsage: TokenUsageData,
  ): AchievementData[] {
    const achievements: AchievementData[] = [];

    // Total activities
    const totalActivities = Object.values(heatmap).reduce(
      (sum, count) => sum + count,
      0,
    );

    // Total sessions
    const totalSessions = Object.keys(heatmap).length;

    // Calculate percentage of activity per hour
    const totalHourlyActivity = Object.values(activeHours).reduce(
      (sum, count) => sum + count,
      0,
    );

    if (totalHourlyActivity > 0) {
      // Midnight debugger: 20% of sessions happen between 12AM-5AM
      const midnightActivity =
        (activeHours[0] || 0) +
        (activeHours[1] || 0) +
        (activeHours[2] || 0) +
        (activeHours[3] || 0) +
        (activeHours[4] || 0) +
        (activeHours[5] || 0);

      if (midnightActivity / totalHourlyActivity >= 0.2) {
        achievements.push({
          id: 'midnight-debugger',
          name: 'Midnight Debugger',
          description: '20% of your sessions happen between 12AM-5AM',
        });
      }

      // Morning coder: 20% of sessions happen between 6AM-9AM
      const morningActivity =
        (activeHours[6] || 0) +
        (activeHours[7] || 0) +
        (activeHours[8] || 0) +
        (activeHours[9] || 0);

      if (morningActivity / totalHourlyActivity >= 0.2) {
        achievements.push({
          id: 'morning-coder',
          name: 'Morning Coder',
          description: '20% of your sessions happen between 6AM-9AM',
        });
      }
    }

    // Patient king: average conversation length >= 10 exchanges
    if (totalSessions > 0) {
      const avgExchanges = totalActivities / totalSessions;
      if (avgExchanges >= 10) {
        achievements.push({
          id: 'patient-king',
          name: 'Patient King',
          description: 'Your average conversation length is 10+ exchanges',
        });
      }
    }

    // Quick finisher: 70% of sessions have <= 2 exchanges
    let quickSessions = 0;
    // Since we don't have per-session exchange counts easily available,
    // we'll estimate based on the distribution of activities
    if (totalSessions > 0) {
      // This is a simplified calculation - in a real implementation,
      // we'd need to count exchanges per session
      const avgPerSession = totalActivities / totalSessions;
      if (avgPerSession <= 2) {
        // Estimate based on low average
        quickSessions = Math.floor(totalSessions * 0.7);
      }

      if (quickSessions / totalSessions >= 0.7) {
        achievements.push({
          id: 'quick-finisher',
          name: 'Quick Finisher',
          description: '70% of your sessions end in 2 exchanges or fewer',
        });
      }
    }

    // Explorer: for users with insufficient data or default
    if (achievements.length === 0) {
      achievements.push({
        id: 'explorer',
        name: 'Explorer',
        description: 'Getting started with Qwen Code',
      });
    }

    return achievements;
  }

  // Process chat files from all projects in the base directory and generate insights
  async generateInsights(baseDir: string): Promise<InsightData> {
    // Initialize data structures
    const heatmap: HeatMapData = {};
    const tokenUsage: TokenUsageData = {};
    const activeHours: { [hour: number]: number } = {};
    const sessionStartTimes: { [sessionId: string]: Date } = {};
    const sessionEndTimes: { [sessionId: string]: Date } = {};

    try {
      // Get all project directories in the base directory
      const projectDirs = await fs.readdir(baseDir);

      // Process each project directory
      for (const projectDir of projectDirs) {
        const projectPath = path.join(baseDir, projectDir);
        const stats = await fs.stat(projectPath);

        // Only process if it's a directory
        if (stats.isDirectory()) {
          const chatsDir = path.join(projectPath, 'chats');

          let chatFiles: string[] = [];
          try {
            // Get all chat files in the chats directory
            const files = await fs.readdir(chatsDir);
            chatFiles = files.filter((file) => file.endsWith('.jsonl'));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.log(
                `Error reading chats directory for project ${projectDir}: ${error}`,
              );
            }
            // Continue to next project if chats directory doesn't exist
            continue;
          }

          // Process each chat file in this project
          for (const file of chatFiles) {
            const filePath = path.join(chatsDir, file);
            const records = await readJsonlFile<ChatRecord>(filePath);

            // Process each record
            for (const record of records) {
              const timestamp = new Date(record.timestamp);
              const dateKey = this.formatDate(timestamp);
              const hour = timestamp.getHours();

              // Update heatmap (count of interactions per day)
              heatmap[dateKey] = (heatmap[dateKey] || 0) + 1;

              // Update active hours
              activeHours[hour] = (activeHours[hour] || 0) + 1;

              // Update token usage
              if (record.usageMetadata) {
                const usage = tokenUsage[dateKey] || {
                  input: 0,
                  output: 0,
                  total: 0,
                };

                usage.input += record.usageMetadata.promptTokenCount || 0;
                usage.output += record.usageMetadata.candidatesTokenCount || 0;
                usage.total += record.usageMetadata.totalTokenCount || 0;

                tokenUsage[dateKey] = usage;
              }

              // Track session times
              if (!sessionStartTimes[record.sessionId]) {
                sessionStartTimes[record.sessionId] = timestamp;
              }
              sessionEndTimes[record.sessionId] = timestamp;
            }
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Base directory doesn't exist, return empty insights
        console.log(`Base directory does not exist: ${baseDir}`);
      } else {
        console.log(`Error reading base directory: ${error}`);
      }
    }

    // Calculate streak data
    const streakData = this.calculateStreaks(Object.keys(heatmap));

    // Calculate longest work session
    let longestWorkDuration = 0;
    let longestWorkDate: string | null = null;
    for (const sessionId in sessionStartTimes) {
      const start = sessionStartTimes[sessionId];
      const end = sessionEndTimes[sessionId];
      const durationMinutes = Math.round(
        (end.getTime() - start.getTime()) / (1000 * 60),
      );

      if (durationMinutes > longestWorkDuration) {
        longestWorkDuration = durationMinutes;
        longestWorkDate = this.formatDate(start);
      }
    }

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

    // Calculate achievements
    const achievements = this.calculateAchievements(
      activeHours,
      heatmap,
      tokenUsage,
    );

    return {
      heatmap,
      tokenUsage,
      currentStreak: streakData.currentStreak,
      longestStreak: streakData.longestStreak,
      longestWorkDate,
      longestWorkDuration,
      activeHours,
      latestActiveTime,
      achievements,
    };
  }
}
