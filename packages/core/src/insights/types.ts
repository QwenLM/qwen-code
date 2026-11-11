/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';

/** Cached lightweight metadata for a single transcript session. */
export interface SessionMeta {
  id: string;
  projectRoot: string;
  filePath: string;
  startTime: number;
  messageCount: number;
  userMessageCount: number;
  lastUpdated: number;
  displayName?: string;
  firstUserMessage?: string;
}

/** AI-extracted semantic facets for a single session. Cached per session. */
export interface SessionFacets {
  sessionId: string;
  topics: string[];
  languages: string[];
  intents: string[];
  entities: string[];
  sentiment: 'positive' | 'neutral' | 'negative';
  complexityEstimate: 'low' | 'medium' | 'high';
}

/** Rolled-up aggregated data across all scanned sessions. */
export interface AggregatedData {
  totalSessions: number;
  totalMessages: number;
  totalUserMessages: number;
  dateRange: { start: number; end: number };
  topicCounts: Map<string, number>;
  languageCounts: Map<string, number>;
  intentCounts: Map<string, number>;
  hourlyDistribution: number[];
  dailyDistribution: Map<string, number>;
  complexityDistribution: { low: number; medium: number; high: number };
}

/** LLM-generated insight results. */
export interface InsightResults {
  summary: string;
  atAGlance: AtAGlance;
  topTopics: Array<{ name: string; count: number; description: string }>;
  topLanguages: Array<{ name: string; count: number; percentage: number }>;
  activityPatterns: string;
  productivityTips: string[];
  trends: string;
}

/** Second-stage synthesized "At a Glance" overview. */
export interface AtAGlance {
  whatsWorking: string;
  whatsHindering: string;
  quickWins: string[];
  ambitiousWorkflows: string[];
}

/** Options passed from the command layer to the core insights pipeline. */
export interface GenerateInsightsOptions {
  config: Config;
  cwd: string;
  abortSignal: AbortSignal;
  onProgress: (phase: string, detail: string) => void;
  lookbackDays?: number;
  /** 报告标题/页脚使用的产品显示名；缺省为通用的 "CLI"。 */
  productName?: string;
  /** 报告页脚可选的产品链接；不传则不渲染链接。 */
  footerLink?: string;
}

/** The final public API return type. */
export interface InsightsReport {
  htmlPath: string;
  aggregated: AggregatedData;
  insights: InsightResults;
}
