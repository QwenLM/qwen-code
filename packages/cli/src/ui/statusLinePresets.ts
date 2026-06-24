/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import nodePath from 'node:path';
import { StreamingState } from './types.js';

export const STATUS_LINE_PRESET_ITEM_IDS = [
  'project-name',
  'git-branch',
  'model-with-reasoning',
  'model',
  'context-remaining',
  'total-input-tokens',
  'total-output-tokens',
  'current-dir',
  'pull-request-number',
  'branch-changes',
  'context-used',
  'run-state',
  'qwen-version',
  'context-window-size',
  'used-tokens',
  'session-id',
] as const;

export type StatusLinePresetItemId =
  (typeof STATUS_LINE_PRESET_ITEM_IDS)[number];

export interface StatusLinePresetItem {
  id: StatusLinePresetItemId;
  label: string;
  description: string;
  defaultSelected?: boolean;
}

export interface StatusLinePresetConfig {
  type: 'preset';
  items: StatusLinePresetItemId[];
  useThemeColors?: boolean;
  hideContextIndicator?: boolean;
}

export type StatusLinePresetReasoning =
  | false
  | {
      effort?: 'low' | 'medium' | 'high' | 'max';
    }
  | undefined;

export interface StatusLinePresetData {
  sessionId: string;
  version: string;
  modelDisplayName: string;
  reasoning: StatusLinePresetReasoning;
  currentDir: string;
  projectName: string | undefined;
  branch: string | undefined;
  pullRequestNumber: string | undefined;
  contextWindowSize: number;
  usedPercentage: number;
  remainingPercentage: number;
  currentUsage: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  streamingState: StreamingState;
}

export function aggregateModelTokens(metrics: {
  models: Record<string, { tokens: { prompt: number; candidates: number } }>;
}): { totalInputTokens: number; totalOutputTokens: number } {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  for (const modelMetrics of Object.values(metrics.models)) {
    totalInputTokens += modelMetrics.tokens.prompt;
    totalOutputTokens += modelMetrics.tokens.candidates;
  }
  return { totalInputTokens, totalOutputTokens };
}

export const STATUS_LINE_PRESET_ITEMS: readonly StatusLinePresetItem[] = [
  {
    id: 'project-name',
    label: 'project-name',
    description: 'Project name when available',
    defaultSelected: true,
  },
  {
    id: 'git-branch',
    label: 'git-branch',
    description: 'Current Git branch when available',
    defaultSelected: true,
  },
  {
    id: 'model-with-reasoning',
    label: 'model-with-reasoning',
    description: 'Current model name with reasoning level when available',
    defaultSelected: true,
  },
  {
    id: 'model',
    label: 'model-only',
    description: 'Current model name without reasoning level',
  },
  {
    id: 'context-remaining',
    label: 'context-remaining',
    description: 'Percentage of context window remaining',
  },
  {
    id: 'total-input-tokens',
    label: 'total-input-tokens',
    description: 'Total input tokens used in session',
  },
  {
    id: 'total-output-tokens',
    label: 'total-output-tokens',
    description: 'Total output tokens used in session',
  },
  {
    id: 'current-dir',
    label: 'current-dir',
    description: 'Current working directory',
  },
  {
    id: 'pull-request-number',
    label: 'pull-request-number',
    description: 'Open pull request number for the current branch',
  },
  {
    id: 'branch-changes',
    label: 'branch-changes',
    description: 'Session file changes added and removed',
  },
  {
    id: 'context-used',
    label: 'context-used',
    description: 'Percentage of context window used',
    defaultSelected: true,
  },
  {
    id: 'run-state',
    label: 'run-state',
    description: 'Compact session run-state text',
  },
  {
    id: 'qwen-version',
    label: 'qwen-version',
    description: 'Qwen Code application version',
  },
  {
    id: 'context-window-size',
    label: 'context-window-size',
    description: 'Total context window size in tokens',
  },
  {
    id: 'used-tokens',
    label: 'used-tokens',
    description: 'Current prompt tokens used',
  },
  {
    id: 'session-id',
    label: 'session-id',
    description: 'Current session identifier',
  },
];

const STATUS_LINE_PRESET_ITEM_ID_SET = new Set<string>(
  STATUS_LINE_PRESET_ITEM_IDS,
);

export function orderStatusLinePresetItems(
  items: readonly unknown[],
): StatusLinePresetItemId[] {
  const selectedItems = new Set(
    items.filter(
      (item): item is StatusLinePresetItemId =>
        typeof item === 'string' && STATUS_LINE_PRESET_ITEM_ID_SET.has(item),
    ),
  );

  return STATUS_LINE_PRESET_ITEM_IDS.filter((item) => selectedItems.has(item));
}

export const DEFAULT_STATUS_LINE_PRESET_CONFIG: StatusLinePresetConfig = {
  type: 'preset',
  useThemeColors: true,
  items: orderStatusLinePresetItems(
    STATUS_LINE_PRESET_ITEMS.filter((item) => item.defaultSelected).map(
      (item) => item.id,
    ),
  ),
};

export function normalizeStatusLinePresetConfig(
  raw: unknown,
): StatusLinePresetConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const candidate = raw as Record<string, unknown>;
  if (candidate['type'] !== 'preset') {
    return undefined;
  }

  const hasItemsArray = Array.isArray(candidate['items']);
  const items = hasItemsArray
    ? orderStatusLinePresetItems(candidate['items'] as unknown[])
    : [];

  return {
    type: 'preset',
    useThemeColors:
      typeof candidate['useThemeColors'] === 'boolean'
        ? candidate['useThemeColors']
        : true,
    items: hasItemsArray ? items : [...DEFAULT_STATUS_LINE_PRESET_CONFIG.items],
    hideContextIndicator:
      typeof candidate['hideContextIndicator'] === 'boolean'
        ? candidate['hideContextIndicator']
        : undefined,
  };
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return '0%';
  }
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded}%`;
}

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}m`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(Math.round(value));
}

export function getRunStateLabel(state: StreamingState): string {
  switch (state) {
    case StreamingState.Idle:
      return 'Ready';
    case StreamingState.Responding:
      return 'Working';
    case StreamingState.WaitingForConfirmation:
      return 'Confirm';
    default:
      return 'Working';
  }
}

function stripProviderPrefix(name: string): string {
  return name.replace(/^\[[^\]]*\]\s*/, '');
}

export function formatModelWithReasoning(
  modelDisplayName: string,
  reasoning: StatusLinePresetReasoning,
): string {
  const cleanName = stripProviderPrefix(modelDisplayName);
  if (reasoning === false) {
    return `${cleanName} reasoning off`;
  }
  if (reasoning?.effort) {
    return `${cleanName} ${reasoning.effort}`;
  }
  return cleanName;
}

export function inferPullRequestNumber(
  branch: string | undefined,
): string | undefined {
  if (!branch) {
    return undefined;
  }
  const match = branch.match(
    /(?:^|[/_-])(?:pr|pull|pull-request)[/_-]?#?(\d+)(?:$|[/_-])/i,
  );
  return match?.[1];
}

export function buildStatusLinePresetData(params: {
  sessionId: string;
  version: string | undefined;
  modelDisplayName: string | undefined;
  reasoning?: StatusLinePresetReasoning;
  currentDir: string;
  branch: string | undefined;
  pullRequestNumber?: string | undefined;
  contextWindowSize: number;
  currentUsage: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  streamingState: StreamingState;
}): StatusLinePresetData {
  const usedPercentage =
    params.contextWindowSize > 0
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round(
              (params.currentUsage / params.contextWindowSize) * 1000,
            ) / 10,
          ),
        )
      : 0;

  return {
    sessionId: params.sessionId,
    version: params.version || 'unknown',
    modelDisplayName: params.modelDisplayName || 'unknown',
    reasoning: params.reasoning,
    currentDir: params.currentDir,
    projectName: nodePath.basename(params.currentDir) || undefined,
    branch: params.branch,
    pullRequestNumber: params.pullRequestNumber,
    contextWindowSize: params.contextWindowSize,
    usedPercentage,
    remainingPercentage: Math.round((100 - usedPercentage) * 10) / 10,
    currentUsage: params.currentUsage,
    totalInputTokens: params.totalInputTokens,
    totalOutputTokens: params.totalOutputTokens,
    totalLinesAdded: params.totalLinesAdded,
    totalLinesRemoved: params.totalLinesRemoved,
    streamingState: params.streamingState,
  };
}

function formatPresetItem(
  item: StatusLinePresetItemId,
  data: StatusLinePresetData,
): string | undefined {
  switch (item) {
    case 'model-with-reasoning':
      return formatModelWithReasoning(data.modelDisplayName, data.reasoning);
    case 'model':
      return stripProviderPrefix(data.modelDisplayName);
    case 'context-remaining':
      if (data.contextWindowSize > 0) {
        return `Context ${formatPercent(data.remainingPercentage)} left`;
      }
      return undefined;
    case 'current-dir':
      return data.currentDir;
    case 'context-used':
      if (data.contextWindowSize > 0 && data.usedPercentage > 0) {
        return `Context ${formatPercent(data.usedPercentage)} used`;
      }
      return undefined;
    case 'git-branch':
      if (data.branch) {
        return `git:(${data.branch})`;
      }
      return undefined;
    case 'project-name':
      if (data.projectName) {
        return `\u279c  ${data.projectName}`;
      }
      return undefined;
    case 'pull-request-number': {
      const prNumber =
        data.pullRequestNumber ?? inferPullRequestNumber(data.branch);
      if (prNumber) {
        return `#${prNumber}`;
      }
      return undefined;
    }
    case 'branch-changes':
      if (data.totalLinesAdded > 0 || data.totalLinesRemoved > 0) {
        return `+${data.totalLinesAdded} -${data.totalLinesRemoved}`;
      }
      return undefined;
    case 'run-state':
      return getRunStateLabel(data.streamingState);
    case 'qwen-version':
      return `v${data.version}`;
    case 'context-window-size':
      if (data.contextWindowSize > 0) {
        return `${formatTokenCount(data.contextWindowSize)} window`;
      }
      return undefined;
    case 'used-tokens':
      if (data.currentUsage > 0) {
        return `${formatTokenCount(data.currentUsage)} used`;
      }
      return undefined;
    case 'total-input-tokens':
      return `${formatTokenCount(data.totalInputTokens)} total in`;
    case 'total-output-tokens':
      return `${formatTokenCount(data.totalOutputTokens)} total out`;
    case 'session-id':
      return data.sessionId || undefined;
    default: {
      item satisfies never;
      return undefined;
    }
  }
}

export function buildStatusLinePresetParts(
  config: StatusLinePresetConfig,
  data: StatusLinePresetData,
): string[] {
  const parts: string[] = [];
  for (const item of orderStatusLinePresetItems(config.items)) {
    const text = formatPresetItem(item, data);
    if (text) {
      parts.push(text);
    }
  }
  return parts;
}

export function buildStatusLinePresetLines(
  config: StatusLinePresetConfig,
  data: StatusLinePresetData,
): string[] {
  const rendered: Array<{ item: StatusLinePresetItemId; text: string }> = [];
  for (const item of orderStatusLinePresetItems(config.items)) {
    const text = formatPresetItem(item, data);
    if (text) {
      rendered.push({ item, text });
    }
  }

  if (rendered.length === 0) return [];

  let line = rendered[0].text;
  for (let i = 1; i < rendered.length; i++) {
    const prev = rendered[i - 1].item;
    const curr = rendered[i].item;
    if (prev === 'project-name' && curr === 'git-branch') {
      line += ' ';
    } else {
      line += ' \u00b7 ';
    }
    line += rendered[i].text;
  }

  return [line];
}
