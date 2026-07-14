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
import {
  STATUS_INDICATOR_WIDTH,
  ToolStatusIndicator,
} from '../shared/ToolStatusIndicator.js';
import { ToolElapsedTime } from '../shared/ToolElapsedTime.js';

interface CompactToolGroupDisplayProps {
  toolCalls: IndividualToolCallDisplay[];
  contentWidth: number;
}

const COMPACT_GROUP_HORIZONTAL_PADDING = 2;
const ACTIVE_ELAPSED_TIME_RESERVED_WIDTH = 4;

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
  // Count-based phrasing (i18n keys; also the English source strings).
  // `{{count}}` is interpolated via t() so every locale supplies a natural
  // phrase — keep these as literals here so they stay greppable and aligned
  // with the locale files. Used for the multi-tool case and the single-tool
  // case that has no usable description.
  past: SummaryForms;
  active: SummaryForms;
  // Bare verb prefixed to a concrete single-tool description ("Read a.ts").
  // Intentionally NOT run through t(): the description it precedes is a raw,
  // language-neutral file path or command, and single-word verb keys would
  // collide with unrelated existing i18n entries. English matches upstream
  // behavior (#6448); the localized count phrases above still cover the
  // multi-tool and no-description paths.
  pastVerb: string;
  activeVerb: string;
};

const CATEGORY_TEMPLATES: Record<ToolCategory, CategoryTemplate> = {
  read: {
    past: { one: 'Read {{count}} file', many: 'Read {{count}} files' },
    active: { one: 'Reading {{count}} file', many: 'Reading {{count}} files' },
    pastVerb: 'Read',
    activeVerb: 'Reading',
  },
  edit: {
    past: { one: 'Edited {{count}} file', many: 'Edited {{count}} files' },
    active: { one: 'Editing {{count}} file', many: 'Editing {{count}} files' },
    pastVerb: 'Edited',
    activeVerb: 'Editing',
  },
  write: {
    past: { one: 'Wrote {{count}} file', many: 'Wrote {{count}} files' },
    active: { one: 'Writing {{count}} file', many: 'Writing {{count}} files' },
    pastVerb: 'Wrote',
    activeVerb: 'Writing',
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
    pastVerb: 'Searched',
    activeVerb: 'Searching',
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
    pastVerb: 'Listed',
    activeVerb: 'Listing',
  },
  command: {
    past: { one: 'Ran {{count}} command', many: 'Ran {{count}} commands' },
    active: {
      one: 'Running {{count}} command',
      many: 'Running {{count}} commands',
    },
    pastVerb: 'Ran',
    activeVerb: 'Running',
  },
  agent: {
    past: { one: 'Ran {{count}} agent', many: 'Ran {{count}} agents' },
    active: {
      one: 'Running {{count}} agent',
      many: 'Running {{count}} agents',
    },
    pastVerb: 'Ran',
    activeVerb: 'Running',
  },
  other: {
    past: { one: 'Used {{count}} tool', many: 'Used {{count}} tools' },
    active: { one: 'Using {{count}} tool', many: 'Using {{count}} tools' },
    pastVerb: 'Used',
    activeVerb: 'Using',
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
    let part: string;
    if (tools.length === 1) {
      const safeDesc = safeDescription(tools[0].description);
      if (safeDesc !== undefined) {
        // Single tool with a concrete description: show it ("Read a.ts").
        // Verb is English (see CategoryTemplate note) but the description is
        // language-neutral, so the line reads correctly in every locale.
        const verb = isActive ? template.activeVerb : template.pastVerb;
        part = `${verb} ${safeDesc}`;
      } else {
        // No usable description → localized count phrase ("Read 1 file").
        part = t(isActive ? template.active.one : template.past.one, {
          count: '1',
        });
      }
    } else {
      // Multiple tools of one category → localized plural count phrase.
      const forms = isActive ? template.active : template.past;
      part = t(forms.many, { count: String(tools.length) });
    }
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

export function estimateCompactToolGroupHeight(
  toolCalls: IndividualToolCallDisplay[],
  contentWidth: number,
): number {
  if (toolCalls.length === 0) return 0;

  const overallStatus = getOverallStatus(toolCalls);
  const isActive =
    overallStatus === ToolCallStatus.Executing ||
    overallStatus === ToolCallStatus.Pending ||
    overallStatus === ToolCallStatus.Confirming;
  const summary = `${buildToolSummary(toolCalls, isActive)}${isActive ? '…' : ''}`;
  const summaryWidth = Math.max(
    1,
    contentWidth -
      COMPACT_GROUP_HORIZONTAL_PADDING -
      STATUS_INDICATOR_WIDTH -
      (isActive ? ACTIVE_ELAPSED_TIME_RESERVED_WIDTH : 0),
  );

  return Math.max(1, Math.ceil(Array.from(summary).length / summaryWidth));
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
          <Text wrap="wrap" bold>
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
