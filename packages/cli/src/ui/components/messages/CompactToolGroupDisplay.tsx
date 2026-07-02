/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import type { AnsiOutputDisplay } from '@qwen-code/qwen-code-core';
import { ToolDisplayNames } from '@qwen-code/qwen-code-core';
import { t } from '../../../i18n/index.js';
import { SHELL_COMMAND_NAME } from '../../constants.js';
import { ToolStatusIndicator } from '../shared/ToolStatusIndicator.js';
import { ToolElapsedTime } from '../shared/ToolElapsedTime.js';

interface CompactToolGroupDisplayProps {
  toolCalls: IndividualToolCallDisplay[];
  contentWidth: number;
}

// Priority: Confirming > Executing > Error > Canceled > Pending > Success
export function getOverallStatus(
  toolCalls: IndividualToolCallDisplay[],
): ToolCallStatus {
  if (toolCalls.some((t) => t.status === ToolCallStatus.Confirming))
    return ToolCallStatus.Confirming;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Executing))
    return ToolCallStatus.Executing;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Error))
    return ToolCallStatus.Error;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Canceled))
    return ToolCallStatus.Canceled;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Pending))
    return ToolCallStatus.Pending;
  return ToolCallStatus.Success;
}

// Active tool priority: Confirming > Executing > last in array
function getActiveTool(
  toolCalls: IndividualToolCallDisplay[],
): IndividualToolCallDisplay {
  return (
    toolCalls.find((t) => t.status === ToolCallStatus.Confirming) ??
    toolCalls.find((t) => t.status === ToolCallStatus.Executing) ??
    toolCalls[toolCalls.length - 1]
  );
}

function getShellTimeoutMs(
  tool: IndividualToolCallDisplay,
): number | undefined {
  const display = tool.resultDisplay;
  if (
    typeof display === 'object' &&
    display !== null &&
    'ansiOutput' in display
  ) {
    return (display as AnsiOutputDisplay).timeoutMs;
  }
  return undefined;
}

type ToolCategory =
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'list'
  | 'command'
  | 'agent'
  | 'other';

const TOOL_NAME_TO_CATEGORY: Record<string, ToolCategory> = {
  [ToolDisplayNames.READ_FILE]: 'read',
  [ToolDisplayNames.EDIT]: 'edit',
  [ToolDisplayNames.WRITE_FILE]: 'write',
  [ToolDisplayNames.NOTEBOOK_EDIT]: 'edit',
  [ToolDisplayNames.GREP]: 'search',
  [ToolDisplayNames.GLOB]: 'search',
  [ToolDisplayNames.LS]: 'list',
  [ToolDisplayNames.SHELL]: 'command',
  [SHELL_COMMAND_NAME]: 'command',
  [ToolDisplayNames.AGENT]: 'agent',
  [ToolDisplayNames.WORKFLOW]: 'agent',
  [ToolDisplayNames.SEND_MESSAGE]: 'agent',
  'Read File': 'read',
  'Read File(s)': 'read',
  'Read Directory': 'list',
  // Legacy display names (keys from ToolDisplayNamesMigration)
  SearchFiles: 'search',
  FindFiles: 'search',
  ReadFolder: 'list',
  Task: 'agent',
  TodoWrite: 'other',
};

type SummaryForms = { one: string; many: string };
type CategoryTemplate = {
  // i18n keys (also the English source strings). `{{count}}` is interpolated
  // via t() so every locale supplies a natural phrase — keep these as literals
  // here so they stay greppable and aligned with the locale files.
  past: SummaryForms;
  active: SummaryForms;
};

const CATEGORY_TEMPLATES: Record<ToolCategory, CategoryTemplate> = {
  read: {
    past: { one: 'Read {{count}} file', many: 'Read {{count}} files' },
    active: { one: 'Reading {{count}} file', many: 'Reading {{count}} files' },
  },
  edit: {
    past: { one: 'Edited {{count}} file', many: 'Edited {{count}} files' },
    active: { one: 'Editing {{count}} file', many: 'Editing {{count}} files' },
  },
  write: {
    past: { one: 'Wrote {{count}} file', many: 'Wrote {{count}} files' },
    active: { one: 'Writing {{count}} file', many: 'Writing {{count}} files' },
  },
  search: {
    past: {
      one: 'Searched {{count}} pattern',
      many: 'Searched {{count}} patterns',
    },
    active: {
      one: 'Searching {{count}} pattern',
      many: 'Searching {{count}} patterns',
    },
  },
  list: {
    past: {
      one: 'Listed {{count}} directory',
      many: 'Listed {{count}} directories',
    },
    active: {
      one: 'Listing {{count}} directory',
      many: 'Listing {{count}} directories',
    },
  },
  command: {
    past: { one: 'Ran {{count}} command', many: 'Ran {{count}} commands' },
    active: {
      one: 'Running {{count}} command',
      many: 'Running {{count}} commands',
    },
  },
  agent: {
    past: { one: 'Ran {{count}} agent', many: 'Ran {{count}} agents' },
    active: {
      one: 'Running {{count}} agent',
      many: 'Running {{count}} agents',
    },
  },
  other: {
    past: { one: 'Used {{count}} tool', many: 'Used {{count}} tools' },
    active: { one: 'Using {{count}} tool', many: 'Using {{count}} tools' },
  },
};

const CATEGORY_ORDER: ToolCategory[] = [
  'search',
  'read',
  'list',
  'command',
  'edit',
  'write',
  'agent',
  'other',
];

const COLLAPSIBLE_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  'read',
  'search',
  'list',
]);

function getToolCategory(toolName: string): ToolCategory {
  return TOOL_NAME_TO_CATEGORY[toolName] ?? 'other';
}

/**
 * Whether a tool is information-gathering (read/search/list) vs mutation/action.
 *
 * Used at two decision points:
 * 1. ToolGroupMessage — partitions collapsible tools into a summary line
 * 2. ToolMessage.shouldCollapseResult — hides completed text/ANSI output
 *
 * Adding a category here suppresses individual rendering AND result output
 * for completed tools of that type. Only add categories whose results are
 * disposable (file contents, search hits) — never agent/command results.
 */
export function isCollapsibleTool(toolName: string): boolean {
  return COLLAPSIBLE_CATEGORIES.has(getToolCategory(toolName));
}

/**
 * Build a semantic summary line from a batch of tool calls.
 *
 * Single tool  → "Read 1 file" / "Ran 1 command"
 * Multi  same  → "Read 3 files"
 * Multi mixed  → "Read 3 files, edited 2 files, ran 1 command"
 *
 * Uses past tense when all tools are done, present progressive when active.
 */
export function buildToolSummary(
  toolCalls: IndividualToolCallDisplay[],
  isActive: boolean,
): string {
  if (toolCalls.length === 0) return '';

  // Group by category and count
  const counts = new Map<ToolCategory, number>();

  for (const tool of toolCalls) {
    const cat = getToolCategory(tool.name);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const count = counts.get(cat);
    if (!count) continue;

    const forms = isActive
      ? CATEGORY_TEMPLATES[cat].active
      : CATEGORY_TEMPLATES[cat].past;
    const key = count === 1 ? forms.one : forms.many;
    let part = t(key, { count: String(count) });
    // Lowercase the leading character for every part after the first ("Read 3
    // files, edited 2 files"). Operating on the first char only keeps already-
    // lowercase nouns intact and is a no-op for caseless scripts (e.g. CJK).
    if (parts.length > 0) {
      part = part.charAt(0).toLowerCase() + part.slice(1);
    }
    parts.push(part);
  }

  return parts.join(', ');
}

export const CompactToolGroupDisplay: React.FC<
  CompactToolGroupDisplayProps
> = ({ toolCalls, contentWidth }) => {
  if (toolCalls.length === 0) return null;

  const overallStatus = getOverallStatus(toolCalls);
  const activeTool = getActiveTool(toolCalls);
  const isActive =
    overallStatus === ToolCallStatus.Executing ||
    overallStatus === ToolCallStatus.Pending ||
    overallStatus === ToolCallStatus.Confirming;

  return (
    <Box flexDirection="column" width={contentWidth} paddingX={1} gap={0}>
      <Box flexDirection="row">
        <ToolStatusIndicator status={overallStatus} name={activeTool.name} />
        <Box flexGrow={1}>
          <Text wrap="truncate-end" bold>
            {buildToolSummary(toolCalls, isActive)}
            {isActive && <Text key="ellipsis">…</Text>}
          </Text>
        </Box>
        <ToolElapsedTime
          status={overallStatus}
          executionStartTime={activeTool.executionStartTime}
          timeoutMs={getShellTimeoutMs(activeTool)}
        />
      </Box>
    </Box>
  );
};
