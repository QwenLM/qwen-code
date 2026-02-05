/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { read as readJsonlFile } from '@qwen-code/qwen-code-core';
import pLimit from 'p-limit';
import type { Config, ChatRecord } from '@qwen-code/qwen-code-core';
import type {
  InsightData,
  HeatMapData,
  TokenUsageData,
  AchievementData,
  StreakData,
  SessionFacets,
} from '../types/StaticInsightTypes.js';

// Prompt content from prompt.txt
const ANALYSIS_PROMPT = `Analyze this Qwen Code session and extract structured facets.

CRITICAL GUIDELINES:

1. **goal_categories**: Count ONLY what the USER explicitly asked for.
   - DO NOT count Qwen's autonomous codebase exploration
   - DO NOT count work Qwen decided to do on its own
   - ONLY count when user says "can you...", "please...", "I need...", "let's..."

2. **user_satisfaction_counts**: Base ONLY on explicit user signals.
   - "Yay!", "great!", "perfect!" → happy
   - "thanks", "looks good", "that works" → satisfied
   - "ok, now let's..." (continuing without complaint) → likely_satisfied
   - "that's not right", "try again" → dissatisfied
   - "this is broken", "I give up" → frustrated

3. **friction_counts**: Be specific about what went wrong.
   - misunderstood_request: Qwen interpreted incorrectly
   - wrong_approach: Right goal, wrong solution method
   - buggy_code: Code didn't work correctly
   - user_rejected_action: User said no/stop to a tool call
   - excessive_changes: Over-engineered or changed too much

4. If very short or just warmup, use warmup_minimal for goal_category`;

const INSIGHT_SCHEMA = {
  type: 'object',
  properties: {
    underlying_goal: {
      type: 'string',
      description: 'What the user fundamentally wanted to achieve',
    },
    goal_categories: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    outcome: {
      type: 'string',
      enum: [
        'fully_achieved',
        'mostly_achieved',
        'partially_achieved',
        'not_achieved',
        'unclear_from_transcript',
      ],
    },
    user_satisfaction_counts: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    Qwen_helpfulness: {
      type: 'string',
      enum: [
        'unhelpful',
        'slightly_helpful',
        'moderately_helpful',
        'very_helpful',
        'essential',
      ],
    },
    session_type: {
      type: 'string',
      enum: [
        'single_task',
        'multi_task',
        'iterative_refinement',
        'exploration',
        'quick_question',
      ],
    },
    friction_counts: {
      type: 'object',
      additionalProperties: { type: 'number' },
    },
    friction_detail: {
      type: 'string',
      description: 'One sentence describing friction or empty',
    },
    primary_success: {
      type: 'string',
      enum: [
        'none',
        'fast_accurate_search',
        'correct_code_edits',
        'good_explanations',
        'proactive_help',
        'multi_file_changes',
        'good_debugging',
      ],
    },
    brief_summary: {
      type: 'string',
      description: 'One sentence: what user wanted and whether they got it',
    },
  },
  required: [
    'underlying_goal',
    'goal_categories',
    'outcome',
    'user_satisfaction_counts',
    'Qwen_helpfulness',
    'session_type',
    'friction_counts',
    'friction_detail',
    'primary_success',
    'brief_summary',
  ],
};

export class DataProcessor {
  constructor(private config: Config) {}

  // Helper function to format date as YYYY-MM-DD
  private formatDate(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  // Format chat records for LLM analysis
  private formatRecordsForAnalysis(records: ChatRecord[]): string {
    let output = '';
    const sessionStart =
      records.length > 0 ? new Date(records[0].timestamp) : new Date();

    output += `Session: ${records[0]?.sessionId || 'unknown'}\n`;
    output += `Date: ${sessionStart.toISOString()}\n`;
    output += `Duration: ${records.length} turns\n\n`;

    for (const record of records) {
      if (record.type === 'user') {
        const text =
          record.message?.parts
            ?.map((p) => ('text' in p ? p.text : ''))
            .join('') || '';
        output += `[User]: ${text}\n`;
      } else if (record.type === 'assistant') {
        if (record.message?.parts) {
          for (const part of record.message.parts) {
            if ('text' in part && part.text) {
              output += `[Assistant]: ${part.text}\n`;
            } else if ('functionCall' in part) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const call = (part as any).functionCall;
              if (call) {
                output += `[Tool: ${call.name}]\n`;
              }
            }
          }
        }
      }
    }
    return output;
  }

  // Analyze a single session using LLM
  private async analyzeSession(
    records: ChatRecord[],
  ): Promise<SessionFacets | null> {
    if (records.length === 0) return null;

    const sessionText = this.formatRecordsForAnalysis(records);
    const prompt = `${ANALYSIS_PROMPT}\n\nSESSION:\n${sessionText}`;

    try {
      const result = await this.config.getBaseLlmClient().generateJson({
        // Use the configured model
        model: this.config.getModel(),
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        schema: INSIGHT_SCHEMA,
        abortSignal: AbortSignal.timeout(60000), // 1 minute timeout per session
      });
      return {
        ...(result as unknown as SessionFacets),
        session_id: records[0].sessionId,
      };
    } catch (error) {
      console.error(
        `Failed to analyze session ${records[0]?.sessionId}:`,
        error,
      );
      return null;
    }
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
  async generateInsights(
    baseDir: string,
    facetsOutputDir?: string,
  ): Promise<InsightData> {
    // Initialize data structures
    const heatmap: HeatMapData = {};
    const tokenUsage: TokenUsageData = {};
    const activeHours: { [hour: number]: number } = {};
    const sessionStartTimes: { [sessionId: string]: Date } = {};
    const sessionEndTimes: { [sessionId: string]: Date } = {};

    // Store all valid chat file paths for LLM analysis
    const allChatFiles: Array<{ path: string; mtime: number }> = [];

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

            // Get file stats for sorting by recency
            try {
              const fileStats = await fs.stat(filePath);
              allChatFiles.push({ path: filePath, mtime: fileStats.mtimeMs });
            } catch (e) {
              console.error(`Failed to stat file ${filePath}:`, e);
            }

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

    // Sort files by recency (descending) and take top 50
    const recentFiles = allChatFiles
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 50);

    console.log(`Analyzing ${recentFiles.length} recent sessions with LLM...`);

    // Create a limit function with concurrency of 4 to avoid 429 errors
    const limit = pLimit(4);

    // Analyze sessions concurrently with limit
    const analysisPromises = recentFiles.map((fileInfo) =>
      limit(async () => {
        try {
          const records = await readJsonlFile<ChatRecord>(fileInfo.path);

          // Check if we already have this session analyzed
          if (records.length > 0 && facetsOutputDir) {
            const sessionId = records[0].sessionId;
            if (sessionId) {
              const existingFacetPath = path.join(
                facetsOutputDir,
                `${sessionId}.json`,
              );
              try {
                // Check if file exists and is readable
                const existingData = await fs.readFile(
                  existingFacetPath,
                  'utf-8',
                );
                const existingFacet = JSON.parse(existingData);
                return existingFacet;
              } catch (readError) {
                // File doesn't exist or is invalid, proceed to analyze
                if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') {
                  console.warn(
                    `Failed to read existing facet for ${sessionId}, regenerating:`,
                    readError,
                  );
                }
              }
            }
          }

          const facet = await this.analyzeSession(records);

          if (facet && facetsOutputDir) {
            try {
              const facetPath = path.join(
                facetsOutputDir,
                `${facet.session_id}.json`,
              );
              await fs.writeFile(
                facetPath,
                JSON.stringify(facet, null, 2),
                'utf-8',
              );
            } catch (writeError) {
              console.error(
                `Failed to write facet file for session ${facet.session_id}:`,
                writeError,
              );
            }
          }

          return facet;
        } catch (e) {
          console.error(`Error analyzing session file ${fileInfo.path}:`, e);
          return null;
        }
      }),
    );

    const sessionFacetsWithNulls = await Promise.all(analysisPromises);
    const facets = sessionFacetsWithNulls.filter(
      (f): f is SessionFacets => f !== null,
    );

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
      facets,
    };
  }
}
