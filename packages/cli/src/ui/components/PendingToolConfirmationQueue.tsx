/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import {
  CoreToolCallStatus,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import type {
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';
import { getAllToolCalls } from '../utils/historyUtils.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { theme } from '../semantic-colors.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { ToolConfirmationMessage } from './messages/ToolConfirmationMessage.js';
import { ToolActionsProvider } from '../contexts/ToolActionsContext.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';
import {
  isOwnUITool,
  getConfirmationTitle,
} from '../utils/toolConfirmationUtils.js';
import { usePermissionQueueItems } from '../permissions/usePermissionQueue.js';

interface PendingToolConfirmationState {
  tool: IndividualToolCallDisplay;
  index: number;
  total: number;
}

interface PendingToolConfirmationQueueProps {
  pendingHistoryItems: HistoryItemWithoutId[];
}

export function getPendingToolConfirmationState(
  pendingHistoryItems: HistoryItemWithoutId[],
): PendingToolConfirmationState | null {
  const allPendingTools = getAllToolCalls(pendingHistoryItems);
  const confirmingTools = allPendingTools.filter(
    (tool) => tool.status === CoreToolCallStatus.AwaitingApproval,
  );
  if (confirmingTools.length === 0) {
    return null;
  }

  const tool =
    confirmingTools.find((candidate) => candidate.correlationId) ??
    confirmingTools[0];
  const index = allPendingTools.findIndex(
    (candidate) => candidate.callId === tool.callId,
  );
  return {
    tool,
    index: index >= 0 ? index + 1 : 1,
    total: allPendingTools.length,
  };
}

export const PendingToolConfirmationQueue: React.FC<
  PendingToolConfirmationQueueProps
> = ({ pendingHistoryItems }) => {
  const config = useConfig();
  const { getPreferredEditor } = useUIActions();
  const { mainAreaWidth } = useUIState();
  const permissionQueueItems = usePermissionQueueItems();

  const confirmingTool = useMemo(
    () => getPendingToolConfirmationState(pendingHistoryItems),
    [pendingHistoryItems],
  );

  // When the user cancels (Esc / Reject), hide the dialog immediately
  // instead of waiting for the backend round-trip.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const handleDismiss = useCallback(() => {
    if (confirmingTool) setDismissedId(confirmingTool.tool.callId);
  }, [confirmingTool]);

  const [expandedSet, setExpandedSet] = useState<Set<string>>(new Set());
  const isExpanded = useCallback(
    (callId: string) => expandedSet.has(callId),
    [expandedSet],
  );
  const toggleExpansion = useCallback((callId: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }, []);
  const toggleAllExpansion = useCallback((callIds: string[]) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      const allExpanded = callIds.every((id) => next.has(id));
      for (const id of callIds) {
        if (allExpanded) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  // Lookup function for ToolActionsProvider — resolves item by correlationId
  const permissionQueueLookup = useCallback(
    (id: string) => permissionQueueItems.find((i) => i.toolUseId === id),
    [permissionQueueItems],
  );

  const confirmationDetails = confirmingTool?.tool.confirmationDetails;
  if (!confirmingTool || !confirmationDetails) return null;
  if (dismissedId === confirmingTool.tool.callId) return null;

  const { tool, index, total } = confirmingTool;
  const details: SerializableConfirmationDetails = confirmationDetails;
  const isOwnUI = isOwnUITool(details.type);

  if (isOwnUI) {
    return (
      <Box
        flexDirection="column"
        width={mainAreaWidth}
        flexShrink={0}
        marginTop={2}
      >
        <ToolActionsProvider
          toolCalls={[tool]}
          isExpanded={isExpanded}
          toggleExpansion={toggleExpansion}
          toggleAllExpansion={toggleAllExpansion}
          permissionQueueLookup={permissionQueueLookup}
        >
          <ToolConfirmationMessage
            callId={tool.callId}
            confirmationDetails={details}
            config={config}
            getPreferredEditor={getPreferredEditor}
            terminalWidth={mainAreaWidth}
            availableTerminalHeight={undefined}
            toolName={tool.name}
            isFocused={true}
            onDismiss={handleDismiss}
          />
        </ToolActionsProvider>
      </Box>
    );
  }

  let title = getConfirmationTitle(details);
  if (total > 1) {
    title = `${title} (${index} of ${total})`;
  }

  const contentWidth = mainAreaWidth - 2;

  return (
    <Box
      flexDirection="column"
      width={mainAreaWidth}
      flexShrink={0}
      marginTop={2}
    >
      <ToolActionsProvider
        toolCalls={[tool]}
        isExpanded={isExpanded}
        toggleExpansion={toggleExpansion}
        toggleAllExpansion={toggleAllExpansion}
        permissionQueueLookup={permissionQueueLookup}
      >
        <BaseTabDialog
          title={title}
          tabs={[]}
          activeKey=""
          onTabChange={() => {}}
          showSeparator={true}
          extraHints={[
            { label: SHORTCUT_HINTS.NAVIGATE, order: 20 },
            { label: SHORTCUT_HINTS.SELECT, order: 30 },
            { label: SHORTCUT_HINTS.CLOSE, order: 100 },
          ]}
        >
          <Box marginBottom={1} flexDirection="column">
            <Box flexDirection="row">
              <Text color={theme.text.secondary}>Tool: </Text>
              <Text color={theme.text.primary} bold>
                {tool.name}
              </Text>
            </Box>
            {details.type === 'edit' && (
              <Box flexDirection="row">
                <Text color={theme.text.secondary}>File: </Text>
                <Text color={theme.text.primary}>
                  {details.displayPath ?? details.fileName}
                </Text>
              </Box>
            )}
            {details.type === 'file_read' && (
              <Box flexDirection="row">
                <Text color={theme.text.secondary}>File: </Text>
                <Text color={theme.text.primary}>{details.displayPath}</Text>
              </Box>
            )}
            {details.type === 'exec' && (
              <Box flexDirection="row">
                <Text color={theme.text.secondary}>Command: </Text>
                <Text color={theme.text.primary} wrap="wrap">
                  {details.commands && details.commands.length > 0
                    ? details.commands[0]
                    : details.command}
                </Text>
              </Box>
            )}
            {details.type === 'mcp' && (
              <>
                <Box flexDirection="row">
                  <Text color={theme.text.secondary}>Server: </Text>
                  <Text color={theme.text.primary}>{details.serverName}</Text>
                </Box>
                <Box flexDirection="row">
                  <Text color={theme.text.secondary}>MCP Tool: </Text>
                  <Text color={theme.text.primary}>{details.toolName}</Text>
                </Box>
              </>
            )}
            {details.type === 'info' && (
              <Box flexDirection="row">
                <Text color={theme.text.secondary}>Request: </Text>
                <Text color={theme.text.primary} wrap="truncate">
                  {details.prompt.slice(0, 80)}
                </Text>
              </Box>
            )}
          </Box>
          {details.type === 'exec' && details.description && (
            <Box marginBottom={1}>
              <Text color={theme.text.secondary}>{details.description}</Text>
            </Box>
          )}
          <ToolConfirmationMessage
            callId={tool.callId}
            confirmationDetails={details}
            config={config}
            getPreferredEditor={getPreferredEditor}
            terminalWidth={contentWidth}
            availableTerminalHeight={undefined}
            toolName={tool.name}
            isFocused={true}
            onDismiss={handleDismiss}
          />
        </BaseTabDialog>
      </ToolActionsProvider>
    </Box>
  );
};
