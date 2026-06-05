/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { useState, useEffect, useCallback } from 'react';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { loadStatsData, type StatsData } from '../utils/statsDataService.js';
import {
  metricsToUsageRecord,
  type TimeRange,
} from '@qwen-code/qwen-code-core';
import { useSessionStats } from '../contexts/SessionContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { t } from '../../i18n/index.js';
import {
  type StatsTab,
  TAB_DEFS,
  RANGE_CYCLE,
  getRangeLabel,
} from './stats-helpers.js';
import { SessionTab } from './StatsSessionTab.js';
import { ActivityTab } from './StatsActivityTab.js';
import { EfficiencyTab } from './StatsEfficiencyTab.js';

const StatsTabs: React.FC<{ activeTab: StatsTab }> = ({ activeTab }) => (
  <Box flexDirection="row">
    {TAB_DEFS.map(({ tab, label }) => {
      const active = tab === activeTab;
      return (
        <Box key={tab} marginLeft={tab === 'session' ? 0 : 1}>
          <Text
            color={active ? theme.background.primary : theme.text.primary}
            backgroundColor={active ? theme.text.accent : undefined}
          >
            {` ${label()} `}
          </Text>
        </Box>
      );
    })}
  </Box>
);

const RangeIndicator: React.FC<{ range: TimeRange }> = ({ range }) => (
  <Box flexDirection="row" marginTop={1}>
    {RANGE_CYCLE.map((r, i) => (
      <Box key={r}>
        <Text
          bold={r === range}
          color={r === range ? theme.text.accent : theme.text.secondary}
          underline={r === range}
        >
          {getRangeLabel(r)}
        </Text>
        {i < RANGE_CYCLE.length - 1 && (
          <Text color={theme.text.secondary}> · </Text>
        )}
      </Box>
    ))}
  </Box>
);

function buildCurrentSessionRecord(
  sessionId: string,
  startTime: Date,
  project: string,
  metrics: import('@qwen-code/qwen-code-core').SessionMetrics,
) {
  const hasActivity = Object.values(metrics.models).some(
    (m) => m.api.totalRequests > 0,
  );
  if (!hasActivity) return undefined;
  return metricsToUsageRecord(
    sessionId,
    project,
    startTime.getTime(),
    Date.now(),
    metrics,
  );
}

interface StatsDialogProps {
  onClose: () => void;
  width?: number;
}

export const StatsDialog: React.FC<StatsDialogProps> = ({ onClose, width }) => {
  const [activeTab, setActiveTab] = useState<StatsTab>('session');
  const [rangeIndex, setRangeIndex] = useState(0);
  const [chartMonthOffset, setChartMonthOffset] = useState(0);
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const { stats } = useSessionStats();
  const config = useConfig();

  const range = RANGE_CYCLE[rangeIndex]!;
  const safeWidth = Math.max(72, width ?? 100);
  const bodyWidth = safeWidth - 6;

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const liveRecord = buildCurrentSessionRecord(
      stats.sessionId,
      stats.sessionStartTime,
      config.getProjectRoot(),
      stats.metrics,
    );
    loadStatsData(range, liveRecord)
      .then((d) => {
        if (!stale) {
          setData(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reload on range/session change, not every metrics tick
  }, [range, stats.sessionId]);

  const handleTabChange = useCallback(
    (direction: 1 | -1) => {
      const idx = TAB_DEFS.findIndex((td) => td.tab === activeTab);
      const next = (idx + direction + TAB_DEFS.length) % TAB_DEFS.length;
      setActiveTab(TAB_DEFS[next]!.tab);
    },
    [activeTab],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return;
      }
      if (key.name === 'tab') {
        handleTabChange(key.shift ? -1 : 1);
        return;
      }
      if (key.name === 'r') {
        setRangeIndex((i) => (i + 1) % RANGE_CYCLE.length);
        return;
      }
      if (
        (key.name === 'left' || key.name === 'h') &&
        activeTab === 'activity' &&
        range === 'all' &&
        data
      ) {
        const months = [
          ...new Set(data.tokensPerDay.map((d) => d.date.slice(0, 7))),
        ];
        const maxOffset = Math.max(0, months.length - 1);
        setChartMonthOffset((o) => Math.min(maxOffset, o + 1));
        return;
      }
      if (
        (key.name === 'right' || key.name === 'l') &&
        activeTab === 'activity' &&
        range === 'all'
      ) {
        setChartMonthOffset((o) => Math.max(0, o - 1));
        return;
      }
    },
    { isActive: true },
  );

  const hintText =
    activeTab === 'session'
      ? 'tab \xB7 esc'
      : activeTab === 'activity' && range === 'all'
        ? 'tab \xB7 r dates \xB7 \u2190\u2192 month \xB7 esc'
        : 'tab \xB7 r dates \xB7 esc';

  return (
    <Box flexDirection="column" width={safeWidth}>
      <Box
        borderColor={theme.border.default}
        borderStyle="single"
        width={safeWidth}
      >
        <Box
          flexDirection="column"
          paddingX={2}
          paddingY={1}
          width={safeWidth - 2}
        >
          <StatsTabs activeTab={activeTab} />

          <Box marginTop={1}>
            {activeTab === 'session' && <SessionTab />}
            {activeTab !== 'session' && loading && (
              <Text color={theme.text.secondary}>{t('Loading stats...')}</Text>
            )}
            {activeTab === 'activity' && !loading && data && (
              <ActivityTab
                data={data}
                bodyWidth={bodyWidth}
                chartMonthOffset={chartMonthOffset}
                range={range}
              />
            )}
            {activeTab === 'efficiency' && !loading && data && (
              <EfficiencyTab data={data} bodyWidth={bodyWidth} />
            )}
          </Box>

          {activeTab !== 'session' && <RangeIndicator range={range} />}

          <Box marginTop={1}>
            <Text italic color={theme.text.secondary}>
              {hintText}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
};
