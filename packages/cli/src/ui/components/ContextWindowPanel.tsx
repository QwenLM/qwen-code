/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview TUI component that visualises context window usage.
 *
 * Two tabs:
 *   - "Context Window": progress bar + per-category token breakdown + session stats
 *   - "Skills": per-skill frontmatter token breakdown grouped by source
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { theme } from '../semantic-colors.js';
import {
  calculateTokenWarningStateForContextWindow,
  getAutoCompactThresholdForContextWindow,
  getRawContextWindowSize,
  getSummaryReserveTokens,
  getDisplayString,
  type PromptBuildResult,
  type SkillSource,
} from '@qwen-code/core';
import {
  getModelMessageTokens,
  type TokenStats,
} from '../../utils/analyzeContext.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { useConfig, useModel } from '../contexts/ConfigContext.js';
import { figures } from '../utils/figures.js';
import { SKILL_SOURCE_LABELS } from '../../utils/skillUtils.js';
import { formatContextWindowValueLabel } from '../utils/contextWindow.js';

// ---------------------------------------------------------------------------
// Public types (re-exported for contextCommand.tsx)
// ---------------------------------------------------------------------------

export interface SkillDetail {
  name: string;
  source: SkillSource;
  tokens: number;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ContextWindowPanelProps {
  model: string;
  /**
   * The session's configured context window for `model`. The panel cannot
   * resolve this itself — it has no `Config` — and the core threshold helpers
   * no longer read one from a process global.
   */
  contextWindowSize?: number;
  tokenUsage: number;
  messageCount: number;
  tokenStats: TokenStats;
  systemPromptTokens: number;
  toolSchemaTokens: number;
  skillDetails: SkillDetail[];
  skillFrontmatterTokens: number;
  /** Undefined until the first turn has built a prompt. */
  promptBuild?: PromptBuildResult;
  sessionStats: SessionStatsState;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function calcPct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.min(100, Math.round((numerator / denominator) * 1000) / 10);
}

function formatPct(tokens: number, total: number): string {
  return `${calcPct(tokens, total)}%`;
}

function shortPath(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return filePath;
  return `…/${parts.slice(-2).join('/')}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatRow({
  label,
  value,
  valueColor,
  labelWidth = 20,
  dot,
}: {
  label: string;
  value: string;
  valueColor?: string;
  labelWidth?: number;
  dot?: { char: string; color: string };
}): React.JSX.Element {
  return (
    <Box flexDirection="row" paddingLeft={1}>
      {dot ? (
        <Text color={dot.color}>{dot.char + ' '}</Text>
      ) : (
        <Text>{'  '}</Text>
      )}
      <Box width={labelWidth}>
        <Text color={theme.text.secondary}>{label}</Text>
      </Box>
      <Text color={valueColor ?? theme.text.primary}>{value}</Text>
    </Box>
  );
}

function SectionHeader({ title }: { title: string }): React.JSX.Element {
  return (
    <Box paddingLeft={1} marginTop={1}>
      <Text color={theme.text.secondary} dimColor>
        {title}
      </Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

const DOT_FILLED = '⊙';
const DOT_EMPTY = figures.circle;
const DOT_BLOCKED = '⊗';

const DOT_BLUE = { char: DOT_FILLED, color: '#5c8ce1' };
const DOT_SKILLS = { char: DOT_FILLED, color: '#e1a85c' };
const DOT_MESSAGES = { char: DOT_FILLED, color: '#a05ce1' };
const DOT_OTHER = { char: DOT_FILLED, color: '#888888' };
const DOT_FREE = { char: DOT_EMPTY, color: '' };
const DOT_AUTOCOMPACT = { char: DOT_BLOCKED, color: '' };

// ---------------------------------------------------------------------------
// Skills grouping
// ---------------------------------------------------------------------------

const SOURCE_DISPLAY_ORDER = ['Project', 'User', 'Built-in', 'Plugin'];

/**
 * Group skills by source display name, returning groups in canonical order.
 * Expects `skills` to be pre-sorted by tokens desc (contextCommand guarantees this).
 */
function groupSkillsBySource(
  skills: SkillDetail[],
): Map<string, SkillDetail[]> {
  const groups = new Map<string, SkillDetail[]>();
  for (const skill of skills) {
    const key = SKILL_SOURCE_LABELS[skill.source] ?? 'Unknown';
    const existing = groups.get(key) ?? [];
    existing.push(skill);
    groups.set(key, existing);
  }
  const ordered = new Map<string, SkillDetail[]>();
  for (const source of SOURCE_DISPLAY_ORDER) {
    const group = groups.get(source);
    if (group) ordered.set(source, group);
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'context', label: 'Context Window' },
  { key: 'skills', label: 'Skills' },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ContextWindowPanel({
  model,
  contextWindowSize: sessionContextWindow,
  tokenUsage,
  messageCount,
  tokenStats,
  systemPromptTokens,
  toolSchemaTokens,
  skillDetails,
  skillFrontmatterTokens,
  promptBuild,
  sessionStats,
  onClose,
}: ContextWindowPanelProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState('context');
  const config = useConfig();
  const listed = useModel(config, model);

  const contextWindowSize = getRawContextWindowSize(
    listed,
    sessionContextWindow,
  );
  const warningContextWindowSize = Math.max(
    0,
    contextWindowSize - getSummaryReserveTokens(listed),
  );
  const autoCompactThreshold = getAutoCompactThresholdForContextWindow(
    warningContextWindowSize,
  );
  const warningState = calculateTokenWarningStateForContextWindow(
    tokenUsage,
    warningContextWindowSize,
  );

  const usedPercent =
    contextWindowSize > 0
      ? Math.min(100, Math.round((tokenUsage / contextWindowSize) * 100))
      : 0;

  // Reserved zone derived from the same auto-compact threshold core uses.
  const autoCompactBufferTokens = Math.max(
    0,
    contextWindowSize - autoCompactThreshold,
  );
  const remainingContextTokens = Math.max(0, contextWindowSize - tokenUsage);
  const displayedAutoCompactBufferTokens = Math.min(
    autoCompactBufferTokens,
    remainingContextTokens,
  );
  const freeTokens = remainingContextTokens - displayedAutoCompactBufferTokens;

  // Progress bar
  const BAR_WIDTH = 36;
  const filledCount = Math.round((usedPercent / 100) * BAR_WIDTH);
  const bar = '▓'.repeat(filledCount) + '░'.repeat(BAR_WIDTH - filledCount);

  let barColor = theme.status.success;
  if (warningState.isAtBlockingLimit || warningState.isAboveErrorThreshold)
    barColor = theme.status.error;
  else if (warningState.isAboveWarningThreshold)
    barColor = theme.status.warning;

  // toolRequests / toolResults maps feed the context-usage projection; their
  // tokens are already counted inside Messages (humanMessages /
  // assistantMessages), where "System tools" only covers tool-schema
  // definitions.

  const totalMessageTokens = getModelMessageTokens(tokenStats);

  const toolsMetrics = sessionStats.metrics?.tools;
  const filesMetrics = sessionStats.metrics?.files;
  const totalSessionToolCalls = toolsMetrics?.totalCalls ?? 0;
  const totalSessionToolSuccess = toolsMetrics?.totalSuccess ?? 0;
  const totalSessionToolFail = toolsMetrics?.totalFail ?? 0;
  const linesAdded = filesMetrics?.totalLinesAdded ?? 0;
  const linesRemoved = filesMetrics?.totalLinesRemoved ?? 0;

  const dupEntries = [...tokenStats.duplicateFileReads.entries()];

  const displayModel = model
    ? getDisplayString(listed, model)
    : 'unknown model';
  const LABEL_WIDTH = 18;

  const freeDot = { ...DOT_FREE, color: theme.text.secondary };
  const autoCompactDot = { ...DOT_AUTOCOMPACT, color: theme.status.error };

  const skillGroups = groupSkillsBySource(skillDetails);

  // -------------------------------------------------------------------------
  // Context Window tab
  // -------------------------------------------------------------------------
  const contextTab = (
    <Box flexDirection="column" paddingBottom={1}>
      <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
        <Text color={theme.text.secondary} dimColor>
          {displayModel}
          {contextWindowSize > 0
            ? ` · ${formatContextWindowValueLabel(contextWindowSize)} context`
            : ''}
        </Text>
        <Text color={theme.text.secondary} dimColor>
          Prompt: {promptBuild?.source ?? 'unavailable'}
          {promptBuild?.source === 'default' ? ` · ${promptBuild.bundle}` : ''}
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text color={barColor}>{bar}</Text>
          <Text color={barColor} bold={warningState.isAboveWarningThreshold}>
            {formatPct(tokenUsage, contextWindowSize)}
          </Text>
        </Box>
      </Box>

      <SectionHeader title="Estimated usage by category (local approximation)" />

      <StatRow
        label="System prompt:"
        value={formatPct(systemPromptTokens, contextWindowSize)}
        labelWidth={LABEL_WIDTH}
        dot={DOT_BLUE}
      />

      {toolSchemaTokens > 0 && (
        <StatRow
          label="System tools:"
          value={formatPct(toolSchemaTokens, contextWindowSize)}
          labelWidth={LABEL_WIDTH}
          dot={DOT_BLUE}
        />
      )}

      {skillFrontmatterTokens > 0 && (
        <StatRow
          label="Skills:"
          value={formatPct(skillFrontmatterTokens, contextWindowSize)}
          labelWidth={LABEL_WIDTH}
          dot={DOT_SKILLS}
        />
      )}

      {totalMessageTokens > 0 && (
        <StatRow
          label="Messages:"
          value={formatPct(totalMessageTokens, contextWindowSize)}
          labelWidth={LABEL_WIDTH}
          dot={DOT_MESSAGES}
        />
      )}

      {tokenStats.other > 0 && (
        <StatRow
          label="Other:"
          value={formatPct(tokenStats.other, contextWindowSize)}
          labelWidth={LABEL_WIDTH}
          dot={DOT_OTHER}
        />
      )}

      <StatRow
        label="Free space:"
        value={formatPct(freeTokens, contextWindowSize)}
        labelWidth={LABEL_WIDTH}
        dot={freeDot}
      />

      {autoCompactBufferTokens > 0 && (
        <StatRow
          label="Autocompact"
          value={formatPct(displayedAutoCompactBufferTokens, contextWindowSize)}
          labelWidth={LABEL_WIDTH}
          dot={autoCompactDot}
        />
      )}

      {dupEntries.length > 0 && (
        <>
          <Box paddingLeft={1} marginTop={1}>
            <Text color={theme.status.warning}>
              {'⚠ Duplicate file reads'}
            </Text>
          </Box>
          {dupEntries.slice(0, 3).map(([filePath, info]) => (
            <Box key={filePath} paddingLeft={3}>
              <Text color={theme.text.secondary} dimColor>
                {shortPath(filePath)} × {info.count} reads
              </Text>
            </Box>
          ))}
          {dupEntries.length > 3 && (
            <Box paddingLeft={3}>
              <Text color={theme.text.secondary} dimColor>
                … and {dupEntries.length - 3} more
              </Text>
            </Box>
          )}
        </>
      )}

      <SectionHeader title="Session stats" />
      <StatRow
        label="Messages:"
        value={`${messageCount}`}
        labelWidth={LABEL_WIDTH}
      />
      <StatRow
        label="Prompts:"
        value={`${sessionStats.promptCount}`}
        labelWidth={LABEL_WIDTH}
      />
      {totalSessionToolCalls > 0 && (
        <StatRow
          label="Tool calls:"
          value={`${totalSessionToolCalls} (${totalSessionToolSuccess} ok / ${totalSessionToolFail} fail)`}
          labelWidth={LABEL_WIDTH}
        />
      )}
      {(linesAdded > 0 || linesRemoved > 0) && (
        <StatRow
          label="Lines changed:"
          value={`+${linesAdded} / -${linesRemoved}`}
          valueColor={theme.status.success}
          labelWidth={LABEL_WIDTH}
        />
      )}
    </Box>
  );

  // -------------------------------------------------------------------------
  // Skills tab
  // -------------------------------------------------------------------------
  const skillsTab = (
    <Box flexDirection="column" paddingBottom={1}>
      {skillGroups.size === 0 ? (
        <Box paddingLeft={1}>
          <Text dimColor>No skills loaded.</Text>
        </Box>
      ) : (
        <>
          {Array.from(skillGroups.entries()).map(
            ([sourceDisplay, groupSkills]) => (
              <Box
                key={sourceDisplay}
                flexDirection="column"
                marginTop={1}
                paddingLeft={1}
              >
                <Text dimColor>{sourceDisplay}</Text>
                {groupSkills.map((skill) => (
                  <Box key={skill.name} paddingLeft={1}>
                    <Text>{'└ '}</Text>
                    <Text>{skill.name}</Text>
                    <Text
                      dimColor
                    >{` — ${calcPct(skill.tokens, skillFrontmatterTokens)}%`}</Text>
                  </Box>
                ))}
              </Box>
            ),
          )}
        </>
      )}
    </Box>
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <BaseTabDialog
      title="Context"
      tabs={TABS}
      activeKey={activeTab}
      onTabChange={setActiveTab}
      onClose={onClose}
    >
      {activeTab === 'context' ? contextTab : skillsTab}
    </BaseTabDialog>
  );
}
