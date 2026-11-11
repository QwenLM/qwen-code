/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  countHumanPromptMessages,
  SessionStateStore,
  loadLatestSessionUsage,
  buildStartupMemoryPrefix,
  createStartupMemoryContext,
  countRequestTokens,
  buildModelProjectionOptions,
  buildModelStreamTools,
  getAutoCompactThresholdForContextWindow,
  getRawContextWindowSize,
  getSummaryReserveTokens,
  type CacheSafeQuerySnapshot,
  type Config,
  type Message,
  type ModelStreamTool,
  type SessionMetrics,
  type SkillSource,
  type SystemPrompt,
  estimateRequestBlockTokens,
} from '@qwen-code/core';
import {
  analyzeContext,
  estimateString,
  getModelMessageTokens,
  roughEstimate,
  type TokenStats,
} from '../../utils/analyzeContext.js';

export type ContextUsageCategoryType =
  | 'system_prompt'
  | 'system_tools'
  | 'skills'
  | 'messages'
  | 'other'
  | 'free_space'
  | 'auto_compact';

export interface ContextUsageSkillDetail {
  name: string;
  source: SkillSource;
  tokens: number;
}

export interface ContextUsageSnapshotCategory {
  type: ContextUsageCategoryType;
  tokens: number;
  percentage: number;
}

export interface ContextUsageDuplicateRead {
  path: string;
  count: number;
  wastedTokens: number;
}

export interface ContextUsageSessionInput {
  metrics: SessionMetrics;
}

export interface ContextUsageSessionSnapshot {
  messageCount: number;
  promptCount: number;
  toolCalls: {
    total: number;
    succeeded: number;
    failed: number;
  };
  linesChanged: {
    added: number;
    removed: number;
  };
}

export interface CollectContextUsageInput {
  config: Config;
  messages: readonly Message[];
  requestSnapshot?:
    | (Pick<CacheSafeQuerySnapshot, 'model' | 'contextWindow'> &
        Partial<
          Pick<
            CacheSafeQuerySnapshot,
            | 'systemPrompt'
            | 'toolSchemas'
            | 'requestPrefixMessages'
            | 'modelResolution'
          >
        >)
    | null;
  cachedSystemPrompt?: SystemPrompt;
  cachedRenderedSystemPrompt?: string;
  cachedParentToolSchemas?: readonly ModelStreamTool[];
  session: ContextUsageSessionInput;
}

export interface ContextUsageSnapshot {
  model: string;
  tokenUsage: number;
  rawContextWindowTokens: number;
  autoCompactThresholdTokens: number;
  autoCompactBufferTokens: number;
  autoCompactEnabled: boolean;
  tokenStats: TokenStats;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  skillDetails: ContextUsageSkillDetail[];
  skillFrontmatterTokens: number;
  categories: ContextUsageSnapshotCategory[];
  duplicateFileReads: ContextUsageDuplicateRead[];
  session: ContextUsageSessionSnapshot;
}

export function calculateContextPercentage(
  tokens: number,
  contextWindowTokens: number,
): number {
  if (contextWindowTokens <= 0) return 0;
  return Math.min(100, Math.round((tokens / contextWindowTokens) * 1_000) / 10);
}

function getToolSchemas(
  config: Config,
  cachedParentToolSchemas?: readonly ModelStreamTool[],
): readonly ModelStreamTool[] {
  return (
    cachedParentToolSchemas ??
    buildModelStreamTools(
      config.getToolRegistry().getFunctionDeclarations(),
    )
  );
}

function getSkillDetails(config: Config): ContextUsageSkillDetail[] {
  const skills = config.getSkillManager?.()?.getDisplayableSkills?.() ?? [];
  return skills
    .map((skill) => {
      const frontmatterText = [skill.name, skill.description, skill.whenToUse]
        .filter(Boolean)
        .join(' ');
      return {
        name: skill.name,
        source: skill.source ?? 'built-in',
        tokens: estimateString(frontmatterText),
      };
    })
    .sort((left, right) => right.tokens - left.tokens);
}

function makeCategory(
  type: ContextUsageCategoryType,
  tokens: number,
  contextWindowTokens: number,
): ContextUsageSnapshotCategory {
  return {
    type,
    tokens,
    percentage: calculateContextPercentage(tokens, contextWindowTokens),
  };
}

function scaleTokenMap(
  values: Map<string, number>,
  scale: number,
): Map<string, number> {
  return new Map(
    [...values.entries()].map(([key, tokens]) => [key, tokens * scale]),
  );
}

function scaleTokenStats(stats: TokenStats, scale: number): TokenStats {
  if (scale === 1) return stats;

  return {
    ...stats,
    toolRequests: scaleTokenMap(stats.toolRequests, scale),
    toolResults: scaleTokenMap(stats.toolResults, scale),
    humanMessages: stats.humanMessages * scale,
    assistantMessages: stats.assistantMessages * scale,
    thinkingTokens: stats.thinkingTokens * scale,
    other: stats.other * scale,
    attachments: scaleTokenMap(stats.attachments, scale),
    skillTokens: scaleTokenMap(stats.skillTokens, scale),
    duplicateFileReads: new Map(
      [...stats.duplicateFileReads.entries()].map(([path, info]) => [
        path,
        { ...info, tokens: info.tokens * scale },
      ]),
    ),
    total: stats.total * scale,
  };
}

export async function collectContextUsage(
  input: CollectContextUsageInput,
): Promise<ContextUsageSnapshot> {
  const { config, messages } = input;
  // The window describes the current selection, including preference changes
  // made since the last request. A cache-safe snapshot still belongs to that
  // request and must not override the selected model or its effective window.
  const listedModel = await config.getModelProviderManager().getMainModel();
  const model = listedModel.key;
  const modelResolution =
    input.requestSnapshot?.model === model
      ? input.requestSnapshot.modelResolution
      : undefined;
  let tokenStats = analyzeContext(messages);
  const systemPrompt =
    input.cachedSystemPrompt ??
    input.requestSnapshot?.systemPrompt ??
    (input.cachedRenderedSystemPrompt === undefined
      ? undefined
      : [{ type: 'text' as const, text: input.cachedRenderedSystemPrompt }]);
  let systemPromptTokens = (systemPrompt ?? []).reduce(
    (total, block) =>
      total +
      estimateRequestBlockTokens(block),
    0,
  );
  const toolSchemas = getToolSchemas(
    config,
    input.requestSnapshot?.toolSchemas ?? input.cachedParentToolSchemas,
  );
  let toolSchemaTokens =
    toolSchemas.length > 0 ? roughEstimate(toolSchemas) : 0;
  let skillDetails = getSkillDetails(config);
  let skillFrontmatterTokens = skillDetails.reduce(
    (sum, skill) => sum + skill.tokens,
    0,
  );

  const rawContextWindowTokens = getRawContextWindowSize(
    listedModel,
    config.getEffectiveContextWindow(listedModel, model),
  );
  const warningContextWindowTokens = Math.max(
    0,
    rawContextWindowTokens - getSummaryReserveTokens(listedModel),
  );
  const autoCompactThresholdTokens = getAutoCompactThresholdForContextWindow(
    warningContextWindowTokens,
  );
  const autoCompactBufferTokens = Math.max(
    0,
    rawContextWindowTokens - autoCompactThresholdTokens,
  );

  const categoryEstimate =
    tokenStats.total +
    systemPromptTokens +
    toolSchemaTokens +
    skillFrontmatterTokens;
  const latestUsage = await loadLatestSessionUsage(
    new SessionStateStore({
      projectRoot: config.getSessionArtifactProjectRoot(),
      sessionId: config.getSessionId(),
    }),
  ).catch(() => null);
  const tokenUsage = countRequestTokens({
    model,
    messages: [
      ...(input.requestSnapshot?.requestPrefixMessages ??
        buildStartupMemoryPrefix(createStartupMemoryContext(config))),
      ...messages,
    ],
    systemPrompt,
    tools: toolSchemas,
    latestUsage,
    projectionOptions: buildModelProjectionOptions(
      config,
      model,
      modelResolution,
    ),
  }).tokens;
  // Reconcile categories with the same total used by request counting. Skill
  // frontmatter is a breakdown of injected context, not extra request overhead.
  const categoryScale =
    categoryEstimate > tokenUsage && categoryEstimate > 0
      ? tokenUsage / categoryEstimate
      : 1;

  tokenStats = scaleTokenStats(tokenStats, categoryScale);
  systemPromptTokens *= categoryScale;
  toolSchemaTokens *= categoryScale;
  skillDetails = skillDetails.map((skill) => ({
    ...skill,
    tokens: skill.tokens * categoryScale,
  }));
  skillFrontmatterTokens *= categoryScale;
  if (categoryEstimate < tokenUsage) {
    const unattributedTokens = tokenUsage - categoryEstimate;
    tokenStats = {
      ...tokenStats,
      other: tokenStats.other + unattributedTokens,
      total: tokenStats.total + unattributedTokens,
    };
  }
  const totalMessageTokens = getModelMessageTokens(tokenStats);
  const remainingContextTokens = Math.max(
    0,
    rawContextWindowTokens - tokenUsage,
  );
  const displayedAutoCompactBufferTokens = Math.min(
    autoCompactBufferTokens,
    remainingContextTokens,
  );
  const freeTokens = remainingContextTokens - displayedAutoCompactBufferTokens;

  const categories: ContextUsageSnapshotCategory[] = [
    makeCategory('system_prompt', systemPromptTokens, rawContextWindowTokens),
  ];
  if (toolSchemaTokens > 0) {
    categories.push(
      makeCategory('system_tools', toolSchemaTokens, rawContextWindowTokens),
    );
  }
  if (skillFrontmatterTokens > 0) {
    categories.push(
      makeCategory('skills', skillFrontmatterTokens, rawContextWindowTokens),
    );
  }
  if (totalMessageTokens > 0) {
    categories.push(
      makeCategory('messages', totalMessageTokens, rawContextWindowTokens),
    );
  }
  if (tokenStats.other > 0) {
    categories.push(
      makeCategory('other', tokenStats.other, rawContextWindowTokens),
    );
  }
  categories.push(
    makeCategory('free_space', freeTokens, rawContextWindowTokens),
  );
  if (autoCompactBufferTokens > 0) {
    categories.push(
      makeCategory(
        'auto_compact',
        displayedAutoCompactBufferTokens,
        rawContextWindowTokens,
      ),
    );
  }

  const toolsMetrics = input.session.metrics?.tools;
  const filesMetrics = input.session.metrics?.files;

  return {
    model,
    tokenUsage,
    rawContextWindowTokens,
    autoCompactThresholdTokens,
    autoCompactBufferTokens,
    autoCompactEnabled: config.isContextManagementEnabled?.() ?? false,
    tokenStats,
    systemPromptTokens,
    toolSchemaTokens,
    skillDetails,
    skillFrontmatterTokens,
    categories,
    duplicateFileReads: [...tokenStats.duplicateFileReads.entries()].map(
      ([path, info]) => ({
        path,
        count: info.count,
        wastedTokens: info.tokens,
      }),
    ),
    session: {
      messageCount: messages.length,
      promptCount: countHumanPromptMessages(messages),
      toolCalls: {
        total: toolsMetrics?.totalCalls ?? 0,
        succeeded: toolsMetrics?.totalSuccess ?? 0,
        failed: toolsMetrics?.totalFail ?? 0,
      },
      linesChanged: {
        added: filesMetrics?.totalLinesAdded ?? 0,
        removed: filesMetrics?.totalLinesRemoved ?? 0,
      },
    },
  };
}
