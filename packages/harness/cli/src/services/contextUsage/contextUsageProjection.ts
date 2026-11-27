/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillSource } from '@qwen-code/core';
import {
  calculateContextPercentage,
  type ContextUsageCategoryType,
  type ContextUsageSnapshot,
} from './contextUsageCollector.js';

export interface ContextUsageResponseCategory {
  type: ContextUsageCategoryType;
  percentage: number;
}

export interface ContextUsageResponseSkill {
  name: string;
  source: SkillSource;
  percentageOfContext: number;
}

export interface ContextUsageResponse extends Record<string, unknown> {
  model: string;
  contextWindow: {
    usedPercentage: number;
  };
  categories: ContextUsageResponseCategory[];
  autoCompact: {
    enabled: boolean;
    thresholdPercentage: number;
  };
  skills: {
    count: number;
    percentageOfContext: number;
    items: ContextUsageResponseSkill[];
  };
  duplicateFileReads: Array<{
    path: string;
    count: number;
  }>;
  session: ContextUsageSnapshot['session'];
}

export function projectContextUsageForSdk(
  snapshot: ContextUsageSnapshot,
): ContextUsageResponse {
  const contextWindowTokens = snapshot.rawContextWindowTokens;

  return {
    model: snapshot.model,
    contextWindow: {
      usedPercentage: calculateContextPercentage(
        snapshot.tokenUsage,
        contextWindowTokens,
      ),
    },
    categories: snapshot.categories.map((category) => ({
      type: category.type,
      percentage: category.percentage,
    })),
    autoCompact: {
      enabled: snapshot.autoCompactEnabled,
      thresholdPercentage: calculateContextPercentage(
        snapshot.autoCompactThresholdTokens,
        contextWindowTokens,
      ),
    },
    skills: {
      count: snapshot.skillDetails.length,
      percentageOfContext: calculateContextPercentage(
        snapshot.skillFrontmatterTokens,
        contextWindowTokens,
      ),
      items: snapshot.skillDetails.map((skill) => ({
        name: skill.name,
        source: skill.source,
        percentageOfContext: calculateContextPercentage(
          skill.tokens,
          contextWindowTokens,
        ),
      })),
    },
    duplicateFileReads: snapshot.duplicateFileReads.map((entry) => ({
      path: entry.path,
      count: entry.count,
    })),
    session: snapshot.session,
  };
}
