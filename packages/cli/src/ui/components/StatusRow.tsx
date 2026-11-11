/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useRef, useState, useEffect } from 'react';
import { Box, Text, ResizeObserver, type DOMElement } from 'ink';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { type ActiveHook } from '../types.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { usePendingHistory } from '../contexts/PendingHistoryContext.js';
import { useInputState } from '../contexts/InputContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { theme } from '../semantic-colors.js';
import { LoadingIndicator } from './LoadingIndicator.js';
import { StatusDisplay } from './StatusDisplay.js';
import { ContextUsageDisplay } from './ContextUsageDisplay.js';
import { HorizontalLine } from './shared/HorizontalLine.js';
import { PermissionModeIndicator } from './PermissionModeIndicator.js';
import { ShellModeIndicator } from './ShellModeIndicator.js';
import { RawMarkdownIndicator } from './RawMarkdownIndicator.js';
import { useComposerStatus } from '../hooks/useComposerStatus.js';
import { figures } from '../utils/figures.js';
import { CompressionProgressIndicator } from './CompressionProgressIndicator.js';
import { ModelQueueProgressIndicator } from './ModelQueueProgressIndicator.js';
import { getModelProgressLabel } from '../utils/modelProgress.js';
import { useHookElapsedTime } from '../hooks/useHookElapsedTime.js';
import { getHookStatusText } from '../utils/hookStatusText.js';
import { getToastMessage, type ToastTone } from './toast.js';
import { useResumeStatus } from '../hooks/useResumeStatus.js';
import { useI18nService } from '../i18n/index.js';

/**
 * Layout constants to prevent magic numbers.
 */
const LAYOUT = {
  STATUS_MIN_HEIGHT: 1,
  STATUS_TOP_MARGIN: 1,
  TIP_LEFT_MARGIN: 2,
  TIP_RIGHT_MARGIN_NARROW: 0,
  TIP_RIGHT_MARGIN_WIDE: 1,
  INDICATOR_LEFT_MARGIN: 1,
  CONTEXT_DISPLAY_TOP_MARGIN_NARROW: 1,
  CONTEXT_DISPLAY_LEFT_MARGIN_NARROW: 1,
  CONTEXT_DISPLAY_LEFT_MARGIN_WIDE: 0,
  COLLISION_GAP: 10,
};

export interface WorkflowKeywordStatus {
  suppressed: boolean;
  shortcut: string;
}

export interface StatusRowProps {
  showUiDetails: boolean;
  isNarrow: boolean;
  terminalWidth: number;
  hideContextSummary: boolean;
  hideUiDetailsForSuggestions: boolean;
  hasPendingActionRequired: boolean;
  workflowKeywordStatus?: WorkflowKeywordStatus | null;
}

const TOAST_COLORS: Record<ToastTone, string> = {
  warning: theme.status.warning,
  success: theme.status.success,
  error: theme.status.error,
  secondary: theme.text.secondary,
};

const ToastStatusText: React.FC<{
  text: string;
  tone: ToastTone;
}> = ({ text, tone }) => (
  <Text color={TOAST_COLORS[tone]} wrap="truncate-end">
    {text}
  </Text>
);

/**
 * Renders the loading or hook execution status.
 */
export const StatusNode: React.FC<{
  showTips: boolean;
  showWit: boolean;
  currentLoadingPhrase?: string;
  elapsedTime: number;
  currentWittyPhrase: string | undefined;
  activeHooks: ActiveHook[];
  showLoadingIndicator: boolean;
  forceSpinner?: boolean;
  errorVerbosity: 'low' | 'full' | undefined;
  onResize?: (width: number) => void;
}> = ({
  showTips,
  showWit,
  currentLoadingPhrase: requestedLoadingPhrase,
  elapsedTime,
  currentWittyPhrase,
  activeHooks,
  showLoadingIndicator,
  forceSpinner = false,
  errorVerbosity,
  onResize,
}) => {
  const i18n = useI18nService();
  const observerRef = useRef<ResizeObserver | null>(null);
  const hookElapsedSeconds = useHookElapsedTime(
    activeHooks[0]?.batchStartedAt,
    activeHooks[0]?.batchEndedAt,
  );

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  const onRefChange = useCallback(
    (node: DOMElement | null) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      if (node && onResize) {
        const observer = new ResizeObserver((entries) => {
          const entry = entries[0];
          if (entry) {
            onResize(Math.round(entry.contentRect.width));
          }
        });
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    [onResize],
  );

  if (activeHooks.length === 0 && !showLoadingIndicator) return null;

  let currentLoadingPhrase = requestedLoadingPhrase
    ? stripAnsi(requestedLoadingPhrase)
    : undefined;

  const hookStatusText = getHookStatusText(
    activeHooks,
    i18n.get,
    hookElapsedSeconds,
  );
  if (hookStatusText) {
    currentLoadingPhrase = hookStatusText;
  }

  return (
    <Box ref={onRefChange}>
      <LoadingIndicator
        inline
        showTips={showTips}
        showWit={showWit}
        errorVerbosity={errorVerbosity}
        currentLoadingPhrase={currentLoadingPhrase}
        elapsedTime={elapsedTime}
        forceRealStatusOnly={false}
        wittyPhrase={currentWittyPhrase}
        forceSpinner={forceSpinner}
      />
    </Box>
  );
};

export const StatusRow: React.FC<StatusRowProps> = ({
  showUiDetails,
  isNarrow,
  terminalWidth,
  hideContextSummary,
  hideUiDetailsForSuggestions,
  hasPendingActionRequired,
  workflowKeywordStatus,
}) => {
  const i18n = useI18nService();
  const uiState = useUIState();
  const { thought } = usePendingHistory();
  const inputState = useInputState();
  const settings = useSettings();
  const {
    showLoadingIndicator,
    showTips,
    showWit,
    modeContentObj,
    showMinimalContext,
  } = useComposerStatus();
  const resumeStatus = useResumeStatus(uiState.isResuming);
  // A live backend queue is the authoritative phase of the active model
  // request. Keep it visible until the orchestrator clears the queue state;
  // concurrent progress signals must not temporarily replace it.
  const modelQueueOwnsStatus = Boolean(uiState.activeModelQueue);

  const [statusWidth, setStatusWidth] = useState(0);

  const toastMessage = getToastMessage(uiState, inputState, i18n.get);
  const tipContentStr = (() => {
    if (toastMessage) {
      return toastMessage.text;
    }

    if (uiState.compressionProgress && !modelQueueOwnsStatus) {
      return undefined;
    }

    if (workflowKeywordStatus) {
      return workflowKeywordStatus.suppressed
        ? i18n.get('status.workflow.ignored', {
            shortcut: workflowKeywordStatus.shortcut,
          })
        : i18n.get('status.workflow.requested', {
            shortcut: workflowKeywordStatus.shortcut,
          });
    }

    // 1. Proactive Tip (Priority)
    if (showTips && uiState.currentTip) {
      return uiState.currentTip;
    }

    // 2. Shortcut Hint (Fallback)
    if (
      settings.merged.ui.showShortcutsHint &&
      !hideUiDetailsForSuggestions &&
      !hasPendingActionRequired &&
      inputState.buffer.text.length === 0
    ) {
      return showUiDetails
        ? i18n.get('shortcut.questionShortcuts')
        : i18n.get('shortcut.tabTwiceMore');
    }

    return undefined;
  })();
  const tipDisplayText =
    !toastMessage &&
    tipContentStr !== undefined &&
    tipContentStr === uiState.currentTip
      ? i18n.get('status.tip', { text: tipContentStr })
      : tipContentStr;
  const tipWidth = tipDisplayText ? stringWidth(tipDisplayText) : 0;

  // Collision detection using deterministic terminal-cell widths.
  const willCollideTip =
    statusWidth + tipWidth + LAYOUT.COLLISION_GAP > terminalWidth;

  const showTipLine = Boolean(
    !hasPendingActionRequired &&
      tipContentStr &&
      (toastMessage
        ? !modelQueueOwnsStatus || !willCollideTip
        : !willCollideTip),
  );
  const hideStatusForToastCollision = Boolean(
    toastMessage && willCollideTip && !modelQueueOwnsStatus,
  );

  const hasPrimaryStatusContent =
    uiState.isResuming ||
    modelQueueOwnsStatus ||
    showLoadingIndicator ||
    uiState.activeHooks.length > 0 ||
    showTipLine;
  const showRow2Minimal =
    (Boolean(modeContentObj) && !hideUiDetailsForSuggestions) ||
    showMinimalContext;

  const showRow2 = showUiDetails || showRow2Minimal;

  const onStatusResize = useCallback((width: number) => {
    if (width > 0) setStatusWidth((prev) => (prev !== width ? width : prev));
  }, []);

  const statusNode =
    modelQueueOwnsStatus && uiState.activeModelQueue ? (
      <ModelQueueProgressIndicator
        modelQueue={uiState.activeModelQueue}
        terminalWidth={terminalWidth}
        isNarrow={isNarrow}
        elapsedTime={uiState.elapsedTime}
        onResize={onStatusResize}
      />
    ) : uiState.isResuming ? (
      <StatusNode
        showTips={false}
        showWit={false}
        currentLoadingPhrase={resumeStatus}
        elapsedTime={0}
        currentWittyPhrase={undefined}
        activeHooks={[]}
        showLoadingIndicator={true}
        forceSpinner={true}
        errorVerbosity={
          settings.merged.ui.errorVerbosity as 'low' | 'full' | undefined
        }
        onResize={onStatusResize}
      />
    ) : uiState.compressionProgress ? (
      <CompressionProgressIndicator
        progress={uiState.compressionProgress}
        isNarrow={isNarrow}
      />
    ) : (
      <StatusNode
        showTips={showTips}
        showWit={showWit}
        currentLoadingPhrase={
          uiState.isCommandProgressActive
            ? uiState.currentLoadingPhrase
            : getModelProgressLabel(thought, i18n.get)
        }
        elapsedTime={uiState.elapsedTime}
        currentWittyPhrase={uiState.currentWittyPhrase}
        activeHooks={uiState.activeHooks}
        showLoadingIndicator={showLoadingIndicator}
        errorVerbosity={
          settings.merged.ui.errorVerbosity as 'low' | 'full' | undefined
        }
        onResize={onStatusResize}
      />
    );

  const renderTipNode = () => {
    if (!tipContentStr || !tipDisplayText) return null;

    const isShortcutHint =
      tipContentStr === i18n.get('shortcut.questionShortcuts') ||
      tipContentStr === i18n.get('shortcut.tabTwiceMore');
    const color =
      isShortcutHint && uiState.shortcutsHelpVisible
        ? theme.text.accent
        : theme.text.secondary;

    return (
      <Box
        flexDirection="row"
        justifyContent="flex-end"
        width={Math.min(
          tipWidth,
          Math.max(
            1,
            terminalWidth -
              LAYOUT.TIP_LEFT_MARGIN -
              LAYOUT.TIP_RIGHT_MARGIN_WIDE,
          ),
        )}
      >
        {toastMessage ? (
          <ToastStatusText text={toastMessage.text} tone={toastMessage.tone} />
        ) : (
          <Text
            color={color}
            wrap="truncate-end"
            italic={tipContentStr === uiState.currentWittyPhrase}
          >
            {tipDisplayText}
          </Text>
        )}
      </Box>
    );
  };

  return (
    <Box
      flexDirection="column"
      width="100%"
      overflow="hidden"
      marginTop={LAYOUT.STATUS_TOP_MARGIN}
    >
      {/* Row 1: Status & Tips */}
      <Box
        width="100%"
        flexDirection="row"
        alignItems={modelQueueOwnsStatus ? 'flex-start' : 'center'}
        justifyContent="space-between"
        minHeight={LAYOUT.STATUS_MIN_HEIGHT}
        overflow="hidden"
        flexWrap="nowrap"
      >
        <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
          {hideStatusForToastCollision ? null : !showUiDetails &&
            hasPrimaryStatusContent ? (
            <Box flexDirection="row" columnGap={1} overflow="hidden">
              {statusNode}
            </Box>
          ) : (
            <Box
              flexDirection="row"
              alignItems={
                isNarrow || modelQueueOwnsStatus ? 'flex-start' : 'center'
              }
              flexGrow={1}
              flexShrink={0}
              marginLeft={LAYOUT.INDICATOR_LEFT_MARGIN}
            >
              {statusNode}
            </Box>
          )}
        </Box>

        <Box
          flexShrink={0}
          marginLeft={showTipLine ? LAYOUT.TIP_LEFT_MARGIN : 0}
          marginRight={
            showTipLine
              ? isNarrow
                ? LAYOUT.TIP_RIGHT_MARGIN_NARROW
                : LAYOUT.TIP_RIGHT_MARGIN_WIDE
              : 0
          }
          position={showTipLine ? 'relative' : 'absolute'}
          {...(showTipLine ? {} : { top: -100, left: -100 })}
        >
          {tipContentStr && renderTipNode()}
        </Box>
      </Box>

      {/* Internal Separator */}
      {showRow2 && (
        <Box width="100%">
          <HorizontalLine dim />
        </Box>
      )}

      {/* Row 2: Modes & Context */}
      {showRow2 && (
        <Box
          width="100%"
          flexDirection={isNarrow ? 'column' : 'row'}
          alignItems={isNarrow ? 'flex-start' : 'center'}
          justifyContent="space-between"
          overflow="hidden"
          flexWrap="nowrap"
        >
          <Box
            flexDirection="row"
            alignItems="center"
            marginLeft={LAYOUT.INDICATOR_LEFT_MARGIN}
            height={LAYOUT.STATUS_MIN_HEIGHT}
            flexShrink={0}
            overflow="hidden"
          >
            {showUiDetails ? (
              <>
                {!hideUiDetailsForSuggestions &&
                  !inputState.shellModeActive && (
                    <PermissionModeIndicator
                      permissionMode={uiState.showPermissionModeIndicator}
                      allowPlanMode={uiState.allowPlanMode}
                    />
                  )}
                {inputState.shellModeActive && <ShellModeIndicator />}
                {!uiState.renderMarkdown && (
                  <Box marginLeft={LAYOUT.INDICATOR_LEFT_MARGIN}>
                    <RawMarkdownIndicator />
                  </Box>
                )}
              </>
            ) : (
              showRow2Minimal &&
              modeContentObj && (
                <Text color={modeContentObj.color} wrap="truncate-end">
                  {figures.bullet} {modeContentObj.text}
                </Text>
              )
            )}
          </Box>
          <Box
            marginTop={isNarrow ? LAYOUT.CONTEXT_DISPLAY_TOP_MARGIN_NARROW : 0}
            flexDirection="row"
            alignItems="center"
            height={LAYOUT.STATUS_MIN_HEIGHT}
            flexShrink={1}
            minWidth={0}
            overflow="hidden"
            marginLeft={
              isNarrow
                ? LAYOUT.CONTEXT_DISPLAY_LEFT_MARGIN_NARROW
                : LAYOUT.CONTEXT_DISPLAY_LEFT_MARGIN_WIDE
            }
          >
            {(showUiDetails || showMinimalContext) && (
              <StatusDisplay hideContextSummary={hideContextSummary} />
            )}
            {showMinimalContext && !showUiDetails && (
              <Box marginLeft={LAYOUT.INDICATOR_LEFT_MARGIN}>
                <ContextUsageDisplay
                  promptTokenCount={uiState.sessionStats.lastPromptTokenCount}
                  model={
                    typeof uiState.currentModel === 'string'
                      ? uiState.currentModel
                      : undefined
                  }
                  terminalWidth={terminalWidth}
                />
              </Box>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};
