/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { type ToolDefinition } from '../../types.js';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { t } from '../../../i18n/index.js';

interface ToolsListProps {
  tools: readonly ToolDefinition[];
  showDescriptions: boolean;
  contentWidth: number;
  /**
   * Whether `tool_search` is registered. Defaults to true so callers that
   * predate the flag keep the original footnote.
   */
  toolSearchAvailable?: boolean;
}

export const ToolsList: React.FC<ToolsListProps> = ({
  tools,
  showDescriptions,
  contentWidth,
  toolSearchAvailable = true,
}) => (
  <Box flexDirection="column">
    <Text bold color={theme.text.primary}>
      {t('Available Qwen Code CLI tools:')}
    </Text>
    <Box height={1} />
    {tools.length > 0 ? (
      tools.map((tool) => (
        <Box key={tool.name} flexDirection="row">
          <Text color={theme.text.primary}>{'  '}- </Text>
          <Box flexDirection="column">
            <Text bold color={theme.text.accent}>
              {tool.displayName}
              {showDescriptions ? ` (${tool.name})` : ''}
              {tool.deferred ? (
                <Text bold={false} color={theme.text.secondary}>
                  {' '}
                  {t('(on demand)')}
                </Text>
              ) : null}
            </Text>
            {showDescriptions && tool.description && (
              <MarkdownDisplay
                contentWidth={contentWidth}
                text={tool.description}
                isPending={false}
              />
            )}
          </Box>
        </Box>
      ))
    ) : (
      <Text color={theme.text.primary}> {t('No tools available')}</Text>
    )}
    {tools.some((tool) => tool.deferred) && (
      <>
        <Box height={1} />
        <Text color={theme.text.secondary}>
          {'  '}
          {toolSearchAvailable
            ? t(
                'Tools marked "(on demand)" stay available but are not offered to the model upfront; it loads them via tool_search when needed. Set tools.eager to choose which eager-by-default schemas stay upfront, or tools.visible to surface an on-demand tool at startup.',
              )
            : t(
                'Tools marked "(on demand)" are not offered to the model upfront, and tool_search is not enabled this session — so the model cannot load them at all until you restart. Enable tools.toolSearch.enabled, or list the tool in tools.eager (built-ins) or tools.visible (on-demand tools) to send its schema upfront.',
              )}
        </Text>
      </>
    )}
  </Box>
);
