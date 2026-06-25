/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { PrepareLabel, MAX_WIDTH } from './PrepareLabel.js';
import type {
  CommandKind,
  CommandSource,
  ExecutionMode,
} from '../commands/types.js';
import { Colors } from '../colors.js';
import { t } from '../../i18n/index.js';
export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  /** @deprecated Use source/sourceBadge instead. */
  commandKind?: CommandKind;
  source?: CommandSource;
  sourceLabel?: string;
  sourceBadge?: string;
  argumentHint?: string;
  matchedAlias?: string;
  supportedModes?: ExecutionMode[];
  modelInvocable?: boolean;
  /** Whether the suggestion represents a directory path. When true, handleAutocomplete should NOT append a trailing space so the user can continue tab-completing deeper into the directory tree. */
  isDirectory?: boolean;
  /**
   * When true, the input layer should submit `/<value>` immediately on
   * Enter-accept rather than just inserting the suggestion text and
   * waiting for a second Enter. Mirrors the `submitOnAccept` flag on the
   * underlying SlashCommand (see `commands/types.ts`). Used for parent
   * commands like `/skills` whose bare action just opens a dialog and
   * takes no further argument — typing `/skil<Enter>` should land in the
   * dialog in one keystroke.
   */
  submitOnAccept?: boolean;
}
interface SuggestionsDisplayProps {
  suggestions: Suggestion[];
  activeIndex: number;
  isLoading: boolean;
  width: number;
  scrollOffset: number;
  userInput: string;
  mode: 'reverse' | 'slash';
  expandedIndex?: number;
}

export const MAX_SUGGESTIONS_TO_SHOW = 8;
export { MAX_WIDTH };

/**
 * In @-mention mode a wide resource-reference column must still leave the row's
 * description at least this many columns, so an unusually long reference can't
 * shrink the description away entirely.
 */
const MIN_DESCRIPTION_WIDTH = 12;

/**
 * Collapse all runs of whitespace (including newlines from multi-line
 * SKILL.md/command descriptions) into single spaces so a description renders
 * as a single logical line. Without this, frontmatter line breaks are
 * preserved verbatim and a single long description can fill the whole terminal.
 */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

export function SuggestionsDisplay({
  suggestions,
  activeIndex,
  isLoading,
  width,
  scrollOffset,
  userInput,
  mode,
  expandedIndex,
}: SuggestionsDisplayProps) {
  if (isLoading) {
    return (
      <Box width={width}>
        <Text color="gray">{t('Loading suggestions...')}</Text>
      </Box>
    );
  }

  if (suggestions.length === 0) {
    return null; // Don't render anything if there are no suggestions
  }

  // Calculate the visible slice based on scrollOffset
  const startIndex = scrollOffset;
  const endIndex = Math.min(
    scrollOffset + MAX_SUGGESTIONS_TO_SHOW,
    suggestions.length,
  );
  const visibleSuggestions = suggestions.slice(startIndex, endIndex);

  const getFullLabel = (s: Suggestion) =>
    [s.label, s.argumentHint, s.sourceBadge].filter(Boolean).join(' ');

  const maxLabelLength = Math.max(
    ...suggestions.map((s) => getFullLabel(s).length),
  );
  // Width of the left label column. In slash mode every row shares one
  // half-width command column. In @-mention (reverse) mode only rows WITH a
  // description (MCP resources/servers) share a column — sized to the longest
  // such reference so the references stay intact and their descriptions line
  // up, capped so the description keeps a minimum readable width — while plain
  // file rows (no description) keep the full row width. The reference takes
  // priority over its description, which truncates.
  const describedLabelLengths = suggestions
    .filter((s) => s.description)
    .map((s) => getFullLabel(s).length);
  const labelColumnWidth =
    mode === 'slash'
      ? Math.min(maxLabelLength, Math.floor(width * 0.5))
      : describedLabelLengths.length > 0
        ? Math.min(
            Math.max(...describedLabelLengths),
            Math.max(width - MIN_DESCRIPTION_WIDTH - 2, 1),
          )
        : 0;

  return (
    <Box flexDirection="column" width={width}>
      {scrollOffset > 0 && <Text color={theme.text.primary}>▲</Text>}

      {visibleSuggestions.map((suggestion, index) => {
        const originalIndex = startIndex + index;
        const isActive = originalIndex === activeIndex;
        const isExpanded = originalIndex === expandedIndex;
        const textColor = isActive ? theme.text.accent : theme.text.secondary;
        const displayLabel = suggestion.label ?? suggestion.value;
        const isLong = displayLabel.length >= MAX_WIDTH;
        const expansionIndicatorWidth = isActive && isLong ? 3 : 0;
        const descriptionColumnWidth = Math.max(
          width - labelColumnWidth - 2 - expansionIndicatorWidth,
          1,
        );
        const labelElement = (
          <PrepareLabel
            label={displayLabel}
            matchedIndex={suggestion.matchedIndex}
            userInput={userInput}
            textColor={textColor}
            isExpanded={isExpanded}
          />
        );

        return (
          <Box key={`${suggestion.value}-${originalIndex}`} flexDirection="row">
            <Box
              {...(mode === 'slash' || suggestion.description
                ? { width: labelColumnWidth, flexShrink: 0 as const }
                : { flexShrink: 1 as const })}
            >
              <Box>
                {labelElement}
                {suggestion.argumentHint && (
                  <Text color={theme.text.secondary}>
                    {' '}
                    {suggestion.argumentHint}
                  </Text>
                )}
                {suggestion.sourceBadge && (
                  <Text color={textColor}> {suggestion.sourceBadge}</Text>
                )}
              </Box>
            </Box>

            {suggestion.description && (
              <Box
                width={descriptionColumnWidth}
                flexGrow={1}
                flexShrink={1}
                paddingLeft={2}
              >
                <Text color={textColor} wrap="truncate-end">
                  {normalizeDescription(suggestion.description)}
                </Text>
              </Box>
            )}
            {isActive && isLong && (
              <Box>
                <Text color={Colors.Gray}>{isExpanded ? ' ← ' : ' → '}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      {endIndex < suggestions.length && <Text color="gray">▼</Text>}
      {suggestions.length > MAX_SUGGESTIONS_TO_SHOW && (
        <Text color="gray">
          ({activeIndex + 1}/{suggestions.length})
        </Text>
      )}
    </Box>
  );
}
