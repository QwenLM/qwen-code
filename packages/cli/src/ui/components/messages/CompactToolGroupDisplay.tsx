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

type CategoryTemplate = {
  pastVerb: string;
  activeVerb: string;
  singular: string;
  plural: string;
};

const CATEGORY_TEMPLATES: Record<ToolCategory, CategoryTemplate> = {
  read: {
    pastVerb: 'Read',
    activeVerb: 'Reading',
    singular: 'file',
    plural: 'files',
  },
  edit: {
    pastVerb: 'Edited',
    activeVerb: 'Editing',
    singular: 'file',
    plural: 'files',
  },
  write: {
    pastVerb: 'Wrote',
    activeVerb: 'Writing',
    singular: 'file',
    plural: 'files',
  },
  search: {
    pastVerb: 'Searched',
    activeVerb: 'Searching',
    singular: 'pattern',
    plural: 'patterns',
  },
  list: {
    pastVerb: 'Listed',
    activeVerb: 'Listing',
    singular: 'directory',
    plural: 'directories',
  },
  command: {
    pastVerb: 'Ran',
    activeVerb: 'Running',
    singular: 'command',
    plural: 'commands',
  },
  agent: {
    pastVerb: 'Ran',
    activeVerb: 'Running',
    singular: 'agent',
    plural: 'agents',
  },
  other: {
    pastVerb: 'Used',
    activeVerb: 'Using',
    singular: 'tool',
    plural: 'tools',
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
 * Whether a tool should be collapsed into a summary line (read/search/list)
 * rather than rendered individually. Matches Claude Code's
 * `collapseReadSearchGroups` philosophy: only information-gathering tools
 * are collapsed; mutation tools (edit/write/command) always show individually.
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

    const template = CATEGORY_TEMPLATES[cat];
    const verb = isActive ? template.activeVerb : template.pastVerb;
    const lower = parts.length > 0;
    const v = lower ? verb.toLowerCase() : verb;

    if (count === 1) {
      parts.push(`${v} 1 ${template.singular}`);
    } else {
      parts.push(`${v} ${count} ${template.plural}`);
    }
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
