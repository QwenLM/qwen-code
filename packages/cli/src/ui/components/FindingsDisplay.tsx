/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type {
  FindingsResultDisplay,
  ReportedFinding,
} from '@qwen-code/qwen-code-core';
import { Colors } from '../colors.js';
import { ICON } from '../constants.js';

interface FindingsDisplayProps {
  data: FindingsResultDisplay;
}

const SEVERITY_COLORS: Record<ReportedFinding['severity'], () => string> = {
  Critical: () => Colors.AccentRed,
  Suggestion: () => Colors.AccentYellow,
  'Nice to have': () => Colors.Gray,
};

const OUTCOME_LABELS: Record<
  NonNullable<ReportedFinding['outcome']>,
  string
> = {
  fixed: 'fixed',
  skipped: 'skipped',
  no_change_needed: 'no change needed',
};

export const FindingsDisplay: React.FC<FindingsDisplayProps> = ({ data }) => {
  if (data.findings.length === 0) {
    return (
      <Box>
        <Text color={Colors.Gray}>No findings.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {data.findings.map((finding, index) => (
        <FindingRow
          key={finding.id ?? `${finding.file}:${finding.line ?? ''}:${index}`}
          finding={finding}
        />
      ))}
    </Box>
  );
};

const FindingRow: React.FC<{ finding: ReportedFinding }> = ({ finding }) => {
  const severityColor = SEVERITY_COLORS[finding.severity]();
  const resolved =
    finding.outcome === 'fixed' || finding.outcome === 'no_change_needed';
  const icon =
    finding.outcome === undefined
      ? ICON.CIRCLE_FILLED
      : resolved
        ? ICON.CHECK
        : ICON.CIRCLE_EMPTY;
  const where = `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`;

  return (
    <Box flexDirection="row" minHeight={1}>
      <Box width={3} flexShrink={0}>
        <Text color={resolved ? Colors.AccentGreen : severityColor}>
          {icon}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap">
          <Text color={severityColor} bold={finding.severity === 'Critical'}>
            {finding.severity}
          </Text>
          <Text color={Colors.Gray}>{finding.id ? ` ${finding.id}` : ''} </Text>
          <Text color={Colors.AccentCyan}>{where}</Text>
          <Text color={Colors.Foreground} strikethrough={resolved}>
            {' '}
            {finding.shortSummary}
          </Text>
          {finding.confidence === 'low' && (
            <Text color={Colors.Gray}> (low confidence)</Text>
          )}
          {finding.outcome && (
            <Text color={resolved ? Colors.AccentGreen : Colors.AccentYellow}>
              {' '}
              ({OUTCOME_LABELS[finding.outcome]}
              {finding.outcome === 'skipped' && finding.outcomeNote
                ? `: ${finding.outcomeNote}`
                : ''}
              )
            </Text>
          )}
        </Text>
      </Box>
    </Box>
  );
};
