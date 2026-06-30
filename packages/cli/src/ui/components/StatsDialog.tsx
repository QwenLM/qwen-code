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

// Fixed rows of chrome the embedded Efficiency tab renders around the model
// table, subtracted from the host's availableHeight when capping the model
// list. Itemized: dialog border (2) + padding (2) + tab bar (1) + performance
// cards (3) + cards marginBottom (1) + range indicator (2) + hint row (2) +
// inter-section spacing + "Models" header (2). A height-based estimate,
// deliberately left with headroom.
const EFFICIENCY_CHROME_ROWS = 24;
// The tool leaderboard, when present, adds its data rows plus 3 fixed rows
// (title + column header + marginBottom); when empty it renders nothing.
const TOOL_LEADERBOARD_FIXED_ROWS = 3;
// The Code Impact section, rendered only when there are line changes, occupies
// one row below the model table. Subtract it when present so the model list
// can't overestimate its available space and overflow the host view.
const CODE_IMPACT_ROWS = 1;

const StatsTabs: React.FC<{ activeTab: StatsTab; hint?: string }> = ({
  activeTab,
  hint,
}) => (
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
    {hint && (
      <Box marginLeft={2}>
        <Text color={theme.text.secondary}>{hint}</Text>
      </Box>
    )}
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
  /**
   * When false, the dialog stops consuming keyboard input. Used when the dialog
   * is embedded inside another view (e.g. the Settings dialog's Stats tab) so it
   * only reacts to keys while that tab's content is focused.
   */
  isFocused?: boolean;
  /**
   * Rows available for the dialog content. When set (embedded mode), the
   * Efficiency tab's model table is capped so it cannot overflow the host view.
   */
  availableHeight?: number;
}

export const StatsDialog: React.FC<StatsDialogProps> = ({
  onClose,
  width,
  isFocused = true,
  availableHeight,
}) => {
  const [activeTab, setActiveTab] = useState<StatsTab>('session');
  const [rangeIndex, setRangeIndex] = useState(0);
  const [chartMonthOffset, setChartMonthOffset] = useState(0);
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
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
          setError(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!stale) {
          setError(true);
          setLoading(false);
        }
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
    { isActive: isFocused },
  );

  const hintText =
    activeTab === 'session'
      ? 'tab \xB7 esc'
      : activeTab === 'activity' && range === 'all'
        ? 'tab \xB7 r dates \xB7 \u2190\u2192 month \xB7 esc'
        : 'tab \xB7 r dates \xB7 esc';

  return (
    <Box flexDirection="column" width={safeWidth} flexShrink={0}>
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
          <StatsTabs
            activeTab={activeTab}
            hint={availableHeight != null ? t('(Tab to switch)') : undefined}
          />

          <Box marginTop={1}>
            {activeTab === 'session' && <SessionTab />}
            {activeTab !== 'session' && loading && (
              <Text color={theme.text.secondary}>{t('Loading stats...')}</Text>
            )}
            {activeTab !== 'session' && !loading && error && (
              <Text color={theme.status.error}>
                {t('Failed to load stats. Press r to retry.')}
              </Text>
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
              <EfficiencyTab
                data={data}
                bodyWidth={bodyWidth}
                maxModelRows={
                  availableHeight != null
                    ? Math.max(
                        3,
                        availableHeight -
                          EFFICIENCY_CHROME_ROWS -
                          (data.toolLeaderboard.length > 0
                            ? data.toolLeaderboard.length +
                              TOOL_LEADERBOARD_FIXED_ROWS
                            : 0) -
                          (data.report.files.linesAdded > 0 ||
                          data.report.files.linesRemoved > 0
                            ? CODE_IMPACT_ROWS
                            : 0),
                      )
                    : undefined
                }
              />
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
