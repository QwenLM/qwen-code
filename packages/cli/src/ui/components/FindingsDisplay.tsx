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

// Every interpolated value renders through this: `outcomeNote` legitimately
// carries line whitespace, and any control character that survived the
// validator could forge or overwrite lines that read as trusted findings.
function terminalSafe(text: string): string {
  /* eslint-disable no-control-regex -- C0/DEL/C1 controls are exactly what this strips */
  const withoutControls = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
  /* eslint-enable no-control-regex */
  return withoutControls.replace(/\s+/g, ' ').trim();
}

const OUTCOME_LABELS: Record<
  NonNullable<ReportedFinding['outcome']>,
  string
> = {
  fixed: 'fixed',
  skipped: 'skipped',
  no_change_needed: 'no change needed',
};

export const FindingsDisplay: React.FC<FindingsDisplayProps> = ({ data }) => (
  // The unverified banner precedes the empty-state branch: an empty list is
  // still the product of the pass that reported it, and a low-effort "no
  // findings" that renders without the marker reads as a verified clean bill.
  <Box flexDirection="column">
    {data.level === 'low' && (
      <Box minHeight={1}>
        <Text color={Colors.Gray}>
          (low-effort pass — findings are unverified)
        </Text>
      </Box>
    )}
    {data.findings.length === 0 ? (
      <Text color={Colors.Gray}>No findings.</Text>
    ) : (
      data.findings.map((finding, index) => (
        <FindingRow
          key={finding.id ?? `${finding.file}:${finding.line ?? ''}:${index}`}
          finding={finding}
        />
      ))
    )}
    {data.omittedFindings !== undefined && data.omittedFindings > 0 && (
      <Text color={Colors.Gray}>
        {`(+${data.omittedFindings} more finding${data.omittedFindings === 1 ? '' : 's'} removed by history compaction)`}
      </Text>
    )}
  </Box>
);

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
  const where = terminalSafe(
    `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ''}`,
  );

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
          <Text color={Colors.Gray}>
            {finding.id ? ` ${terminalSafe(finding.id)}` : ''}{' '}
          </Text>
          <Text color={Colors.AccentCyan}>{where}</Text>
          <Text color={Colors.Foreground} strikethrough={resolved}>
            {' '}
            {terminalSafe(finding.shortSummary)}
          </Text>
          {finding.confidence === 'low' && (
            <Text color={Colors.Gray}> (low confidence)</Text>
          )}
          {finding.outcome && (
            <Text color={resolved ? Colors.AccentGreen : Colors.AccentYellow}>
              {' '}
              ({OUTCOME_LABELS[finding.outcome]}
              {finding.outcome === 'skipped' && finding.outcomeNote
                ? `: ${terminalSafe(finding.outcomeNote)}`
                : ''}
              )
            </Text>
          )}
        </Text>
      </Box>
    </Box>
  );
};
