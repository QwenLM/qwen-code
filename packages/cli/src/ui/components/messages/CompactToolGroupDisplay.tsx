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
 * Strip ANSI control sequences and reject JSON-looking error fallbacks.
 *
 * When a tool call errors, `useReactToolScheduler` sets description to
 * `JSON.stringify(request.args)` which produces `{...}` blobs. Return
 * `undefined` for those so the caller falls back to count format.
 */
function safeDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  /* eslint-disable no-control-regex */
  // Strip all common ANSI escape sequences: OSC, charset, CSI, and single-byte ESC
  const stripped = raw.replace(
    /\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b\[[0-9;]*[a-zA-Z]|\x1b./g,
    '',
  );
  // Replace all C0 control characters (including \n, \r) with spaces
  const cleaned = stripped.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  /* eslint-enable no-control-regex */

  // Reject JSON-looking blobs (error fallback from args)
  if (cleaned.startsWith('{') || cleaned.startsWith('[')) return undefined;

  return cleaned || undefined;
}

/**
 * Build a semantic summary line from a batch of tool calls.
 *
 * Single tool (with description) → "Read a.ts" / "Ran ls -la"
 * Single tool (no description)   → "Read 1 file" / "Ran 1 command"
 * Multi  same                    → "Read 3 files"
 * Multi mixed                    → "Read a.ts, ran npm test, edited b.ts"
 *
 * Uses past tense when all tools are done, present progressive when active.
 * Falls back to count format when description is empty, contains control
 * characters, or looks like a JSON blob (e.g. error fallback from args).
 */
export function buildToolSummary(
  toolCalls: IndividualToolCallDisplay[],
  isActive: boolean,
): string {
  if (toolCalls.length === 0) return '';

  // Group by category to preserve tool references for description access
  const toolsByCategory = new Map<ToolCategory, IndividualToolCallDisplay[]>();

  for (const tool of toolCalls) {
    const cat = getToolCategory(tool.name);
    const arr = toolsByCategory.get(cat) ?? [];
    arr.push(tool);
    toolsByCategory.set(cat, arr);
  }

  const parts: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const tools = toolsByCategory.get(cat);
    if (!tools || tools.length === 0) continue;

    const template = CATEGORY_TEMPLATES[cat];
    const verb = isActive ? template.activeVerb : template.pastVerb;
    const lower = parts.length > 0;
    const v = lower ? verb.toLowerCase() : verb;

    if (tools.length === 1) {
      const safeDesc = safeDescription(tools[0].description);
      if (safeDesc !== undefined) {
        parts.push(`${v} ${safeDesc}`);
      } else {
        parts.push(`${v} 1 ${template.singular}`);
      }
    } else {
      parts.push(`${v} ${tools.length} ${template.plural}`);
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
