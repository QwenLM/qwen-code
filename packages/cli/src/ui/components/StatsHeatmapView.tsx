/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { buildHeatmapData, MONTH_LABELS } from '../utils/asciiCharts.js';
import { getHeatmapColors } from './stats-helpers.js';
import type { StatsData } from '../utils/statsDataService.js';
import { t } from '../../i18n/index.js';

export const HeatmapView: React.FC<{
  data: StatsData;
  weeks: number;
  monthOffset: number;
}> = ({ data, weeks, monthOffset }) => {
  const HEATMAP_COLORS = getHeatmapColors();
  const heatmap = buildHeatmapData(data.heatmap, weeks, monthOffset);

  const fmtDate = (d: string) => {
    const dt = new Date(d + 'T00:00:00');
    return `${MONTH_LABELS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color={theme.text.primary}>
          {t('Activity Heatmap')}
        </Text>
        <Text color={theme.text.accent}>
          {'  '}
          {fmtDate(heatmap.startDate)} - {fmtDate(heatmap.endDate)}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary}>{'    '}</Text>
        {(() => {
          const labelAt = new Map<number, string>();
          for (const cl of heatmap.colLabels) labelAt.set(cl.col, cl.text);

          const out: React.ReactNode[] = [];
          let skipCols = 0;
          for (let c = 0; c < heatmap.totalCols; c++) {
            if (skipCols > 0) {
              skipCols--;
              continue;
            }
            const label = labelAt.get(c);
            if (label && label.length > 2) {
              out.push(
                <Text key={c} color={theme.text.secondary}>
                  {label.padEnd(4)}
                </Text>,
              );
              skipCols = 1;
            } else if (label) {
              out.push(
                <Text key={c} color={theme.text.secondary}>
                  {label.padEnd(2)}
                </Text>,
              );
            } else {
              out.push(<Text key={c}>{'  '}</Text>);
            }
          }
          return out;
        })()}
      </Box>
      {heatmap.rows.map((row, ri) => (
        <Box key={ri}>
          <Text color={theme.text.secondary}>{row.label}</Text>
          {row.cells.map((cell, ci) => (
            <Text
              key={ci}
              backgroundColor={
                cell.intensity > 0 ? HEATMAP_COLORS[cell.intensity] : undefined
              }
              underline={cell.isToday}
            >
              {cell.char}
            </Text>
          ))}
        </Box>
      ))}
      <Text> </Text>
      <Box>
        <Text color={theme.text.secondary}>
          {'    '}
          {t('Less')}{' '}
        </Text>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <Text
            key={level}
            backgroundColor={level > 0 ? HEATMAP_COLORS[level] : undefined}
          >
            {level === 0 ? '\u00B7\u00B7' : '  '}
          </Text>
        ))}
        <Text color={theme.text.secondary}> {t('More')}</Text>
      </Box>
    </Box>
  );
};
