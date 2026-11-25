/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { I18nService } from '@qwen-code/core';

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { type MCPServerConfig } from '@qwen-code/core';
import { useI18nService } from '../i18n/index.js';

interface ContextSummaryDisplayProps {
  memoryMdFileCount: number;
  contextFileNames: string[];
  mcpServers?: Record<string, MCPServerConfig>;
  blockedMcpServers?: Array<{ name: string; pluginName: string }>;
  needsAuthServerCount?: number;
  failedMcpServerCount?: number;
  skillCount: number;
  backgroundProcessCount?: number;
}

interface ContextSummaryParts {
  /** Ordered, non-empty summary segments joined with " · " for display. */
  summaryParts: string[];
  /** The MCP segment (if any); used to anchor the auth-warning marker. */
  mcpText: string;
  /** Whether the MCP segment should show the auth-needed warning marker. */
  mcpNeedsAuth: boolean;
}

/**
 * Pure helper that computes the ordered context-summary segments. Shared by the
 * full-width {@link ContextSummaryDisplay} component and any single-line consumer
 * (e.g. the rotating info line) so the formatting/pluralization stays in one place.
 */
export function computeContextSummaryParts(
  {
    memoryMdFileCount,
    contextFileNames,
    mcpServers,
    blockedMcpServers,
    needsAuthServerCount = 0,
    failedMcpServerCount = 0,
    skillCount,
    backgroundProcessCount = 0,
  }: ContextSummaryDisplayProps,
  t: I18nService['get'],
): ContextSummaryParts {
  const mcpServerCount = Object.keys(mcpServers || {}).length;
  const blockedMcpServerCount = blockedMcpServers?.length || 0;

  const geminiMdText = (() => {
    if (memoryMdFileCount === 0) {
      return '';
    }
    const allNamesTheSame = new Set(contextFileNames).size < 2;
    if (!allNamesTheSame) {
      return t(
        memoryMdFileCount === 1
          ? 'status.summary.contextFallback.one'
          : 'status.summary.contextFallback.many',
        { count: memoryMdFileCount },
      );
    }
    const name = contextFileNames[0];
    return t(
      memoryMdFileCount === 1
        ? 'status.summary.contextFile.one'
        : 'status.summary.contextFile.many',
      { count: memoryMdFileCount, name },
    );
  })();

  const mcpText = (() => {
    if (mcpServerCount === 0 && blockedMcpServerCount === 0) {
      return '';
    }

    const parts = [];
    if (mcpServerCount > 0) {
      parts.push(
        t(
          mcpServerCount === 1
            ? 'status.summary.mcp.one'
            : 'status.summary.mcp.many',
          { count: mcpServerCount },
        ),
      );
    }

    if (failedMcpServerCount > 0) {
      parts.push(t('status.summary.failed', { count: failedMcpServerCount }));
    }
    if (blockedMcpServerCount > 0) {
      const blockedText =
        mcpServerCount === 0
          ? t(
              blockedMcpServerCount === 1
                ? 'status.summary.blockedMcp.one'
                : 'status.summary.blockedMcp.many',
              { count: blockedMcpServerCount },
            )
          : t('status.summary.blocked', { count: blockedMcpServerCount });
      parts.push(blockedText);
    }
    return parts.join(', ');
  })();

  const mcpNeedsAuth = needsAuthServerCount > 0 && mcpServerCount > 0;

  const skillText = (() => {
    if (skillCount === 0) {
      return '';
    }
    return t(
      skillCount === 1
        ? 'status.summary.skill.one'
        : 'status.summary.skill.many',
      { count: skillCount },
    );
  })();

  const backgroundText = (() => {
    if (backgroundProcessCount === 0) {
      return '';
    }
    return t(
      backgroundProcessCount === 1
        ? 'status.summary.background.one'
        : 'status.summary.background.many',
      { count: backgroundProcessCount },
    );
  })();

  const summaryParts = [
    geminiMdText,
    mcpText,
    skillText,
    backgroundText,
  ].filter(Boolean);

  return { summaryParts, mcpText, mcpNeedsAuth };
}

/**
 * Build the context summary as a single plain string (segments joined with
 * " · "), e.g. "2 AGENTS.md files · 1 MCP server · 25 skills". Returns '' when
 * there is nothing to show. Note: the MCP auth-needed warning marker (" !") is
 * intentionally dropped in the plain-string form since it carries no color here.
 */
export function buildContextSummaryString(
  props: ContextSummaryDisplayProps,
  t: I18nService['get'],
): string {
  return computeContextSummaryParts(props, t).summaryParts.join(' · ');
}

export const ContextSummaryDisplay: React.FC<ContextSummaryDisplayProps> = (
  props,
) => {
  const i18n = useI18nService();
  const { summaryParts, mcpText, mcpNeedsAuth } = computeContextSummaryParts(
    props,
    i18n.get,
  );

  if (summaryParts.length === 0) {
    return null;
  }

  return (
    <Box height={1} paddingX={1} overflow="hidden">
      <Text color={theme.text.secondary} wrap="truncate-end">
        {summaryParts.map((part, index) => (
          <Text key={index} color={theme.text.secondary}>
            {index > 0 ? ' · ' : ''}
            {part}
            {part === mcpText && mcpNeedsAuth && (
              <Text color={theme.status.warning}>{' !'}</Text>
            )}
          </Text>
        ))}
      </Text>
    </Box>
  );
};
