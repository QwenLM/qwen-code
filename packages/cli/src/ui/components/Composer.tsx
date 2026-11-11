/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box } from 'ink';
import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useConfig } from '../contexts/ConfigContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useInputState } from '../contexts/InputContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useVimMode } from '../contexts/VimModeContext.js';
import { useAlternateBuffer } from '../hooks/useAlternateBuffer.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';
import { DetailedMessagesDisplay } from './DetailedMessagesDisplay.js';
import { ShortcutsHelp } from './ShortcutsHelp.js';
import { InputPrompt, type InputPromptProps } from './InputPrompt.js';
import {
  SuggestionsDisplay,
  type SuggestionsDisplayProps,
} from './SuggestionsDisplay.js';
import { StatusRow, type StatusRowProps } from './StatusRow.js';
import { StatusLine } from './StatusLine.js';
import type { WorkflowKeywordStatus } from './StatusRow.js';
import { ShowMoreLines } from './ShowMoreLines.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { useComposerStatus } from '../hooks/useComposerStatus.js';
import { appEvents, AppEvent } from '../../utils/events.js';
import {
  isAgentSessionsEnabled,
  isCommandStyleUserPromptText,
  isWorkflowTask,
  type PastedContent,
  type SlashCommandSource,
} from '@qwen-code/core';
import { AgentSessionRail } from './AgentSessionRail.js';
import { WorkflowPanel } from './WorkflowPanel.js';
import { useTaskRegistry } from '../contexts/TaskRegistryContext.js';
import { useTaskRegistryVersion } from '../hooks/useTaskRegistryState.js';
import { ComposerActivityTray } from './ComposerActivityTray.js';
import { StreamingState } from '../types.js';
import { useKeyBindingConfig } from '../hooks/useKeyMatchers.js';
import { getSendNowShortcut } from '../utils/sendNowShortcut.js';
import { parseSlashCommand } from '../../utils/commands.js';
import { useI18nService } from '../i18n/index.js';

export type ComposerContent =
  | { kind: 'replacement'; element: ReactNode }
  | {
      kind: 'composer';
      terminalWidth: number;
      statusRowProps: StatusRowProps;
      beforeStatus: ReactNode;
      beforeInput: ReactNode;
      inputPromptProps: InputPromptProps | undefined;
      afterInput: ReactNode;
    };

/** Shared input, workflow and footer behavior for page-owned composers. */
export const useComposerContent = ({
  isFocused = true,
}: {
  isFocused?: boolean;
}): ComposerContent => {
  const i18n = useI18nService();
  const getUiText = i18n.get;
  const uiState = useUIState();
  const inputState = useInputState();
  const uiActions = useUIActions();
  const config = useConfig();
  const keyBindingConfig = useKeyBindingConfig();
  const registry = useTaskRegistry();
  const registryVersion = useTaskRegistryVersion(registry);
  const { vimEnabled, vimMode } = useVimMode();
  const { columns: terminalWidth } = useTerminalSize();
  const isNarrow = isNarrowWidth(terminalWidth);
  const debugConsoleMaxHeight = Math.floor(
    Math.max(uiState.terminalHeight * 0.2, 5),
  );
  const [suggestionsVisible, setSuggestionsVisible] = useState(false);
  const [footerSuggestions, setFooterSuggestions] =
    useState<SuggestionsDisplayProps | null>(null);
  const [workflowKeywordStatus, setWorkflowKeywordStatus] =
    useState<WorkflowKeywordStatus | null>(null);
  const agentRailFocusRef = useRef<(() => boolean) | null>(null);
  const viewedWorkflowTask = useMemo(() => {
    // `registryVersion` intentionally invalidates this memo when TaskRegistry emits.
    void registryVersion;
    if (!uiState.viewedWorkflowTaskId) return undefined;
    const liveTask = registry?.get(uiState.viewedWorkflowTaskId);
    if (liveTask && isWorkflowTask(liveTask)) return liveTask;
    return uiState.workflowHistoryTasks?.find(
      (task) => task.id === uiState.viewedWorkflowTaskId,
    );
  }, [
    uiState.viewedWorkflowTaskId,
    uiState.workflowHistoryTasks,
    registry,
    registryVersion,
  ]);
  const liveWorkflowTasks = useMemo(
    () => (uiState.unifiedTasks ?? []).filter(isWorkflowTask),
    [uiState.unifiedTasks],
  );
  const isSelectingWorkflow = uiState.sessionRailSelectionMode === 'workflows';
  const workflowTasks = isSelectingWorkflow
    ? (uiState.workflowHistoryTasks ?? liveWorkflowTasks)
    : liveWorkflowTasks;

  const isAlternateBuffer = useAlternateBuffer();
  const showUiDetails = uiState.cleanUiDetailsVisible;
  const suggestionsPosition = isAlternateBuffer ? 'above' : 'footer';
  const footerSuggestionsVisible =
    uiState.isInputVisible && !isAlternateBuffer && footerSuggestions !== null;
  const hideContextSummary =
    suggestionsVisible && suggestionsPosition === 'above';

  const {
    hasPendingActionRequired,
    shouldCollapseDuringApproval,
    atBlockingLimit,
  } = useComposerStatus();

  const isPassiveShortcutsHelpState =
    uiState.isInputActive &&
    uiState.streamingState === 'idle' &&
    !hasPendingActionRequired;

  const { setShortcutsHelpVisible } = uiActions;

  const releaseFooterReserve = useCallback(() => {
    setFooterSuggestions(null);
  }, []);

  const handleFooterSuggestionsChange = useCallback(
    (suggestions: SuggestionsDisplayProps | null) => {
      setFooterSuggestions(suggestions);
    },
    [],
  );

  const renderFooterContent = () => {
    if (footerSuggestionsVisible && footerSuggestions) {
      return <SuggestionsDisplay {...footerSuggestions} />;
    }

    return <StatusLine />;
  };

  const handleSubmitWithBlockingCheck = useCallback(
    async (
      input: string,
      imagePastedContents: Record<number, PastedContent> = {},
      preExpansionText?: string,
      slashCommandSource?: SlashCommandSource,
      suppressWorkflowKeyword?: boolean,
    ): Promise<boolean> => {
      // Past the blocking limit we warn but do not refuse here.
      //
      // Auto-compact only runs inside the agent loop, per iteration, right
      // before each model request (see agent-loop's "Per-iteration compression
      // check"). Rejecting the submission here kept the turn from ever
      // entering that loop, so the one mechanism that could free space was
      // unreachable exactly when it was needed — the user's only way out was
      // to type /compact by hand. The blocking limit sits above the
      // auto-compact threshold by construction (thresholds.ts), so letting the
      // turn through means the loop compacts first. The hard wall is checked
      // again in the loop immediately before the provider request, so a turn
      // that is still too large is rejected without dropping the user's input.
      //
      // Upstream keeps its equivalent preempt *after* auto-compaction for the
      // same reason, and its own comment warns the check "would deadlock if
      // blocked here".
      const trimmed = input.trim();
      const parsedCommand = parseSlashCommand(
        trimmed,
        uiState.slashCommands ?? [],
      );
      const isSlashCommand = isCommandStyleUserPromptText(trimmed, {
        isKnownCommand: Boolean(parsedCommand.commandToExecute),
        commandCatalogReady: uiState.slashCommands !== undefined,
      });
      if (atBlockingLimit && !isSlashCommand) {
        uiActions.handleWarning(getUiText('composer.warning.contextLimit'));
      }
      await uiActions.handleFinalSubmit(
        input,
        imagePastedContents,
        preExpansionText,
        slashCommandSource,
        suppressWorkflowKeyword,
      );
      releaseFooterReserve();
      return true;
    },
    [
      atBlockingLimit,
      uiActions,
      releaseFooterReserve,
      getUiText,
      uiState.slashCommands,
    ],
  );

  const handleClearScreen = useCallback(() => {
    releaseFooterReserve();
    uiActions.handleClearScreen();
  }, [releaseFooterReserve, uiActions]);

  const handleHistoryDownOverflow = useCallback(() => {
    if (agentRailFocusRef.current?.()) {
      return true;
    }
    if (uiState.unifiedRunningCount > 0) {
      return uiActions.openBackgroundTaskList();
    }
    return false;
  }, [uiActions, uiState.unifiedRunningCount]);

  useEffect(() => {
    if (hasPendingActionRequired) {
      appEvents.emit(AppEvent.ScrollToBottom);
    }
  }, [hasPendingActionRequired]);

  useEffect(() => {
    if (uiState.shortcutsHelpVisible && !isPassiveShortcutsHelpState) {
      setShortcutsHelpVisible(false);
    }
  }, [
    uiState.shortcutsHelpVisible,
    isPassiveShortcutsHelpState,
    setShortcutsHelpVisible,
  ]);

  const showShortcutsHelp =
    uiState.shortcutsHelpVisible &&
    uiState.streamingState === 'idle' &&
    !hasPendingActionRequired;
  if (hasPendingActionRequired && shouldCollapseDuringApproval) {
    return { kind: 'replacement', element: null };
  }

  if (viewedWorkflowTask) {
    return {
      kind: 'replacement',
      element: (
        <Box
          flexDirection="column"
          width={uiState.terminalWidth}
          flexGrow={0}
          flexShrink={0}
        >
          <WorkflowPanel
            task={viewedWorkflowTask}
            mode="inline"
            onBack={uiActions.viewMainSession}
          />
        </Box>
      ),
    };
  }

  if (isSelectingWorkflow && workflowTasks.length === 0) {
    return {
      kind: 'replacement',
      element: (
        <Box
          flexDirection="column"
          width={uiState.terminalWidth}
          flexGrow={0}
          flexShrink={0}
        >
          <WorkflowPanel mode="inline" onBack={uiActions.viewMainSession} />
        </Box>
      ),
    };
  }

  const hideUiDetailsForSuggestions =
    suggestionsVisible && suggestionsPosition === 'above';

  // Mirrors the InputPrompt send-now gate: only a real model turn can be
  // interrupted (slash commands promote streamingState without one). The
  // session-binding path keeps this existing action disabled.
  const sendNowHint =
    uiState.streamingState === StreamingState.Responding &&
    uiState.isModelTurnActive &&
    !uiState.hasSessionBinding &&
    uiState.messageQueue.length > 0
      ? getSendNowShortcut(keyBindingConfig) || undefined
      : undefined;

  return {
    kind: 'composer',
    terminalWidth: uiState.terminalWidth,
    statusRowProps: {
      showUiDetails,
      isNarrow,
      terminalWidth,
      hideContextSummary,
      hideUiDetailsForSuggestions,
      hasPendingActionRequired,
      workflowKeywordStatus,
    },
    beforeStatus: (
      <>
        <ComposerActivityTray
          config={config}
          messageQueue={uiState.messageQueue}
          sendNowHint={sendNowHint}
          showUiDetails={showUiDetails}
          hasStash={inputState.stash.hasStash}
        />

        {showShortcutsHelp && <ShortcutsHelp />}
      </>
    ),
    beforeInput: (
      <>
        {showUiDetails && uiState.showErrorDetails && (
          <OverflowProvider>
            <Box flexDirection="column">
              <DetailedMessagesDisplay
                maxHeight={
                  uiState.constrainHeight ? debugConsoleMaxHeight : undefined
                }
                width={uiState.terminalWidth}
                hasFocus={uiState.showErrorDetails}
              />
              <ShowMoreLines constrainHeight={uiState.constrainHeight} />
            </Box>
          </OverflowProvider>
        )}
      </>
    ),
    inputPromptProps: uiState.isInputVisible
      ? {
          onSubmit: handleSubmitWithBlockingCheck,
          onClearScreen: handleClearScreen,
          config,
          slashCommands: uiState.slashCommands || [],
          slashCommandCatalogReady: uiState.slashCommands !== undefined,
          commandContext: uiState.commandContext,
          setShellModeActive: uiActions.setShellModeActive,
          permissionMode: uiState.showPermissionModeIndicator,
          onEscapePromptChange: uiActions.onEscapePromptChange,
          focus: isFocused && !hasPendingActionRequired,
          onDoubleEscapeEmpty: uiActions.openRewindDialog,
          popAllMessages: uiActions.popAllMessages,
          onQueueMessage: uiActions.addMessage,
          placeholder: vimEnabled
            ? vimMode === 'INSERT'
              ? i18n.get('composer.placeholder.vimNormal', { shortcut: 'Esc' })
              : i18n.get('composer.placeholder.vimInsert', { shortcut: 'i' })
            : inputState.shellModeActive
              ? i18n.get('composer.placeholder.shell')
              : i18n.get('composer.placeholder.message'),
          setQueueErrorMessage: uiActions.setQueueErrorMessage,
          streamingState: uiState.streamingState,
          suggestionsPosition,
          onSuggestionsVisibilityChange: setSuggestionsVisible,
          onFooterSuggestionsChange: handleFooterSuggestionsChange,
          onFooterSuggestionsRelease: releaseFooterReserve,
          onHistoryDownOverflow: handleHistoryDownOverflow,
          onWorkflowKeywordStatusChange: setWorkflowKeywordStatus,
        }
      : undefined,
    afterInput: (
      <>
        {renderFooterContent()}

        {isAgentSessionsEnabled() ||
        isSelectingWorkflow ||
        workflowTasks.length > 0 ? (
          <AgentSessionRail
            onFocusRef={agentRailFocusRef}
            selectionMode={uiState.sessionRailSelectionMode ?? 'sessions'}
          />
        ) : null}
      </>
    ),
  };
};

export const Composer = ({ isFocused = true }: { isFocused?: boolean }) => {
  const content = useComposerContent({ isFocused });
  if (content.kind === 'replacement') return content.element;

  return (
    <Box
      flexDirection="column"
      width={content.terminalWidth}
      flexGrow={0}
      flexShrink={0}
    >
      {content.beforeStatus}
      <Box width="100%" flexDirection="column">
        <StatusRow {...content.statusRowProps} />
      </Box>
      {content.beforeInput}
      {content.inputPromptProps && (
        <InputPrompt {...content.inputPromptProps} />
      )}
      {content.afterInput}
    </Box>
  );
};
