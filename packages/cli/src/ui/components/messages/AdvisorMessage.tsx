/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AdvisorReviewDisplay } from '@qwen-code/qwen-code-core';
import { Colors } from '../../colors.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

export interface AdvisorDisplayProps {
  /** The reviewer's markdown review. */
  text: string;
  /** Resolved model id that produced the review; shown in the header. */
  model: string;
  /** Width of the parent container. Falls back to terminal width. */
  containerWidth?: number;
}

export interface AdvisorReviewCardProps {
  review: AdvisorReviewDisplay;
  containerWidth: number;
}

// border(1)*2 + paddingX(1)*2 = 4
const ADVISOR_SELF_CHROME = 4;

const ADVISOR_REVIEW_SECTIONS: ReadonlyArray<{
  title: string;
  field: keyof Omit<AdvisorReviewDisplay, 'type'>;
}> = [
  { title: 'Verdict', field: 'verdict' },
  { title: 'Risks', field: 'risks' },
  { title: 'Missing evidence', field: 'missingEvidence' },
  { title: 'Recommendation', field: 'recommendation' },
];

export const AdvisorReviewCard: React.FC<AdvisorReviewCardProps> = ({
  review,
  containerWidth,
}) => {
  const contentWidth = Math.max(2, containerWidth - ADVISOR_SELF_CHROME);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentCyan}
      paddingX={1}
      width="100%"
    >
      <Text color={Colors.AccentCyan} bold>
        Advisor feedback
      </Text>
      {ADVISOR_REVIEW_SECTIONS.map(({ title, field }) => (
        <Box key={field} flexDirection="column" marginTop={1}>
          <Text bold>{title}</Text>
          <MarkdownDisplay
            text={review[field]}
            isPending={false}
            contentWidth={contentWidth}
          />
        </Box>
      ))}
    </Box>
  );
};

const AdvisorMessageInternal: React.FC<AdvisorDisplayProps> = ({
  text,
  model,
  containerWidth,
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  const baseWidth = containerWidth ?? terminalWidth;
  const contentWidth = Math.max(2, baseWidth - ADVISOR_SELF_CHROME);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={Colors.AccentCyan}
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="row">
        <Text color={Colors.AccentCyan} bold>
          {'/advisor'}
        </Text>
        <Text color={Colors.AccentCyan}>{` · ${model}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <MarkdownDisplay
          text={text}
          isPending={false}
          contentWidth={contentWidth}
        />
      </Box>
    </Box>
  );
};

export const AdvisorMessage = React.memo(AdvisorMessageInternal);
