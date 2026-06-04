/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import type { HeatmapIntensity } from '../utils/asciiCharts.js';
import type { TimeRange } from '@qwen-code/qwen-code-core';

export type StatsTab = 'session' | 'activity' | 'efficiency';

export const TAB_DEFS: Array<{ tab: StatsTab; label: () => string }> = [
  { tab: 'session', label: () => t('Session') },
  { tab: 'activity', label: () => t('Activity') },
  { tab: 'efficiency', label: () => t('Efficiency') },
];

export const RANGE_CYCLE: TimeRange[] = ['all', 'month', 'week', 'today'];

export function getHeatmapColors(): Record<HeatmapIntensity, string> {
  return {
    0: '#161b22',
    1: '#39d353',
    2: '#26a641',
    3: '#006d32',
    4: '#0e4429',
  };
}

export function getSeriesColors(): string[] {
  return [
    theme.text.link,
    theme.status.error,
    theme.text.accent,
    theme.status.success,
    theme.status.warning,
    theme.text.code,
  ];
}

export function getRangeLabel(range: string): string {
  const labels: Record<string, string> = {
    today: t('Today'),
    all: t('All time'),
    week: t('Last 7 days'),
    month: t('Last 30 days'),
  };
  return labels[range] ?? range;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

export function fmtDurationShort(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const d = t('d');
  const h = t('h');
  const m = t('m');
  if (days > 0) return `${days}${d} ${hours}${h} ${minutes}${m}`;
  if (hours > 0) return `${hours}${h} ${minutes}${m}`;
  return `${minutes}${m}`;
}

export function fmtSuccessBar(rate: number): string {
  const filled = Math.round(rate / 10);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
}

export function getSuccessColor(rate: number): string {
  if (rate >= 95) return theme.status.success;
  if (rate >= 80) return theme.status.warning;
  return theme.status.error;
}

export function getCacheColor(rate: number): string {
  if (rate >= 85) return theme.status.success;
  if (rate >= 70) return theme.status.warning;
  return theme.status.error;
}

export const TableRow: React.FC<{
  cells: Array<{ text: string; width: number; color?: string; bold?: boolean }>;
}> = ({ cells }) => (
  <Box>
    {cells.map((cell, i) => (
      <Box key={i} width={cell.width}>
        <Text color={cell.color} bold={cell.bold}>
          {cell.text}
        </Text>
      </Box>
    ))}
  </Box>
);
