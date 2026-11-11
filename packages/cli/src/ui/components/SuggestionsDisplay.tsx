/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { ExpandableText, MAX_WIDTH } from './shared/ExpandableText.js';
import { CommandKind } from '../commands/types.js';
import { Colors } from '../colors.js';
import { sanitizeForDisplay } from '../utils/textUtils.js';
import { HorizontalLine } from './shared/HorizontalLine.js';
import { figures } from '../utils/figures.js';

export interface Suggestion {
  label: string;
  value: string;
  insertValue?: string;
  description?: string;
  /**
   * Optional explicit colour for `description`. When set, the description
   * cell is rendered in this colour instead of inheriting the row's
   * active/inactive title colour. Used by the directory picker so the
   * scope tag (session / project / user / …) keeps the same colour as in
   * the Trust tab listing.
   */
  descriptionColor?: string;
  matchedIndex?: number;
  commandKind?: CommandKind;
  submitValue?: string;
  /**
   * Optional source annotation rendered as `(name)` between the label and
   * description in slash-command popups. Used to disambiguate same-name
   * commands from different plugins / MCP servers.
   */
  sourceLabel?: string;
}
export interface SuggestionsDisplayProps {
  suggestions: Suggestion[];
  activeIndex: number;
  isLoading: boolean;
  width: number;
  reservedHeight?: number;
  scrollOffset: number;
  userInput: string;
  mode: 'reverse' | 'slash';
  expandedIndex?: number;
  showSeparator?: boolean;
}

export const MAX_SUGGESTIONS_TO_SHOW = 8;
export { MAX_WIDTH };

export function SuggestionsDisplay({
  suggestions,
  activeIndex,
  isLoading,
  width,
  reservedHeight,
  scrollOffset,
  userInput,
  mode,
  expandedIndex,
  showSeparator = true,
}: SuggestionsDisplayProps) {
  if (isLoading) {
    return (
      <Box paddingX={1} width={width}>
        <Text color="gray">Loading suggestions...</Text>
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

  const COMMAND_KIND_PREFIX: Partial<Record<CommandKind, string>> = {
    [CommandKind.MCP_PROMPT]: '[MCP] ',
    [CommandKind.AGENT]: '[Agent] ',
    [CommandKind.WORKFLOW]: '[Workflow] ',
  };

  const getFullLabel = (s: Suggestion) =>
    (s.commandKind ? (COMMAND_KIND_PREFIX[s.commandKind] ?? '') : '') + s.label;

  const maxLabelLength = Math.max(
    ...suggestions.map((s) => getFullLabel(s).length),
  );
  const commandColumnWidth =
    mode === 'slash' ? Math.min(maxLabelLength, Math.floor(width * 0.5)) : 0;

  const canScrollUp = scrollOffset > 0;
  const canScrollDown = endIndex < suggestions.length;
  const fillerHeight = Math.max(
    0,
    (reservedHeight ?? 0) -
      visibleSuggestions.length -
      (showSeparator ? 1 : 0),
  );

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      width={width}
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      borderColor={theme.text.secondary}
    >
      {visibleSuggestions.map((suggestion, index) => {
        const originalIndex = startIndex + index;
        const isActive = originalIndex === activeIndex;
        const isExpanded = originalIndex === expandedIndex;
        const isFirstVisible = index === 0;
        const isLastVisible = index === visibleSuggestions.length - 1;
        const textColor = isActive ? theme.text.accent : theme.text.secondary;
        const isLong = suggestion.label.length >= MAX_WIDTH;

        // Inline scroll arrow or selection indicator (mirrors SettingsListPanel)
        let indicator: string;
        let indicatorColor: string;
        if (isFirstVisible && canScrollUp) {
          indicator = '▲';
          indicatorColor = theme.text.secondary;
        } else if (isLastVisible && canScrollDown) {
          indicator = '▼';
          indicatorColor = theme.text.secondary;
        } else if (isActive) {
          indicator = figures.pointer;
          indicatorColor = textColor;
        } else {
          indicator = ' ';
          indicatorColor = theme.text.secondary;
        }

        const labelElement = (
          <ExpandableText
            label={suggestion.label}
            matchedIndex={suggestion.matchedIndex}
            userInput={userInput}
            textColor={textColor}
            isExpanded={isExpanded}
          />
        );

        return (
          <Box
            key={`${suggestion.value}-${originalIndex}`}
            flexDirection="column"
          >
            <Box
              flexDirection="row"
              flexWrap="nowrap"
              height={1}
              overflow="hidden"
            >
              <Box
                height={1}
                overflow="hidden"
                {...(mode === 'slash'
                  ? {
                      width: commandColumnWidth + 2,
                      flexShrink: 0 as const,
                    }
                  : {
                      flexShrink: 1 as const,
                    })}
              >
                <Text color={indicatorColor}>{indicator} </Text>
                <Box height={1} overflow="hidden">
                  {suggestion.commandKind &&
                    COMMAND_KIND_PREFIX[suggestion.commandKind] && (
                      <Text color={textColor}>
                        {COMMAND_KIND_PREFIX[suggestion.commandKind]}
                      </Text>
                    )}
                  {labelElement}
                </Box>
              </Box>

              {suggestion.sourceLabel && (
                <Box
                  flexShrink={0}
                  paddingLeft={3}
                  width={Math.min(suggestion.sourceLabel.length + 2, 24)}
                  height={1}
                  overflow="hidden"
                >
                  <Text color={textColor} wrap="truncate-end">
                    ({suggestion.sourceLabel})
                  </Text>
                </Box>
              )}

              {suggestion.description && (
                <Box
                  flexGrow={1}
                  flexShrink={1}
                  paddingLeft={3}
                  height={1}
                  overflow="hidden"
                >
                  <Text
                    color={suggestion.descriptionColor ?? textColor}
                    bold={Boolean(suggestion.descriptionColor)}
                    wrap="truncate-end"
                  >
                    {sanitizeForDisplay(suggestion.description, 100)}
                  </Text>
                </Box>
              )}

              {isActive && isLong && (
                <Box width={3} flexShrink={0}>
                  <Text color={Colors.Gray}>{isExpanded ? ' ← ' : ' → '}</Text>
                </Box>
              )}
            </Box>
          </Box>
        );
      })}
      {fillerHeight > 0 && <Box height={fillerHeight} />}
      {showSeparator && (
        <Box width="100%">
          <HorizontalLine dim />
        </Box>
      )}
    </Box>
  );
}
