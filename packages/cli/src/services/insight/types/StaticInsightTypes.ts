/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

export interface UsageMetadata {
  input: number;
  output: number;
  total: number;
}

export interface HeatMapData {
  [date: string]: number;
}

export interface TokenUsageData {
  [date: string]: UsageMetadata;
}

export interface AchievementData {
  id: string;
  name: string;
  description: string;
}

export interface InsightData {
  heatmap: HeatMapData;
  tokenUsage: TokenUsageData;
  currentStreak: number;
  longestStreak: number;
  longestWorkDate: string | null;
  longestWorkDuration: number; // in minutes
  activeHours: { [hour: number]: number };
  latestActiveTime: string | null;
  achievements: AchievementData[];
}

export interface StreakData {
  currentStreak: number;
  longestStreak: number;
  dates: string[];
}

export interface StaticInsightTemplateData {
  styles: string;
  content: string;
  data: InsightData;
  scripts: string;
  generatedTime: string;
}
