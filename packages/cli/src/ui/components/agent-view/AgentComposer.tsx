/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentComposer — footer area for in-process agent tabs.
 *
 * Replaces the main Composer when an agent tab is active so that:
 *  - The loading indicator reflects the agent's status (not the main agent)
 *  - The input prompt sends messages to the agent (via enqueueMessage)
 *  - Keyboard events are scoped — no conflict with the main InputPrompt
 *
 * Wraps its content in a local StreamingContext.Provider so reusable
 * components like LoadingIndicator and GeminiRespondingSpinner read the
 * agent's derived streaming state instead of the main agent's.
 */

import { Box, Text, useStdin } from 'ink';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AgentStatus,
  ApprovalMode,
  APPROVAL_MODES,
  AgentEventType,
} from '@qwen-code/qwen-code-core';
import {
  useAgentViewState,
  useAgentViewActions,
} from '../../contexts/AgentViewContext.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { StreamingContext } from '../../contexts/StreamingContext.js';
import { StreamingState } from '../../types.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useAgentStreamingState } from '../../hooks/useAgentStreamingState.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { useTextBuffer } from '../shared/text-buffer.js';
import { calculatePromptWidths } from '../../utils/layoutUtils.js';
import { BaseTextInput } from '../BaseTextInput.js';
import { LoadingIndicator } from '../LoadingIndicator.js';
import { QueuedMessageDisplay } from '../QueuedMessageDisplay.js';
import { AgentFooter } from './AgentFooter.js';
import { keyMatchers, Command } from '../../keyMatchers.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';

// ─── Types ──────────────────────────────────────────────────

interface AgentComposerProps {
  agentId: string;
}

// ─── Component ──────────────────────────────────────────────

export const AgentComposer: React.FC<AgentComposerProps> = ({ agentId }) => {
  const { agents, agentTabBarFocused, agentShellFocused, agentApprovalModes } =
    useAgentViewState();
  const {
    setAgentInputBufferText,
    setAgentTabBarFocused,
    setAgentApprovalMode,
  } = useAgentViewActions();
  const agent = agents.get(agentId);
  const interactiveAgent = agent?.interactiveAgent;

  const config = useConfig();
  const { columns: terminalWidth } = useTerminalSize();
  const { inputWidth } = calculatePromptWidths(terminalWidth);
  const { stdin, setRawMode } = useStdin();

  const {
    status,
    streamingState,
    isInputActive,
    elapsedTime,
    lastPromptTokenCount,
  } = useAgentStreamingState(interactiveAgent);

  // ── Escape to cancel the active agent round ──

  useKeypress(
    (key) => {
      if (
        key.name === 'escape' &&
        streamingState === StreamingState.Responding
      ) {
        interactiveAgent?.cancelCurrentRound();
      }
    },
    {
      isActive:
        streamingState === StreamingState.Responding && !agentShellFocused,
    },
  );

  // ── Shift+Tab to cycle this agent's approval mode ──

  const agentApprovalMode =
    agentApprovalModes.get(agentId) ?? ApprovalMode.DEFAULT;

  useKeypress(
    (key) => {
      const isShiftTab = key.shift && key.name === 'tab';
      const isWindowsTab =
        process.platform === 'win32' &&
        key.name === 'tab' &&
        !key.ctrl &&
        !key.meta;
      if (isShiftTab || isWindowsTab) {
        const currentIndex = APPROVAL_MODES.indexOf(agentApprovalMode);
        const nextIndex =
          currentIndex === -1 ? 0 : (currentIndex + 1) % APPROVAL_MODES.length;
        setAgentApprovalMode(agentId, APPROVAL_MODES[nextIndex]!);
      }
    },
    { isActive: !agentShellFocused },
  );

  // ── Input buffer (independent from main agent) ──

  const isValidPath = useCallback((): boolean => false, []);

  const buffer = useTextBuffer({
    initialText: '',
    viewport: { height: 3, width: inputWidth },
    stdin,
    setRawMode,
    isValidPath,
  });

  // Sync agent buffer text to context so AgentTabBar can guard tab switching
  useEffect(() => {
    setAgentInputBufferText(buffer.text);
    return () => setAgentInputBufferText('');
  }, [buffer.text, setAgentInputBufferText]);

  // When agent input is not active (agent running, completed, etc.),
  // auto-focus the tab bar so arrow keys switch tabs directly.
  // We also depend on streamingState so that transitions like
  // WaitingForConfirmation → Responding re-trigger the effect — the
  // approval keypress releases tab-bar focus (printable char handler),
  // but isInputActive stays false throughout, so without this extra
  // dependency the focus would never be restored.
  useEffect(() => {
    if (!isInputActive) {
      setAgentTabBarFocused(true);
    }
  }, [isInputActive, streamingState, setAgentTabBarFocused]);

  // ── Focus management between input and tab bar ──

  const handleKeypress = useCallback(
    (key: Key): boolean => {
      // When tab bar has focus, block all non-printable keys so they don't
      // act on the hidden buffer. Printable characters fall through to
      // BaseTextInput naturally; the tab bar handler releases focus on the
      // same event so the keystroke appears in the input immediately.
      if (agentTabBarFocused) {
        if (
          key.sequence &&
          key.sequence.length === 1 &&
          !key.ctrl &&
          !key.meta
        ) {
          return false; // let BaseTextInput type the character
        }
        return true; // consume non-printable keys
      }

      // Down arrow at the bottom edge (or empty buffer) → focus the tab bar
      if (keyMatchers[Command.NAVIGATION_DOWN](key)) {
        if (
          buffer.text === '' ||
          buffer.allVisualLines.length === 1 ||
          buffer.visualCursor[0] === buffer.allVisualLines.length - 1
        ) {
          setAgentTabBarFocused(true);
          return true;
        }
      }
      return false;
    },
    [buffer, agentTabBarFocused, setAgentTabBarFocused],
  );

  // ── Message queue (mid-turn drain: always enqueue, track display locally) ──

  const [pendingMessages, setPendingMessages] = useState<string[]>([]);

  // Clear display when messages are consumed mid-turn or agent goes idle.
  useEffect(() => {
    const emitter = interactiveAgent?.getEventEmitter();
    if (!emitter) return;

    const clearDisplay = () => setPendingMessages([]);
    const clearOnIdle = (event: { newStatus?: AgentStatus }) => {
      if (event.newStatus === AgentStatus.IDLE) {
        setPendingMessages([]);
      }
    };
    emitter.on(AgentEventType.QUEUE_MESSAGES_CONSUMED, clearDisplay);
    emitter.on(AgentEventType.STATUS_CHANGE, clearOnIdle);

    return () => {
      emitter.off(AgentEventType.QUEUE_MESSAGES_CONSUMED, clearDisplay);
      emitter.off(AgentEventType.STATUS_CHANGE, clearOnIdle);
    };
  }, [interactiveAgent]);

  const handleSubmit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !interactiveAgent) return;
      // Always enqueue directly — mid-turn drain picks up messages
      // during tool execution rather than waiting for idle.
      interactiveAgent.enqueueMessage(trimmed);
      // Track for display when agent is busy
      if (streamingState !== StreamingState.Idle) {
        setPendingMessages((prev) => [...prev, trimmed]);
      }
    },
    [interactiveAgent, streamingState],
  );

  // ── Render ──

  const statusLabel = useMemo(() => {
    switch (status) {
      case AgentStatus.COMPLETED:
        return { text: t('Completed'), color: theme.status.success };
      case AgentStatus.FAILED:
        return {
          text: t('Failed: {{error}}', {
            error:
              interactiveAgent?.getError() ??
              interactiveAgent?.getLastRoundError() ??
              'unknown',
          }),
          color: theme.status.error,
        };
      case AgentStatus.CANCELLED:
        return { text: t('Cancelled'), color: theme.text.secondary };
      default:
        return null;
    }
  }, [status, interactiveAgent]);

  // ── Approval-mode styling (mirrors main InputPrompt) ──

  const isYolo = agentApprovalMode === ApprovalMode.YOLO;
  const isAutoAccept = agentApprovalMode !== ApprovalMode.DEFAULT;

  const statusColor = isYolo
    ? theme.status.errorDim
    : isAutoAccept
      ? theme.status.warningDim
      : undefined;

  const inputBorderColor =
    !isInputActive || agentTabBarFocused
      ? theme.border.default
      : (statusColor ?? theme.border.focused);

  const prefixNode = (
    <Text color={statusColor ?? theme.text.accent}>{isYolo ? '*' : '>'} </Text>
  );

  return (
    <StreamingContext.Provider value={streamingState}>
      <Box flexDirection="column" marginTop={1}>
        {/* Loading indicator — mirrors main Composer but reads agent's
            streaming state via the overridden StreamingContext. */}
        <LoadingIndicator
          currentLoadingPhrase={
            streamingState === StreamingState.Responding
              ? t('Thinking…')
              : undefined
          }
          elapsedTime={elapsedTime}
        />

        {/* Terminal status for completed/failed agents */}
        {statusLabel && (
          <Box marginLeft={2}>
            <Text color={statusLabel.color}>{statusLabel.text}</Text>
          </Box>
        )}

        <QueuedMessageDisplay messageQueue={pendingMessages} />

        {/* Input prompt — always visible, like the main Composer */}
        <BaseTextInput
          buffer={buffer}
          onSubmit={handleSubmit}
          onKeypress={handleKeypress}
          showCursor={isInputActive && !agentTabBarFocused}
          placeholder={'  ' + t('Send a message to this agent')}
          prefix={prefixNode}
          borderColor={inputBorderColor}
          isActive={isInputActive && !agentShellFocused}
        />

        {/* Footer: approval mode + context usage */}
        <AgentFooter
          approvalMode={agentApprovalMode}
          promptTokenCount={lastPromptTokenCount}
          contextWindowSize={
            config.getContentGeneratorConfig()?.contextWindowSize
          }
          terminalWidth={terminalWidth}
        />
      </Box>
    </StreamingContext.Provider>
  );
};
