/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import nodePath from 'node:path';
import { StreamingState } from './types.js';

export const STATUS_LINE_PRESET_ITEM_IDS = [
  'model-with-reasoning',
  'context-remaining',
  'current-dir',
  'context-used',
  'git-branch',
  'model',
  'project-name',
  'pull-request-number',
  'branch-changes',
  'run-state',
  'qwen-version',
  'context-window-size',
  'used-tokens',
  'total-input-tokens',
  'total-output-tokens',
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
}

export interface StatusLinePresetData {
  sessionId: string;
  version: string;
  modelDisplayName: string;
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
    id: 'model-with-reasoning',
    label: 'model-with-reasoning',
    description: 'Current model name with reasoning level when available',
    defaultSelected: true,
  },
  {
    id: 'context-remaining',
    label: 'context-remaining',
    description: 'Percentage of context window remaining',
    defaultSelected: true,
  },
  {
    id: 'current-dir',
    label: 'current-dir',
    description: 'Current working directory',
    defaultSelected: true,
  },
  {
    id: 'context-used',
    label: 'context-used',
    description: 'Percentage of context window used',
    defaultSelected: true,
  },
  {
    id: 'git-branch',
    label: 'git-branch',
    description: 'Current Git branch when available',
    defaultSelected: true,
  },
  {
    id: 'model',
    label: 'model',
    description: 'Current model name',
  },
  {
    id: 'project-name',
    label: 'project-name',
    description: 'Project name when available',
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
    id: 'session-id',
    label: 'session-id',
    description: 'Current session identifier',
  },
];

const STATUS_LINE_PRESET_ITEM_ID_SET = new Set<string>(
  STATUS_LINE_PRESET_ITEM_IDS,
);

export const DEFAULT_STATUS_LINE_PRESET_CONFIG: StatusLinePresetConfig = {
  type: 'preset',
  useThemeColors: true,
  items: STATUS_LINE_PRESET_ITEMS.filter((item) => item.defaultSelected).map(
    (item) => item.id,
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
  const rawItems = hasItemsArray ? (candidate['items'] as unknown[]) : [];
  const items = hasItemsArray
    ? rawItems.filter(
        (item): item is StatusLinePresetItemId =>
          typeof item === 'string' && STATUS_LINE_PRESET_ITEM_ID_SET.has(item),
      )
    : [];

  return {
    type: 'preset',
    useThemeColors:
      typeof candidate['useThemeColors'] === 'boolean'
        ? candidate['useThemeColors']
        : true,
    items: hasItemsArray
      ? [...new Set(items)]
      : [...DEFAULT_STATUS_LINE_PRESET_CONFIG.items],
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

export function buildStatusLinePresetParts(
  config: StatusLinePresetConfig,
  data: StatusLinePresetData,
): string[] {
  const parts: string[] = [];
  const seen = new Set<StatusLinePresetItemId>();

  for (const item of config.items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);

    switch (item) {
      case 'model-with-reasoning':
      case 'model':
        parts.push(data.modelDisplayName);
        seen.add('model');
        seen.add('model-with-reasoning');
        break;
      case 'context-remaining':
        if (data.contextWindowSize > 0) {
          parts.push(`Context ${formatPercent(data.remainingPercentage)} left`);
        }
        break;
      case 'current-dir':
        parts.push(data.currentDir);
        break;
      case 'context-used':
        if (data.contextWindowSize > 0 && data.usedPercentage > 0) {
          parts.push(`Context ${formatPercent(data.usedPercentage)} used`);
        }
        break;
      case 'git-branch':
        if (data.branch) {
          parts.push(data.branch);
        }
        break;
      case 'project-name':
        if (data.projectName) {
          parts.push(data.projectName);
        }
        break;
      case 'pull-request-number': {
        const prNumber =
          data.pullRequestNumber ?? inferPullRequestNumber(data.branch);
        if (prNumber) {
          parts.push(`#${prNumber}`);
        }
        break;
      }
      case 'branch-changes':
        if (data.totalLinesAdded > 0 || data.totalLinesRemoved > 0) {
          parts.push(`+${data.totalLinesAdded} -${data.totalLinesRemoved}`);
        }
        break;
      case 'run-state':
        parts.push(getRunStateLabel(data.streamingState));
        break;
      case 'qwen-version':
        parts.push(`v${data.version}`);
        break;
      case 'context-window-size':
        if (data.contextWindowSize > 0) {
          parts.push(`${formatTokenCount(data.contextWindowSize)} window`);
        }
        break;
      case 'used-tokens':
        if (data.currentUsage > 0) {
          parts.push(`${formatTokenCount(data.currentUsage)} used`);
        }
        break;
      case 'total-input-tokens':
        parts.push(`${formatTokenCount(data.totalInputTokens)} in`);
        break;
      case 'total-output-tokens':
        parts.push(`${formatTokenCount(data.totalOutputTokens)} out`);
        break;
      case 'session-id':
        if (data.sessionId) {
          parts.push(data.sessionId);
        }
        break;
      default: {
        item satisfies never;
        break;
      }
    }
  }

  return parts;
}

export function buildStatusLinePresetLines(
  config: StatusLinePresetConfig,
  data: StatusLinePresetData,
): string[] {
  const line = buildStatusLinePresetParts(config, data).join(' | ');
  return line ? [line] : [];
}
