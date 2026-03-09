/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QualitativeInsights } from './QualitativeInsightTypes.js';

export interface HeatMapData {
  [date: string]: number;
}

export interface InsightData {
  heatmap: HeatMapData;
  currentStreak: number;
  longestStreak: number;
  longestWorkDate: string | null;
  longestWorkDuration: number; // in minutes
  activeHours: { [hour: number]: number };
  latestActiveTime: string | null;
  totalSessions?: number;
  totalMessages?: number;
  totalHours?: number;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  totalFiles?: number;
  topTools?: Array<[string, number]>;
  qualitative?: QualitativeInsights;
  satisfaction?: Record<string, number>;
  friction?: Record<string, number>;
  primarySuccess?: Record<string, number>;
  outcomes?: Record<string, number>;
  topGoals?: Record<string, number>;
}

export interface StreakData {
  currentStreak: number;
  longestStreak: number;
  dates: string[];
}

export interface SessionFacets {
  session_id: string;
  underlying_goal: string;
  goal_categories: Record<string, number>;
  outcome:
    | 'fully_achieved'
    | 'mostly_achieved'
    | 'partially_achieved'
    | 'not_achieved'
    | 'unclear_from_transcript';
  user_satisfaction_counts: Record<string, number>;
  Qwen_helpfulness:
    | 'unhelpful'
    | 'slightly_helpful'
    | 'moderately_helpful'
    | 'very_helpful'
    | 'essential';
  session_type:
    | 'single_task'
    | 'multi_task'
    | 'iterative_refinement'
    | 'exploration'
    | 'quick_question';
  friction_counts: Record<string, number>;
  friction_detail: string;
  primary_success:
    | 'none'
    | 'fast_accurate_search'
    | 'correct_code_edits'
    | 'good_explanations'
    | 'proactive_help'
    | 'multi_file_changes'
    | 'good_debugging';
  brief_summary: string;
}

export interface StaticInsightTemplateData {
  styles: string;
  content: string;
  data: InsightData;
  scripts: string;
  generatedTime: string;
}

export type InsightProgressCallback = (
  stage: string,
  progress: number,
  detail?: string,
) => void;
