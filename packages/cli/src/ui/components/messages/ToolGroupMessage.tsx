/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, Fragment } from 'react';
import { Box, Text } from 'ink';
import type {
  HistoryItem,
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../../types.js';
import { ToolCallStatus, mapCoreStatusToDisplayStatus } from '../../types.js';
import { ToolMessage } from './ToolMessage.js';
import { CodeModeToolMessage } from './CodeModeToolMessage.js';
import { WorkflowToolMessage } from './WorkflowToolMessage.js';
import { ShellToolMessage } from './ShellToolMessage.js';
import { TopicMessage, isTopicTool } from './TopicMessage.js';
import { SubagentGroupDisplay } from './SubagentGroupDisplay.js';
import { DenseToolMessage } from './DenseToolMessage.js';
import { theme } from '../../semantic-colors.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { isShellTool } from './ToolShared.js';
import {
  shouldHideToolCall,
  CODE_MODE_TOOL_NAME,
  CODE_MODE_WAIT_TOOL_NAME,
  Kind,
  EDIT_DISPLAY_NAME,
  GLOB_DISPLAY_NAME,
  WEB_SEARCH_DISPLAY_NAME,
  READ_FILE_DISPLAY_NAME,
  GREP_DISPLAY_NAME,
  WEB_FETCH_DISPLAY_NAME,
  WRITE_FILE_DISPLAY_NAME,
  IMAGE_GEN_DISPLAY_NAME,
  VIDEO_GEN_DISPLAY_NAME,
  VIDEO_GEN_RETRIEVE_DISPLAY_NAME,
  NOTEBOOK_EDIT_DISPLAY_NAME,
  isFileDiff,
  isGlobResult,
  isGrepResult,
} from '@qwen-code/core';
import { useUIState } from '../../contexts/UIStateContext.js';
import { usePendingHistory } from '../../contexts/PendingHistoryContext.js';
import { getToolGroupBorderAppearance } from '../../utils/borderStyles.js';
import { useSettings } from '../../contexts/SettingsContext.js';
import {
  TOOL_RESULT_STATIC_HEIGHT,
  TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT,
  TOOL_OUTPUT_COMPACT_MAX_LINES,
} from '../../utils/toolLayoutUtils.js';
import { INDENT, FoldLevel } from '../../constants/messageLayout.js';
import { useFoldState } from '../../contexts/FoldStateContext.js';
import {
  ToolGroupSummary,
  TOOL_GROUP_SUMMARY_HEIGHT,
} from './ToolGroupSummary.js';

const COMPACT_OUTPUT_ALLOWLIST = new Set([
  EDIT_DISPLAY_NAME,
  GLOB_DISPLAY_NAME,
  WEB_SEARCH_DISPLAY_NAME,
  READ_FILE_DISPLAY_NAME,
  GREP_DISPLAY_NAME,
  WEB_FETCH_DISPLAY_NAME,
  WRITE_FILE_DISPLAY_NAME,
  IMAGE_GEN_DISPLAY_NAME,
  VIDEO_GEN_DISPLAY_NAME,
  VIDEO_GEN_RETRIEVE_DISPLAY_NAME,
  NOTEBOOK_EDIT_DISPLAY_NAME,
]);

// ---------------------------------------------------------------------------
// ToolSlot variant system (Phase 4)
// ---------------------------------------------------------------------------

/**
 * The five visual variants a tool call can render as.
 */
export enum ToolVariant {
  Agent = 'agent',
  Topic = 'topic',
  Dense = 'dense',
  Shell = 'shell',
  Standard = 'standard',
}

/**
 * Classify a grouped entry into its ToolVariant.
 * Agent groups are arrays; the rest are classified by tool properties.
 */
export function classifyToolVariant(
  group: IndividualToolCallDisplay | IndividualToolCallDisplay[],
  isCompactModeEnabled: boolean,
): ToolVariant {
  if (Array.isArray(group)) return ToolVariant.Agent;
  if (isTopicTool(group.name)) return ToolVariant.Topic;
  if (isCompactTool(group, isCompactModeEnabled)) return ToolVariant.Dense;
  if (isShellTool(group.name)) return ToolVariant.Shell;
  return ToolVariant.Standard;
}

/**
 * Compute the static height contribution of a single tool slot.
 */
export function getVariantStaticHeight(
  variant: ToolVariant,
  opts: {
    isFirstProp: boolean;
    hasTopMargin?: boolean;
    agentCount?: number;
    hasOutputFile?: boolean;
  },
): number {
  switch (variant) {
    case ToolVariant.Agent:
      // Top Boundary (0|1) + Header(1) + Agent list(N) + Bottom Boundary(1)
      return (opts.isFirstProp ? 1 : 0) + 1 + (opts.agentCount ?? 0) + 1;
    case ToolVariant.Topic:
      // Top Margin (0|1) + Content(1) + Bottom Margin(1)
      return (opts.hasTopMargin ? 1 : 0) + 1 + 1;
    case ToolVariant.Dense:
      // Single dense line
      return 1;
    case ToolVariant.Shell:
      // Header(1) + Output lines(4) + optional output file(1)
      return 1 + 4 + (opts.hasOutputFile ? 1 : 0);
    case ToolVariant.Standard:
      // Reserved lines + header + optional output file
      return (
        TOOL_RESULT_STANDARD_RESERVED_LINE_COUNT -
        1 +
        TOOL_RESULT_STATIC_HEIGHT +
        (opts.hasOutputFile ? 1 : 0)
      );
    default:
      return 0;
  }
}

// Helper to identify if a tool should use the compact view
export const isCompactTool = (
  tool: IndividualToolCallDisplay,
  isCompactModeEnabled: boolean,
): boolean => {
  const hasCompactOutputSupport = COMPACT_OUTPUT_ALLOWLIST.has(tool.name);
  const displayStatus = mapCoreStatusToDisplayStatus(tool.status);
  return (
    isCompactModeEnabled &&
    hasCompactOutputSupport &&
    displayStatus !== ToolCallStatus.Confirming
  );
};

export function isVisibleToolCall(
  tool: IndividualToolCallDisplay,
): boolean {
  return !shouldHideToolCall({
    toolName: tool.name,
    status: tool.status,
    planModeActive: tool.planModeActive,
    hasResultDisplay: !!tool.resultDisplay,
    parentCallId: tool.parentCallId,
    input: tool.args,
  });
}

export function hasRenderableToolGroup(item: {
  tools: IndividualToolCallDisplay[];
  borderBottom?: boolean;
}): boolean {
  if (item.tools.length === 0) {
    return item.borderBottom === true;
  }
  return item.tools.some(isVisibleToolCall);
}

// Helper to identify if a compact tool has a payload (diff, list, etc.)
export const hasDensePayload = (tool: IndividualToolCallDisplay): boolean => {
  if (tool.outputFile) return true;
  const res = tool.resultDisplay;
  if (!res) return false;

  // TODO(24053): Usage of type guards makes this class too aware of internals
  if (isFileDiff(res)) return true;
  if (tool.confirmationDetails?.type === 'edit') return true;
  if (isGlobResult(res) && (res.filenames?.length ?? 0) > 0) {
    return true;
  }
  if (isGrepResult(res) && res.mode === 'content' && !!res.content) {
    return true;
  }

  // Generic summary/payload pattern
  if (
    typeof res === 'object' &&
    res !== null &&
    'summary' in res &&
    'payload' in res
  ) {
    return true;
  }

  return false;
};

interface ToolGroupMessageProps {
  item: HistoryItem | HistoryItemWithoutId;
  toolCalls: IndividualToolCallDisplay[];
  availableTerminalHeight?: number;
  terminalWidth: number;
  borderTop?: boolean;
  borderBottom?: boolean;
  isExpandable?: boolean;
  isToolGroupBoundary?: boolean;
}

// Main component renders the border and maps the tools using ToolMessage

export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  item,
  toolCalls: allToolCalls,
  availableTerminalHeight,
  terminalWidth,
  borderTop: borderTopOverride,
  borderBottom: borderBottomOverride,
  isExpandable,
  isToolGroupBoundary,
}) => {
  const settings = useSettings();
  const isCompactModeEnabled = settings.merged.ui?.compactToolOutput === true;

  // Fold state: determine effective fold level for this group
  const { getEffectiveFoldLevel } = useFoldState();
  // Use the first tool's callId as a stable group identifier
  const groupId = allToolCalls[0]?.callId ?? '';
  const foldLevel = getEffectiveFoldLevel(groupId);

  // Filter out tool calls that should be hidden (e.g. in-progress Ask User, or Plan Mode operations).
  const visibleToolCalls = useMemo(
    () => allToolCalls.filter(isVisibleToolCall),
    [allToolCalls],
  );

  const { activeShellId } = useUIState();
  const { pendingHistoryItems } = usePendingHistory();

  const config = useConfig();

  const { borderColor, borderDimColor } = useMemo(
    () =>
      getToolGroupBorderAppearance(
        item,
        activeShellId,
        pendingHistoryItems,
      ),
    [item, activeShellId, pendingHistoryItems],
  );

  const groupedTools = useMemo(() => {
    const groups: Array<
      IndividualToolCallDisplay | IndividualToolCallDisplay[]
    > = [];
    for (const tool of visibleToolCalls) {
      if (tool.kind === Kind.Agent) {
        const lastGroup = groups[groups.length - 1];
        if (Array.isArray(lastGroup)) {
          lastGroup.push(tool);
        } else {
          groups.push([tool]);
        }
      } else {
        groups.push(tool);
      }
    }
    return groups;
  }, [visibleToolCalls]);

  const staticHeight = useMemo(() => {
    // When group is fully collapsed, it's just a single summary line
    if (foldLevel === FoldLevel.GroupCollapsed) {
      return TOOL_GROUP_SUMMARY_HEIGHT;
    }

    // Both GroupExpandedToolCollapsed and FullyExpanded render full tool components.
    // The difference is output truncation (handled at render time), not structural height.

    let height = 0;

    for (let i = 0; i < groupedTools.length; i++) {
      const group = groupedTools[i];

      const prevGroup = i > 0 ? groupedTools[i - 1] : null;
      const prevIsCompact =
        prevGroup &&
        !Array.isArray(prevGroup) &&
        isCompactTool(prevGroup, isCompactModeEnabled);

      const variant = classifyToolVariant(group, isCompactModeEnabled);

      // Align isFirst logic with rendering
      let isFirst = i === 0;
      if (!isFirst) {
        let allPreviousTopics = true;
        for (let j = 0; j < i; j++) {
          const prevGroupItem = groupedTools[j];
          if (
            Array.isArray(prevGroupItem) ||
            !isTopicTool(prevGroupItem.name)
          ) {
            allPreviousTopics = false;
            break;
          }
        }
        isFirst = allPreviousTopics;
      }

      const isFirstProp = !!(isFirst
        ? (borderTopOverride ?? true)
        : prevIsCompact);

      height += getVariantStaticHeight(variant, {
        isFirstProp,
        hasTopMargin: !(isFirst && isToolGroupBoundary),
        agentCount: Array.isArray(group) ? group.length : undefined,
        hasOutputFile: Array.isArray(group) ? false : !!group.outputFile,
      });
    }
    return height;
  }, [
    foldLevel,
    groupedTools,
    isCompactModeEnabled,
    borderTopOverride,
    isToolGroupBoundary,
  ]);

  let countToolCallsWithResults = 0;
  for (const tool of visibleToolCalls) {
    if (tool.kind !== Kind.Agent) {
      if (isCompactTool(tool, isCompactModeEnabled)) {
        if (hasDensePayload(tool)) {
          countToolCallsWithResults++;
        }
      } else if (
        tool.resultDisplay !== undefined &&
        tool.resultDisplay !== ''
      ) {
        countToolCallsWithResults++;
      }
    }
  }

  const availableTerminalHeightPerToolMessage = availableTerminalHeight
    ? Math.max(
        Math.floor(
          (availableTerminalHeight - staticHeight) /
            Math.max(1, countToolCallsWithResults),
        ),
        1,
      )
    : undefined;

  const contentWidth = terminalWidth - INDENT.TOOL_GROUP_PADDING_RIGHT;

  // If all tools are filtered out (e.g., in-progress AskUser tools, low-verbosity
  // internal errors, plan-mode hidden write/edit), we should not emit standalone
  // border fragments. The only case where an empty group should render is the
  // explicit "closing slice" (tools: []) used to bridge static/pending sections,
  // and only if it's actually continuing an open box from above.
  const isExplicitClosingSlice = allToolCalls.length === 0;
  const shouldShowGroup =
    visibleToolCalls.length > 0 ||
    (isExplicitClosingSlice && borderBottomOverride === true);

  if (!shouldShowGroup) {
    return null;
  }

  // Determine max output lines based on fold level:
  // - GroupExpandedToolCollapsed → truncate to TOOL_OUTPUT_COMPACT_MAX_LINES (3 lines)
  // - FullyExpanded → no truncation (undefined)
  const maxOutputLines =
    foldLevel === FoldLevel.GroupExpandedToolCollapsed
      ? TOOL_OUTPUT_COMPACT_MAX_LINES
      : undefined;

  const renderToolGroups = () =>
    groupedTools.map((group, index) => {
      let isFirst = index === 0;
      if (!isFirst) {
        // Check if all previous tools were topics
        let allPreviousWereTopics = true;
        for (let i = 0; i < index; i++) {
          const prevGroup = groupedTools[i];
          if (Array.isArray(prevGroup) || !isTopicTool(prevGroup.name)) {
            allPreviousWereTopics = false;
            break;
          }
        }
        isFirst = allPreviousWereTopics;
      }

      const prevGroup = index > 0 ? groupedTools[index - 1] : null;
      const prevIsCompact =
        prevGroup &&
        !Array.isArray(prevGroup) &&
        isCompactTool(prevGroup, isCompactModeEnabled);

      const variant = classifyToolVariant(group, isCompactModeEnabled);

      const isFirstProp = !!(isFirst
        ? (borderTopOverride ?? true)
        : prevIsCompact);

      if (variant === ToolVariant.Agent) {
        const agentGroup = group as IndividualToolCallDisplay[];
        return (
          <Box
            key={agentGroup[0].callId}
            flexDirection="column"
            width={contentWidth}
          >
            <SubagentGroupDisplay
              toolCalls={agentGroup}
              availableTerminalHeight={availableTerminalHeight}
              terminalWidth={contentWidth}
              borderColor={borderColor}
              borderDimColor={borderDimColor}
              isFirst={isFirstProp}
              isExpandable={isExpandable}
            />
          </Box>
        );
      }

      const tool = group as IndividualToolCallDisplay;

      const commonProps = {
        ...tool,
        availableTerminalHeight: availableTerminalHeightPerToolMessage,
        terminalWidth: contentWidth,
        emphasis: 'medium' as const,
        isFirst: variant === ToolVariant.Dense ? false : isFirstProp,
        borderColor,
        borderDimColor,
        isExpandable,
        ...(variant === ToolVariant.Dense && { foldLevel }),
        ...(maxOutputLines !== undefined &&
          variant === ToolVariant.Standard && {
            maxOutputLines,
          }),
      };

      return (
        <Fragment key={tool.callId}>
          <Box flexDirection="column" minHeight={1} width={contentWidth}>
            {variant === ToolVariant.Dense ? (
              <DenseToolMessage {...commonProps} />
            ) : variant === ToolVariant.Topic ? (
              <Box
                marginTop={isFirst && isToolGroupBoundary ? 0 : 1}
                marginBottom={1}
              >
                <TopicMessage {...commonProps} />
              </Box>
            ) : variant === ToolVariant.Shell ? (
              <ShellToolMessage {...commonProps} config={config} />
            ) : tool.name === CODE_MODE_TOOL_NAME ||
              tool.name === CODE_MODE_WAIT_TOOL_NAME ? (
              <CodeModeToolMessage {...commonProps} foldLevel={foldLevel} />
            ) : tool.kind === Kind.Workflow ? (
              <WorkflowToolMessage {...commonProps} />
            ) : (
              <ToolMessage {...commonProps} />
            )}
            {variant !== ToolVariant.Dense &&
              variant !== ToolVariant.Shell &&
              tool.outputFile && (
                <Box
                  flexDirection="column"
                  paddingLeft={INDENT.TOOL_PAYLOAD}
                  paddingRight={1}
                >
                  <Box>
                    <Text color={theme.text.primary}>
                      Output too long and was saved to: {tool.outputFile}
                    </Text>
                  </Box>
                </Box>
              )}
            {variant === ToolVariant.Shell && tool.outputFile && (
              <Box paddingLeft={INDENT.TOOL_PAYLOAD}>
                <Text color={theme.border.default}>
                  Output saved to:{' '}
                  <Text color={theme.text.response}>{tool.outputFile}</Text>
                </Text>
              </Box>
            )}
          </Box>
        </Fragment>
      );
    });

  const content = (
    <Box
      flexDirection="column"
      /*
      This width constraint is highly important and protects us from an Ink rendering bug.
      Since the ToolGroup can typically change rendering states frequently, it can cause
      Ink to render the border of the box incorrectly and span multiple lines and even
      cause tearing.
    */
      width={terminalWidth}
      paddingRight={INDENT.TOOL_GROUP_PADDING_RIGHT}
      marginBottom={0}
    >
      {/* GroupCollapsed: single summary line */}
      {foldLevel === FoldLevel.GroupCollapsed ? (
        <ToolGroupSummary
          toolCalls={visibleToolCalls}
          terminalWidth={terminalWidth}
        />
      ) : (
        /* GroupExpandedToolCollapsed & FullyExpanded: render tools with/without truncation */
        renderToolGroups()
      )}
    </Box>
  );

  return content;
};
