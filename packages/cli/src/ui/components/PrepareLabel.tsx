/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { prepareSuggestionLabel } from '../utils/suggestions.js';

export { MAX_SUGGESTION_LABEL_WIDTH as MAX_WIDTH } from '../utils/suggestions.js';

export interface PrepareLabelProps {
  label: string;
  matchedIndex?: number;
  userInput: string;
  textColor: string;
  isExpanded?: boolean;
}

const _PrepareLabel: React.FC<PrepareLabelProps> = ({
  label,
  matchedIndex,
  userInput,
  textColor,
  isExpanded = false,
}) => {
  const { before, match, after } = prepareSuggestionLabel(
    label,
    matchedIndex,
    userInput,
    isExpanded,
  );

  return (
    <Text color={textColor} wrap="wrap">
      {before}
      {match
        ? match.split(/(\s+)/).map((part, index) => (
            <Text
              key={`match-${index}`}
              color={theme.background.primary}
              backgroundColor={theme.text.primary}
            >
              {part}
            </Text>
          ))
        : null}
      {after}
    </Text>
  );
};

export const PrepareLabel = React.memo(_PrepareLabel);
