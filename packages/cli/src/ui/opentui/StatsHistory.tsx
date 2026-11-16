/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import type { StatsData } from '../utils/statsDataService.js';
import type { TimeRange } from '@qwen-code/qwen-code-core/services/usageHistoryService.js';
import {
  buildHeatmapData,
  buildBrailleLineChart,
  MONTH_LABELS,
} from '../utils/asciiCharts.js';
import {
  fmtTokens,
  fmtDurationShort,
  getHeatmapColors,
} from '../components/stats-formatters.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';
import { t } from '../../i18n/index.js';
import { C } from './theme.js';

export function statsMonths(data?: StatsData): string[] {
  return [
    ...new Set(data?.tokensPerDay.map((row) => row.date.slice(0, 7)) ?? []),
  ]
    .sort()
    .reverse();
}
const change = (
  value: number | null | undefined,
  decimals = 0,
  suffix = '%',
) =>
  value == null
    ? ''
    : ` ${value >= 0 ? '▲' : '▼'}${Math.abs(value).toFixed(decimals)}${suffix}`;
const Line = ({ children }: { children: string }) => (
  <text fg={C.text}>{sanitizeTerminalText(children)}</text>
);

export function StatsHistory({
  data,
  tab,
  range,
  monthOffset,
  width,
}: {
  data: StatsData;
  tab: 'activity' | 'efficiency';
  range: TimeRange;
  monthOffset: number;
  width: number;
}) {
  const report = data.report;
  if (tab === 'efficiency') {
    const models = Object.entries(report.models).sort(
      (a, b) => b[1].totalTokens - a[1].totalTokens,
    );
    return (
      <box flexDirection="column">
        <Line>{`${t('Cache Hit Rate')} ${data.efficiency.cacheHitRate.toFixed(1)}%${change(data.delta?.cacheRate, 1)}`}</Line>
        <Line>{`${t('Tool Success')} ${data.efficiency.toolSuccessRate.toFixed(1)}%${change(data.delta?.toolSuccess, 1)}`}</Line>
        <Line>{`${t('Avg Latency')} ${data.efficiency.avgLatencyMs == null ? '—' : `${(data.efficiency.avgLatencyMs / 1000).toFixed(1)}s`}${change(data.delta?.avgLatency == null ? null : data.delta.avgLatency / 1000, 1, 's')}`}</Line>
        {data.toolLeaderboard.length > 0 ? (
          <>
            <Line>{t('Tool Leaderboard')}</Line>
            <Line>{`${t('Tool')}  ${t('Calls')}  ${t('Duration')}  ${t('Success')}`}</Line>
            {data.toolLeaderboard.map((tool) => (
              <Line
                key={tool.name}
              >{`${tool.name}  ${tool.count}  ${(tool.totalDurationMs / 1000).toFixed(1)}s  ${tool.successRate.toFixed(0)}%`}</Line>
            ))}
          </>
        ) : null}
        {models.length > 0 ? (
          <>
            <Line>{t('Models')}</Line>
            <Line>{`${t('Model')}  ${t('Reqs')}  ${t('In/Out')}  ${t('Thoughts')}  ${t('Cache')}  ${t('Latency')}`}</Line>
            {models.map(([name, model]) => (
              <Line
                key={name}
              >{`${name}  ${model.requests}  ${fmtTokens(model.inputTokens)}/${fmtTokens(model.outputTokens)}  ${fmtTokens(model.thoughtsTokens)}  ${(model.inputTokens ? (model.cachedTokens / model.inputTokens) * 100 : 0).toFixed(0)}%  ${model.totalLatencyMs > 0 && model.requests ? `${(model.totalLatencyMs / model.requests / 1000).toFixed(1)}s` : '—'}`}</Line>
            ))}
          </>
        ) : null}
        {report.files.linesAdded > 0 || report.files.linesRemoved > 0 ? (
          <Line>{`${t('Code Impact')} +${report.files.linesAdded.toLocaleString()} / -${report.files.linesRemoved.toLocaleString()} (${report.files.linesAdded - report.files.linesRemoved >= 0 ? '+' : ''}${(report.files.linesAdded - report.files.linesRemoved).toLocaleString()})`}</Line>
        ) : null}
      </box>
    );
  }
  const tokens = Object.values(report.models).reduce(
    (sum, model) => sum + model.totalTokens,
    0,
  );
  const months = statsMonths(data);
  const offset = Math.min(monthOffset, Math.max(0, months.length - 1));
  const month = range === 'all' ? months[offset] : undefined;
  const heatmap = buildHeatmapData(
    data.heatmap,
    Math.max(1, Math.min(26, Math.floor((width - 4) / 2))),
    offset,
  );
  const colors = getHeatmapColors();
  let heatmapLabels = '';
  for (const label of heatmap.colLabels) {
    heatmapLabels = heatmapLabels.padEnd(label.col * 2) + label.text;
  }
  const totals = new Map<string, number>();
  for (const row of data.tokensPerDay) {
    if (!month || row.date.startsWith(month))
      totals.set(row.date, (totals.get(row.date) ?? 0) + row.tokens);
  }
  const chart = buildBrailleLineChart(
    [...totals].map(([date, value]) => ({ date, value })),
    Math.max(2, width - 8),
    8,
  );
  const dateLabel = (value: string) => {
    const date = new Date(value + 'T00:00:00');
    return `${MONTH_LABELS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  };
  return (
    <box flexDirection="column">
      <Line>{`${t('Sessions')} ${report.sessionCount}${change(data.delta?.sessions)}    ${t('Duration')} ${fmtDurationShort(report.totalDurationMs)}${change(data.delta?.duration)}    ${t('Tokens')} ${fmtTokens(tokens)}${change(data.delta?.tokens)}`}</Line>
      <Line>{`${t('Activity Heatmap')}  ${dateLabel(heatmap.startDate)} - ${dateLabel(heatmap.endDate)}`}</Line>
      <Line>{`${t('streak')}: ${data.currentStreak}${t('d')}  ${t('best')}: ${data.longestStreak}${t('d')}`}</Line>
      <Line>{`    ${heatmapLabels}`}</Line>
      {heatmap.rows.map((row, index) => (
        <text key={index} fg={C.dim}>
          {row.label}
          {row.cells.map((cell, cellIndex) => (
            <span
              key={cellIndex}
              bg={cell.intensity ? colors[cell.intensity] : undefined}
              attributes={cell.isToday ? 8 : 0}
            >
              {cell.char}
            </span>
          ))}
        </text>
      ))}
      <Line>{`${t('Less')} · ░ ▒ ▓ █ ${t('More')}`}</Line>
      <Line>{`${t('Token Trend')}${month ? `  ${offset < months.length - 1 ? '← ' : ''}${MONTH_LABELS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}${offset > 0 ? ' →' : ''}` : ''}`}</Line>
      {chart ? (
        <>
          {chart.rows.map((row, index) => (
            <Line
              key={index}
            >{`${chart.yLabels[index]?.padStart(6) ?? '      '}│${row.map((cell) => cell.char).join('')}`}</Line>
          ))}
          <Line>{`      └${chart.xLabels}`}</Line>
          <Line>{`       ${t('peak {{value}}', { value: fmtTokens(chart.peak) })}`}</Line>
        </>
      ) : (
        <Line>{t('(no data)')}</Line>
      )}
      {report.projects.length > 0 ? (
        <>
          <Line>{t('Projects')}</Line>
          <Line>{`${t('Project')}  ${t('Sessions')}  ${t('Tokens')}  ${t('Duration')}`}</Line>
          {report.projects.slice(0, 5).map((project) => (
            <Line
              key={project.path}
            >{`${project.path.split('/').pop() || project.path}  ${project.sessionCount}  ${fmtTokens(project.totalTokens)}  ${fmtDurationShort(project.totalDurationMs)}`}</Line>
          ))}
          {report.projects.length > 5 ? (
            <Line>{`+${t('{{count}} more', { count: String(report.projects.length - 5) })}`}</Line>
          ) : null}
        </>
      ) : null}
    </box>
  );
}
