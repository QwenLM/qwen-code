/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission confirmation queue component.
 *
 * Renders the head of the permission queue using the same visual layout
 * as main branch's ToolConfirmationQueue:
 * - BaseTabDialog wrapper with title + separator
 * - Tool info summary (Tool name + type-specific metadata)
 * - ToolConfirmationMessage for rich body content + options
 *
 * The difference from the old ToolConfirmationQueue is that this component
 * is driven by QueuedPermissionPrompt (new pipeline) instead of ConfirmingToolState
 * (legacy confirmation pipeline).
 *
 * The rich body content is a SerializableConfirmationDetails, and a prompt does
 * not carry one: the builder needs the tool instance, which the prompt has no
 * room for, and building is asynchronous because an edit's diff is read off
 * disk. So this component builds it the same way the headless and ACP channels
 * build theirs — tool registry lookup plus the prompt's projected input.
 *
 * Bridge: ToolConfirmationMessage calls useToolActions().confirm(), which goes
 * through the ToolActionsProvider. We pass a `permissionQueueLookup` to the
 * provider so that confirm() settles the queued prompt directly.
 */

import type React from 'react';
import { useMemo, useCallback, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import {
  buildConfirmationDetails,
  presentationOptionsForPrompt,
  breakerConfirmationDetails,
  CoreToolCallStatus,
  EXIT_PLAN_MODE_TOOL_NAME,
  resolveCurrentPlanPath,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { useI18nService } from '../i18n/index.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { BaseTabDialog } from '../components/shared/BaseTabDialog.js';
import { ToolConfirmationMessage } from '../components/messages/ToolConfirmationMessage.js';
import { ToolActionsProvider } from '../contexts/ToolActionsContext.js';
import {
  isOwnUITool,
  getConfirmationTitle,
} from '../utils/toolConfirmationUtils.js';
import type { IndividualToolCallDisplay } from '../types.js';
import type { QueuedPermissionPrompt } from './permissionQueueStore.js';
import path from 'node:path';

const SUMMARY_VALUE_MAX_LENGTH = 500;

/** Renders a "Label: value" pair with word-wrapping and a soft length limit. */
const SummaryField: React.FC<{
  label: string;
  value: string;
  bold?: boolean;
  /** When true, skip the length limit and show full value. */
  noTruncate?: boolean;
}> = ({ label, value, bold = false, noTruncate = false }) => (
  <Text wrap="wrap">
    <Text color={theme.text.secondary}>{label}: </Text>
    <Text color={theme.text.primary} bold={bold}>
      {!noTruncate && value.length > SUMMARY_VALUE_MAX_LENGTH
        ? value.slice(0, SUMMARY_VALUE_MAX_LENGTH) + '...'
        : value}
    </Text>
  </Text>
);

// ============================================================================
// Types
// ============================================================================

interface PermissionQueueProps {
  /** The current permission queue snapshot. */
  items: readonly QueuedPermissionPrompt[];
}

// ============================================================================
// Component
// ============================================================================

/**
 * Renders the head of the permission queue.
 * Uses the same visual layout as main branch's ToolConfirmationQueue.
 *
 * Wraps ToolConfirmationMessage in a ToolActionsProvider with a
 * `permissionQueueLookup` so confirm() resolves items directly
 * via PermissionRequestItem.onAllow/onReject callbacks.
 */
export const PermissionQueue: React.FC<PermissionQueueProps> = ({ items }) => {
  const config = useConfig();
  const i18n = useI18nService();
  const { getPreferredEditor } = useUIActions();
  const { mainAreaWidth } = useUIState();

  // Expansion state for ToolActionsProvider
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

  // Extract current item data. All hooks must be called unconditionally,
  // so we compute these values before using them in useMemo.
  const currentItem = items[0] ?? null;
  const callId = currentItem?.toolUseId ?? '';
  const toolName = currentItem?.toolName;
  const promptInput = currentItem?.input;
  const promptReason = currentItem?.reason;
  const askMessage = promptReason?.message;
  const presentation = currentItem
    ? presentationOptionsForPrompt(currentItem)
    : undefined;
  const promptPersistable = presentation?.persistable;
  const promptSafetyCheckKind = presentation?.safetyCheckKind;
  // Proxied prompts (the remote controller asking for a worker) carry the
  // render payload the worker supplied. Building it locally instead would look
  // the worker's tool up in this machine's registry — where an MCP or host-only
  // tool does not exist — and an edit's diff would be read off the wrong disk.
  const wireDetails = currentItem?.confirmationDetails;

  // Build the render payload for the head of the queue.
  //
  // Tagged with the prompt it was built for: the build is asynchronous, so a
  // queue-head change or a recheck refresh (which replaces `input`) must not
  // leave the previous prompt's body on screen.
  const [built, setBuilt] = useState<{
    toolUseId: string;
    input: Record<string, unknown>;
    details: SerializableConfirmationDetails;
  } | null>(null);

  useEffect(() => {
    if (wireDetails || !toolName || !promptInput) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        // Inside the try: the payload is optional, so nothing here may throw
        // out of a renderer.
        const breaker = promptReason
          ? breakerConfirmationDetails(promptReason)
          : undefined;
        if (breaker) {
          if (!cancelled) {
            setBuilt({
              toolUseId: callId,
              input: promptInput,
              details: breaker,
            });
          }
          return;
        }
        const tool = config.toolRegistry.getTool(toolName);
        if (!tool) {
          return;
        }
        const details = await buildConfirmationDetails(
          tool,
          promptInput,
          askMessage,
          // Only the plan dialog needs a plan file, and the path is derived
          // from session state rather than the call.
          toolName === EXIT_PLAN_MODE_TOOL_NAME
            ? resolveCurrentPlanPath(config)
            : undefined,
          config.getTargetDir(),
          config,
          {
            ...(promptPersistable === false ? { persistable: false } : {}),
            ...(promptSafetyCheckKind
              ? { safetyCheckKind: promptSafetyCheckKind }
              : {}),
          },
        );
        if (!cancelled) {
          setBuilt({ toolUseId: callId, input: promptInput, details });
        }
      } catch {
        // A payload we cannot build leaves the prompt unrendered rather than
        // half-rendered; it is still settleable from the queue.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    config,
    callId,
    toolName,
    promptInput,
    promptReason,
    askMessage,
    wireDetails,
    promptPersistable,
    promptSafetyCheckKind,
  ]);

  const details =
    wireDetails ??
    (built && built.toolUseId === callId && built.input === promptInput
      ? built.details
      : null);

  // Hide the dialog immediately on cancel instead of waiting for the backend round-trip.
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const handleDismiss = useCallback(() => {
    if (callId) setDismissedId(callId);
  }, [callId]);

  // Lookup function for ToolActionsProvider — resolves the prompt directly
  const permissionQueueLookup = useCallback(
    (id: string) => items.find((i) => i.toolUseId === id),
    [items],
  );

  // Build synthetic tool calls for ToolActionsProvider's toolCalls prop.
  // The provider needs these to find the tool by callId in confirm().
  const syntheticToolCalls = useMemo((): IndividualToolCallDisplay[] => {
    if (!currentItem || !details) return [];

    return [
      {
        callId: currentItem.toolUseId,
        name: currentItem.toolName,
        description: '',
        resultDisplay: undefined,
        status: CoreToolCallStatus.AwaitingApproval,
        confirmationDetails: details ?? undefined,
      },
    ];
  }, [currentItem, details]);

  // Early exit after all hooks
  if (!currentItem || !details) return null;
  if (dismissedId === currentItem.toolUseId) return null;

  // Tools that handle their own UI (ask_user uses BaseTabDialog internally, exit_plan_mode too)
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
          toolCalls={syntheticToolCalls}
          isExpanded={isExpanded}
          toggleExpansion={toggleExpansion}
          toggleAllExpansion={toggleAllExpansion}
          permissionQueueLookup={permissionQueueLookup}
        >
          <ToolConfirmationMessage
            key={callId}
            callId={callId}
            confirmationDetails={details}
            config={config}
            getPreferredEditor={getPreferredEditor}
            terminalWidth={mainAreaWidth}
            availableTerminalHeight={undefined}
            toolName={currentItem.toolName}
            isFocused={true}
            onDismiss={handleDismiss}
          />
        </ToolActionsProvider>
      </Box>
    );
  }

  // All other tool types use BaseTabDialog for consistent dialog styling

  // Build title with optional queue indicator
  let title = getConfirmationTitle(details);
  if (items.length > 1) {
    title = `${title} (1 of ${items.length})`;
  }

  // Content width accounts for BaseTabDialog's paddingX=1
  const contentWidth = mainAreaWidth - 2;

  return (
    <Box
      flexDirection="column"
      width={mainAreaWidth}
      flexShrink={0}
      marginTop={1}
    >
      <ToolActionsProvider
        toolCalls={syntheticToolCalls}
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
        >
          {promptReason?.denialKind === 'automode-unavailable' && (
            <Box marginBottom={1}>
              <Text color={theme.status.warning}>
                {i18n.get('permission.autoClassifierUnavailable')}
              </Text>
            </Box>
          )}
          {/* Tool name + key parameters summary */}
          <Box marginBottom={1} flexDirection="column">
            <SummaryField label="Tool" value={currentItem.toolName} bold />
            {details.type === 'edit' && (
              <SummaryField
                label="File"
                value={
                  details.displayPath ??
                  (path.relative(process.cwd(), details.filePath) ||
                    details.fileName)
                }
              />
            )}
            {details.type === 'file_read' && (
              <SummaryField label="File" value={details.displayPath} />
            )}
            {details.type === 'workflow' && (
              <>
                {details.workflowName && (
                  <SummaryField label="Workflow" value={details.workflowName} />
                )}
                <SummaryField
                  label="Source"
                  value={details.scriptPath ?? details.source}
                />
              </>
            )}
            {details.type === 'exec' && (
              <>
                {details.description && (
                  <Box marginTop={1}>
                    <Text color={theme.text.secondary}>
                      {details.description}
                    </Text>
                  </Box>
                )}
                <SummaryField
                  label="Command"
                  noTruncate
                  value={
                    details.commands && details.commands.length > 0
                      ? details.commands[0]
                      : details.command
                  }
                />
              </>
            )}
            {details.type === 'mcp' && (
              <>
                <SummaryField label="Server" value={details.serverName} />
                <SummaryField label="MCP Tool" value={details.toolName} />
              </>
            )}
            {details.type === 'info' && (
              <SummaryField label="Request" value={details.prompt} />
            )}
          </Box>
          <ToolConfirmationMessage
            key={callId}
            callId={callId}
            confirmationDetails={details}
            config={config}
            getPreferredEditor={getPreferredEditor}
            terminalWidth={contentWidth}
            availableTerminalHeight={undefined}
            toolName={currentItem.toolName}
            isFocused={true}
            onDismiss={handleDismiss}
          />
        </BaseTabDialog>
      </ToolActionsProvider>
    </Box>
  );
};
