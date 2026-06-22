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
import { theme } from '../../semantic-colors.js';
import { ToolStatusIndicator } from '../shared/ToolStatusIndicator.js';
import { ToolElapsedTime } from '../shared/ToolElapsedTime.js';

interface CompactToolGroupDisplayProps {
  toolCalls: IndividualToolCallDisplay[];
  contentWidth: number;
  /**
   * Optional LLM-generated label (~30 chars, git-commit-subject style) that
   * replaces the semantic summary when present. Falls back to
   * `buildToolSummary()` while the label is still being generated or if
   * generation was skipped/failed.
   */
  compactLabel?: string;
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
  [ToolDisplayNames.AGENT]: 'agent',
  [ToolDisplayNames.WORKFLOW]: 'agent',
  [ToolDisplayNames.SEND_MESSAGE]: 'agent',
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
  'command',
  'read',
  'edit',
  'write',
  'search',
  'list',
  'agent',
  'other',
];

function getToolCategory(toolName: string): ToolCategory {
  return TOOL_NAME_TO_CATEGORY[toolName] ?? 'other';
}

/**
 * Build a semantic summary line from a batch of tool calls.
 *
 * Single tool  → "Read package.json" / "Ran npm test"
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

  // Single tool: use description directly for richer context
  if (toolCalls.length === 1) {
    const tool = toolCalls[0]!;
    const category = getToolCategory(tool.name);
    const template = CATEGORY_TEMPLATES[category];
    const verb = isActive ? template.activeVerb : template.pastVerb;
    const desc = tool.description?.split('\n')[0];
    if (desc) {
      return `${verb} ${desc}`;
    }
    return `${verb} 1 ${template.singular}`;
  }

  // Group by category and count
  const counts = new Map<ToolCategory, number>();
  // For categories with exactly 1 tool, keep the description for richer output
  const singleDescs = new Map<ToolCategory, string>();

  for (const tool of toolCalls) {
    const cat = getToolCategory(tool.name);
    const prev = counts.get(cat) ?? 0;
    counts.set(cat, prev + 1);
    if (prev === 0) {
      const desc = tool.description?.split('\n')[0];
      if (desc) singleDescs.set(cat, desc);
    } else {
      singleDescs.delete(cat);
    }
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
      const desc = singleDescs.get(cat);
      if (desc) {
        parts.push(`${v} ${desc}`);
      } else {
        parts.push(`${v} 1 ${template.singular}`);
      }
    } else {
      parts.push(`${v} ${count} ${template.plural}`);
    }
  }

  return parts.join(', ');
}

function renderSummaryHeader(label: string, count: number) {
  return (
    <>
      <Text bold>{label}</Text>
      {count > 1 ? (
        <Text color={theme.text.secondary}>
          {'  · '}
          {count} tools
        </Text>
      ) : null}
    </>
  );
}

export const CompactToolGroupDisplay: React.FC<
  CompactToolGroupDisplayProps
> = ({ toolCalls, contentWidth, compactLabel }) => {
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
          <Text wrap="truncate-end">
            {compactLabel ? (
              renderSummaryHeader(compactLabel, toolCalls.length)
            ) : (
              <Text>{buildToolSummary(toolCalls, isActive)}</Text>
            )}
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
