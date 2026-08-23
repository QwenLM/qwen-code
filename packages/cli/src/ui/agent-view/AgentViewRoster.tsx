/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../semantic-colors.js';
import { Header } from '../components/Header.js';
import { Tips } from '../components/Tips.js';
import { BaseTextInput } from '../components/BaseTextInput.js';
import { SuggestionsDisplay } from '../components/SuggestionsDisplay.js';
import { useTextBuffer } from '../components/shared/text-buffer.js';
import {
  CompletionMode,
  useCommandCompletion,
} from '../hooks/useCommandCompletion.js';
import type { Key } from '../hooks/useKeypress.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from '../commands/types.js';
import type { LoadedSettings } from '../../config/settings.js';
import { BuiltinCommandLoader } from '../../services/BuiltinCommandLoader.js';
import {
  isAgentRosterBlockingWait,
  type AgentRosterGroupMode,
  type AgentRosterRow,
} from './roster-model.js';
import {
  cleanSingleLineText,
  stripUnsafeCharacters,
  truncateToWidth,
} from '../utils/textUtils.js';

export interface AgentViewHeaderInfo {
  version: string;
  cwd: string;
  model?: string;
  authLabel?: string;
  providerLabel?: string;
}

export interface AgentViewRosterProps {
  rows: AgentRosterRow[];
  prompt: string;
  promptVersion?: number;
  selectedIndex: number;
  groupMode: AgentRosterGroupMode;
  header?: AgentViewHeaderInfo;
  notice?: AgentViewNotice;
  peekPanel?: AgentViewPanel;
  peekPrompt?: string;
  peekInputMode?: 'answer' | 'send';
  peekQueuedPrompts?: string[];
  slashCommands?: readonly SlashCommand[];
  onPromptChange: (prompt: string) => void;
  onPromptEdit?: () => void;
  onPeekPromptChange: (prompt: string) => void;
  onDispatch: (attach: boolean, prompt: string) => boolean;
  onSubmitPeekPrompt: (promptOverride?: string) => boolean;
  onAttachSession: (sessionId: string) => void;
  onPeekSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, displayName: string) => void;
  onStopOrRemoveSession: (sessionId: string) => void;
  onToggleGroupMode: () => void;
  onShowHelp: () => void;
  onInterrupt: (clearedDraft: boolean) => void;
  onMoveSelection: (delta: number) => void;
  onCancel: () => void;
}

export type AgentViewPanel =
  | AgentViewSessionPanel
  | {
      kind: 'filter';
      query: string;
      lines: string[];
    }
  | {
      kind: 'message';
      title: string;
      tone: 'info' | 'error';
      lines: string[];
    };

export interface AgentViewSessionPanel {
  kind: 'session';
  sessionId: string;
  content: 'activity' | 'message';
  tone?: 'error';
  lines: string[];
}

export interface AgentViewNotice {
  title?: string;
  lines: string[];
}

interface AgentViewPromptInput {
  buffer: ReturnType<typeof useTextBuffer>;
  suggestions: ReturnType<typeof useCommandCompletion>['suggestions'];
  activeSuggestionIndex: number;
  visibleStartIndex: number;
  showSuggestions: boolean;
  isLoadingSuggestions: boolean;
  isPerfectMatch: boolean;
  completionMode: CompletionMode;
  suggestionsWidth: number;
  dismissCompletion: () => void;
  handleCompletionKey: (input: string, key: RosterInputKey) => boolean;
  handleBufferKey: (input: string, key: RosterInputKey) => void;
}

interface RosterInputKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  tab?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  backspace?: boolean;
  delete?: boolean;
  escape?: boolean;
}

export function AgentViewRoster({
  rows,
  prompt,
  promptVersion = 0,
  selectedIndex,
  groupMode,
  header,
  notice,
  peekPanel,
  peekPrompt = '',
  peekInputMode,
  peekQueuedPrompts,
  slashCommands = AGENT_VIEW_SLASH_COMMANDS,
  onPromptChange,
  onPromptEdit,
  onPeekPromptChange,
  onDispatch,
  onSubmitPeekPrompt,
  onAttachSession,
  onPeekSession,
  onTogglePinSession,
  onRenameSession,
  onStopOrRemoveSession,
  onToggleGroupMode,
  onShowHelp,
  onInterrupt,
  onMoveSelection,
  onCancel,
}: AgentViewRosterProps) {
  const loadedSlashCommands = useAgentViewSlashCommands(slashCommands);
  const promptInput = useAgentViewPromptInput({
    prompt,
    promptVersion,
    slashCommands: loadedSlashCommands,
    onPromptChange,
  });
  const promptEditedRef = useRef(false);
  useEffect(() => {
    promptEditedRef.current = false;
  }, [promptVersion]);
  const peekPromptPending = Boolean(peekQueuedPrompts?.length);
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const panelSessionId =
    peekPanel?.kind === 'session' ? peekPanel.sessionId : undefined;
  const peekRow = rows.find((row) => row.sessionId === panelSessionId);
  // A blocking approval (e.g. 'Waiting: Edit') must stay answerable even
  // while follow-up prompts are queued.
  const peekBlockingWait = Boolean(
    peekRow && isAgentRosterBlockingWait(peekRow),
  );
  const peekInputActive = Boolean(
    peekPanel && peekInputMode && (!peekPromptPending || peekBlockingWait),
  );
  const sessionPeekActive = Boolean(peekPanel?.kind === 'session' && peekRow);
  // Ink can emit multiple input events within one tick before React
  // re-renders; an imperative mirror keeps peek accumulation from reading a
  // stale prop on the second event.
  const peekPromptRef = useRef(peekPrompt);
  const terminalEscapePendingRef = useRef(false);
  useEffect(() => {
    peekPromptRef.current = peekPrompt;
  }, [peekPrompt]);

  useInput((input, key) => {
    const currentPrompt = promptInput.buffer.text;
    const hasPrompt = currentPrompt.trim().length > 0;

    if (key.escape) {
      terminalEscapePendingRef.current = false;
    } else if (
      isUnresolvedTerminalControlInput(input, terminalEscapePendingRef)
    ) {
      return;
    }

    const selectedRow = rows[selectedIndexRef.current];
    const actionRow = peekPanel?.kind === 'session' ? peekRow : selectedRow;

    if (key.escape) {
      if (promptInput.showSuggestions) {
        promptInput.dismissCompletion();
        return;
      }
      if (peekPanel) {
        peekPromptRef.current = '';
        onPeekPromptChange('');
      } else {
        promptEditedRef.current = false;
      }
      onCancel();
      return;
    }

    if (
      isCtrlInput(input, key, 't', '\x14') &&
      actionRow &&
      !sessionPeekActive
    ) {
      onTogglePinSession(actionRow.sessionId);
      return;
    }

    if (
      isCtrlInput(input, key, 'r', '\x12') &&
      actionRow &&
      !sessionPeekActive
    ) {
      const displayName = currentPrompt.trim();
      promptEditedRef.current = false;
      promptInput.buffer.setText('');
      onRenameSession(actionRow.sessionId, displayName);
      return;
    }

    if (isCtrlInput(input, key, 'x', '\x18') && actionRow) {
      onStopOrRemoveSession(actionRow.sessionId);
      return;
    }

    if (isCtrlInput(input, key, 's', '\x13')) {
      onToggleGroupMode();
      return;
    }

    if (isCtrlInput(input, key, 'c', '\x03')) {
      if (peekInputActive && peekPromptRef.current) {
        peekPromptRef.current = '';
        onPeekPromptChange('');
        onInterrupt(true);
        return;
      }
      if (!peekInputActive && (hasPrompt || promptEditedRef.current)) {
        promptEditedRef.current = false;
        onPromptEdit?.();
        promptInput.buffer.setText('');
        onPromptChange('');
        onInterrupt(true);
        return;
      }
      onInterrupt(false);
      return;
    }

    if (input === '?' && !hasPrompt && !peekInputActive) {
      onShowHelp();
      return;
    }

    if (
      !peekInputActive &&
      !(
        isReturnInput(input, key) &&
        isExactSlashCommand(currentPrompt, loadedSlashCommands)
      ) &&
      promptInput.handleCompletionKey(input, key)
    ) {
      if (key.tab) {
        promptEditedRef.current = true;
        onPromptEdit?.();
      }
      return;
    }

    if (key.upArrow && !sessionPeekActive) {
      selectedIndexRef.current = Math.max(0, selectedIndexRef.current - 1);
      onMoveSelection(-1);
      return;
    }

    if (key.downArrow && !sessionPeekActive) {
      selectedIndexRef.current = Math.max(
        0,
        Math.min(rows.length - 1, selectedIndexRef.current + 1),
      );
      onMoveSelection(1);
      return;
    }

    const returnPrefix = getReturnInputPrefix(input, key);
    const isReturn = returnPrefix !== undefined;
    const legacyShiftEnter = input === '\\\r' || input === '\\\r\n';

    if (
      isReturn &&
      peekPanel?.kind === 'session' &&
      !peekRow &&
      !`${currentPrompt}${returnPrefix}`.trim()
    ) {
      return;
    }

    if (sessionPeekActive && peekRow && !peekInputActive) {
      if (isReturn && rows.length > 0) {
        onAttachSession(peekRow.sessionId);
      } else if (input === ' ') {
        onCancel();
      }
      return;
    }

    if (isReturn) {
      if (peekInputActive) {
        const submittedPeekPrompt = `${peekPromptRef.current}${returnPrefix}`;
        if (submittedPeekPrompt.trim()) {
          if (onSubmitPeekPrompt(submittedPeekPrompt)) {
            peekPromptRef.current = '';
          }
        } else if (peekRow) {
          onAttachSession(peekRow.sessionId);
        }
      } else {
        const submittedPrompt = `${currentPrompt}${returnPrefix}`;
        if (submittedPrompt.trim()) {
          if (
            onDispatch(Boolean(key.shift || legacyShiftEnter), submittedPrompt)
          ) {
            promptEditedRef.current = false;
            promptInput.buffer.setText('');
          }
        } else if (rows.length > 0) {
          if (selectedRow) onAttachSession(selectedRow.sessionId);
        }
      }
      return;
    }

    if (key.rightArrow && !hasPrompt && !peekInputActive && actionRow) {
      // Only consume Right when it actually attaches; otherwise fall through
      // so the buffer's cursor-right movement keeps working while a prompt
      // is typed.
      onAttachSession(actionRow.sessionId);
      return;
    }

    if (
      input === ' ' &&
      sessionPeekActive &&
      !peekPromptRef.current.trim() &&
      !hasPrompt
    ) {
      onCancel();
      return;
    }

    if (input === ' ' && !hasPrompt && !sessionPeekActive && rows.length > 0) {
      if (selectedRow) onPeekSession(selectedRow.sessionId);
      return;
    }

    if (key.backspace || key.delete) {
      if (peekInputActive) {
        // Delete one code point so astral characters (emoji) are not split
        // into lone surrogates.
        const next = Array.from(peekPromptRef.current).slice(0, -1).join('');
        peekPromptRef.current = next;
        onPeekPromptChange(next);
      } else {
        promptEditedRef.current = true;
        onPromptEdit?.();
        promptInput.handleBufferKey(input, key);
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (peekInputActive) {
        const next = `${peekPromptRef.current}${input}`;
        peekPromptRef.current = next;
        onPeekPromptChange(next);
      } else {
        promptEditedRef.current = true;
        onPromptEdit?.();
        promptInput.handleBufferKey(input, key);
      }
      return;
    }

    if (!peekInputActive) {
      promptInput.handleBufferKey(input, key);
    }
  });

  return (
    <Box flexDirection="column">
      <AgentViewHeader header={header} summary={formatRosterSummary(rows)} />
      <Box flexDirection="column" marginBottom={1}>
        {rows.length === 0 ? (
          <Text dimColor>No sessions</Text>
        ) : (
          getRosterSections(rows, groupMode).map((section) => (
            <Box key={section.key} flexDirection="column">
              <Text dimColor>{section.label}</Text>
              {section.rows.map(({ row, index }) => (
                <RosterRow
                  key={row.sessionId}
                  row={row}
                  selected={index === selectedIndex}
                />
              ))}
            </Box>
          ))
        )}
      </Box>
      {peekPanel ? (
        <Box flexDirection="column" marginBottom={1}>
          {peekPanel.kind === 'session' && sessionPeekActive && peekRow ? (
            <SessionPeekBox
              row={peekRow}
              panel={peekPanel}
              prompt={peekPrompt}
              inputMode={peekInputMode}
              queuedPrompts={peekQueuedPrompts}
            />
          ) : (
            <>
              <Text bold>{getPanelTitle(peekPanel)}</Text>
              {peekPanel.lines.map((line, index) => (
                <Text key={index} dimColor>
                  {line}
                </Text>
              ))}
            </>
          )}
        </Box>
      ) : null}
      {notice ? (
        <Box flexDirection="column" marginBottom={1}>
          {notice.title ? <Text bold>{notice.title}</Text> : null}
          {notice.lines.map((line, index) => (
            <Text key={index} color={theme.text.secondary}>
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      {sessionPeekActive ? null : (
        <AgentViewPromptBox
          promptInput={promptInput}
          placeholder={getInputPlaceholder()}
        />
      )}
    </Box>
  );
}

function isReturnInput(input: string, key: RosterInputKey): boolean {
  return getReturnInputPrefix(input, key) !== undefined;
}

const CSI_RESIDUE_PATTERN = /^\[[\x20-\x3f]*[\x40-\x7e]$/;

function isUnresolvedTerminalControlInput(
  input: string,
  pendingEscape: { current: boolean },
): boolean {
  if (input.includes('\x1b')) {
    pendingEscape.current = input === '\x1b';
    return true;
  }
  if (!pendingEscape.current) return false;
  pendingEscape.current = false;
  return CSI_RESIDUE_PATTERN.test(input);
}

function getReturnInputPrefix(
  input: string,
  key: RosterInputKey,
): string | undefined {
  if (key.return) {
    return '';
  }
  if (input === '\\\r' || input === '\\\r\n') {
    return '';
  }
  // Ink reports pasted LF chunks without key.return. Keep them in the
  // cursor-aware text insertion path instead of treating the paste as a
  // submit; PTY Enter and legacy VSCode Shift+Enter use CR.
  if (!key.return && input.includes('\n')) {
    return undefined;
  }
  const returnIndex = input.search(/[\r\n]/);
  if (returnIndex < 0) {
    return undefined;
  }
  // Content after the newline means a multi-line paste; submitting here
  // would silently discard the tail, so let the chunk fall through to the
  // text-insert path instead.
  if (input.slice(returnIndex + 1).trim() !== '') {
    return undefined;
  }
  return input.slice(0, returnIndex);
}

// Commands the roster can actually execute locally. Any other built-in
// command offered by typeahead would otherwise be dispatched as the initial
// prompt of a brand-new background session.
const ROSTER_EXECUTABLE_COMMAND_NAMES = new Set([
  'exit',
  'quit',
  'resume',
  'continue',
]);

function useAgentViewSlashCommands(
  fallbackCommands: readonly SlashCommand[],
): readonly SlashCommand[] {
  const [commands, setCommands] =
    useState<readonly SlashCommand[]>(fallbackCommands);

  useEffect(() => {
    if (fallbackCommands !== AGENT_VIEW_SLASH_COMMANDS) {
      setCommands(fallbackCommands);
      return undefined;
    }
    let disposed = false;
    const abortController = new AbortController();
    void new BuiltinCommandLoader(null)
      .loadCommands(abortController.signal)
      .then((loadedCommands) => {
        if (disposed) return;
        // Keep user commands / MCP prompts / skills dispatchable, but limit
        // built-ins to the ones the roster handles.
        const filtered = loadedCommands.filter(
          (command) =>
            command.kind !== CommandKind.BUILT_IN ||
            ROSTER_EXECUTABLE_COMMAND_NAMES.has(command.name.toLowerCase()),
        );
        if (filtered.length > 0) {
          setCommands(filtered);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      abortController.abort();
    };
  }, [fallbackCommands]);

  return commands;
}

function AgentViewHeader({
  header,
  summary,
}: {
  header: AgentViewHeaderInfo | undefined;
  summary: string;
}) {
  const cwd = header?.cwd ?? process.cwd();
  const version = header?.version ?? 'unknown';
  const model = formatHeaderModel(header);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Header
        version={version}
        authDisplayType={header?.authLabel}
        model={model}
        workingDirectory={cwd}
      />
      <Tips />
      <Text dimColor>{summary}</Text>
    </Box>
  );
}

function useAgentViewPromptInput({
  prompt,
  promptVersion,
  slashCommands,
  onPromptChange,
}: {
  prompt: string;
  promptVersion: number;
  slashCommands: readonly SlashCommand[];
  onPromptChange: (prompt: string) => void;
}): AgentViewPromptInput {
  const inputWidth = Math.max(20, Math.min(process.stdout.columns ?? 80, 160));
  const suggestionsWidth = Math.max(20, inputWidth - 4);
  const commandContext = useMemo(() => createAgentViewCommandContext(), []);
  const lastPromptRef = useRef(prompt);
  const lastSeenPromptPropRef = useRef(prompt);
  const lastSeenPromptVersionRef = useRef(promptVersion);
  // Count emitted values so repeated intermediate states can each consume one
  // lagging prop echo without overwriting newer text.
  const emittedPromptCountsRef = useRef<Map<string, number>>(new Map());
  const onChange = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === lastPromptRef.current) {
        return;
      }
      lastPromptRef.current = nextPrompt;
      const emittedCount = emittedPromptCountsRef.current.get(nextPrompt) ?? 0;
      emittedPromptCountsRef.current.set(nextPrompt, emittedCount + 1);
      onPromptChange(nextPrompt);
    },
    [onPromptChange],
  );
  const buffer = useTextBuffer({
    initialText: prompt,
    initialCursorOffset: Array.from(prompt).length,
    viewport: { height: 3, width: Math.max(10, inputWidth - 4) },
    onChange,
    isValidPath: () => false,
  });
  const completion = useCommandCompletion(
    buffer,
    process.cwd(),
    slashCommands,
    commandContext,
  );

  useEffect(() => {
    if (promptVersion !== lastSeenPromptVersionRef.current) {
      lastSeenPromptVersionRef.current = promptVersion;
      lastSeenPromptPropRef.current = prompt;
      lastPromptRef.current = prompt;
      emittedPromptCountsRef.current.clear();
      buffer.setText(prompt);
      return;
    }
    if (prompt === lastSeenPromptPropRef.current) {
      return;
    }
    lastSeenPromptPropRef.current = prompt;
    if (prompt === lastPromptRef.current) {
      // In-order echo of a value we emitted; the buffer already has it.
      emittedPromptCountsRef.current.clear();
      return;
    }
    const emittedCount = emittedPromptCountsRef.current.get(prompt) ?? 0;
    const isEcho = emittedCount > 0;
    if (emittedCount <= 1) {
      emittedPromptCountsRef.current.delete(prompt);
    } else {
      emittedPromptCountsRef.current.set(prompt, emittedCount - 1);
    }
    lastPromptRef.current = prompt;
    if (prompt === buffer.text) {
      return;
    }
    if (isEcho) {
      // A lagging echo of an intermediate typed value must not clobber
      // newer text. Genuine external updates always reach the buffer.
      return;
    }
    buffer.setText(prompt);
  }, [buffer, prompt, promptVersion]);

  const acceptActiveSuggestion = useCallback((): boolean => {
    if (completion.suggestions.length === 0) {
      return false;
    }
    const targetIndex =
      completion.activeSuggestionIndex === -1
        ? 0
        : completion.activeSuggestionIndex;
    if (targetIndex < 0 || targetIndex >= completion.suggestions.length) {
      return false;
    }
    completion.handleAutocomplete(targetIndex);
    return true;
  }, [completion]);

  const handleCompletionKey = useCallback(
    (_input: string, key: RosterInputKey): boolean => {
      if (!completion.showSuggestions) {
        return false;
      }
      if (key.upArrow) {
        completion.navigateUp();
        return true;
      }
      if (key.downArrow) {
        completion.navigateDown();
        return true;
      }
      if (
        getReturnInputPrefix(_input, key) === '' &&
        completion.completionMode === CompletionMode.SLASH
      ) {
        const targetIndex =
          completion.activeSuggestionIndex === -1
            ? 0
            : completion.activeSuggestionIndex;
        const suggestion = completion.suggestions[targetIndex];
        const query = buffer.text.trim().slice(1).split(/\s/, 1)[0] ?? '';
        const normalizedQuery = query.toLowerCase();
        const matchesQuery = [suggestion?.value, suggestion?.matchedAlias]
          .filter((value): value is string => value !== undefined)
          .some((value) => value.toLowerCase().startsWith(normalizedQuery));
        if (
          !suggestion ||
          !matchesQuery ||
          suggestion.value.toLowerCase() === normalizedQuery
        ) {
          return false;
        }
        return acceptActiveSuggestion();
      }
      if (key.tab) {
        acceptActiveSuggestion();
        return true;
      }
      return false;
    },
    [acceptActiveSuggestion, buffer.text, completion],
  );

  const handleBufferKey = useCallback(
    (input: string, key: RosterInputKey) => {
      buffer.handleInput(toTextBufferKey(input, key));
    },
    [buffer],
  );

  return {
    buffer,
    suggestions: completion.suggestions,
    activeSuggestionIndex: completion.activeSuggestionIndex,
    visibleStartIndex: completion.visibleStartIndex,
    showSuggestions: completion.showSuggestions,
    isLoadingSuggestions: completion.isLoadingSuggestions,
    isPerfectMatch: completion.isPerfectMatch,
    completionMode: completion.completionMode,
    suggestionsWidth,
    dismissCompletion: completion.dismissCompletion,
    handleCompletionKey,
    handleBufferKey,
  };
}

function toTextBufferKey(input: string, key: RosterInputKey): Key {
  return {
    name: getInputKeyName(input, key),
    ctrl: Boolean(key.ctrl),
    meta: Boolean(key.meta),
    shift: Boolean(key.shift),
    // A multi-codepoint chunk is a paste: route it through the insert path
    // so text literally reading "delete"/"backspace"/... is not executed as
    // that control key.
    paste: Array.from(input).length > 1,
    sequence: input,
  };
}

function getInputKeyName(input: string, key: RosterInputKey): string {
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.home) return 'home';
  if (key.end) return 'end';
  if (isReturnInput(input, key)) return 'return';
  if (key.tab || input === '\t') return 'tab';
  if (key.backspace) return 'backspace';
  if (key.delete) return 'delete';
  if (key.escape) return 'escape';
  return input;
}

function createAgentViewCommandContext(): CommandContext {
  const noop = () => undefined;
  return {
    executionMode: 'interactive',
    services: {
      config: null,
      settings: {} as LoadedSettings,
      logger: null,
    },
    ui: {
      history: [],
      addItem: () => 0,
      clear: noop,
      setDebugMessage: noop,
      pendingItem: null,
      setPendingItem: noop,
      btwItem: null,
      setBtwItem: noop,
      cancelBtw: noop,
      btwAbortControllerRef: { current: null },
      isIdleRef: { current: true },
      loadHistory: noop,
      refreshStatic: noop,
      toggleVimEnabled: async () => false,
      setGeminiMdFileCount: noop,
      reloadCommands: noop,
      setSessionName: noop,
      extensionsUpdateState: new Map(),
      dispatchExtensionStateUpdate: noop,
      addConfirmUpdateExtensionRequest: noop,
    },
    session: {
      stats: {} as CommandContext['session']['stats'],
      sessionShellAllowlist: new Set(),
    },
  };
}

function isExactSlashCommand(
  prompt: string,
  slashCommands: readonly SlashCommand[],
): boolean {
  const command = prompt
    .trim()
    .match(/^\/(\S+)$/)?.[1]
    ?.toLowerCase();
  if (!command) {
    return false;
  }
  return slashCommands.some(
    (slashCommand) =>
      slashCommand.name.toLowerCase() === command ||
      slashCommand.altNames?.some((name) => name.toLowerCase() === command),
  );
}

const AGENT_VIEW_SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: 'exit',
    altNames: ['quit'],
    description: 'Exit Agent View',
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  },
  {
    name: 'quit',
    altNames: ['exit'],
    description: 'Exit Agent View',
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  },
  {
    name: 'resume',
    altNames: ['continue'],
    description: 'Resume a previous session',
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  },
  {
    name: 'continue',
    altNames: ['resume'],
    description: 'Resume a previous session',
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  },
];

function formatHeaderModel(header: AgentViewHeaderInfo | undefined): string {
  const model = header?.model ?? 'unknown model';
  return header?.providerLabel ? `[${header.providerLabel}] ${model}` : model;
}

function formatRosterSummary(rows: AgentRosterRow[]): string {
  const needsInput = rows.filter(
    (row) => row.stateGroup === 'needs_input',
  ).length;
  const working = rows.filter((row) => row.stateGroup === 'working').length;
  const completed = rows.filter((row) => row.stateGroup === 'done').length;
  return `${needsInput} awaiting input - ${working} working - ${completed} completed`;
}

function getInputPlaceholder(): string {
  return 'describe a task for a new session';
}

function getPeekInputPlaceholder(): string {
  return 'reply';
}

function SessionPeekBox({
  row,
  panel,
  prompt,
  inputMode,
  queuedPrompts,
}: {
  row: AgentRosterRow;
  panel: AgentViewSessionPanel;
  prompt: string;
  inputMode: 'answer' | 'send' | undefined;
  queuedPrompts: string[] | undefined;
}) {
  const maxLineWidth = Math.max(1, (process.stdout.columns ?? 80) - 4);
  const lines = getSessionPeekLines(row, panel, queuedPrompts, maxLineWidth);
  const blockingWait = isAgentRosterBlockingWait(row);
  const inputActive = Boolean(
    inputMode && (!queuedPrompts?.length || blockingWait),
  );
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>
        <Text bold>{formatRowName(row)}</Text>{' '}
        <Text color={theme.text.secondary}>{row.ageLabel}</Text>
      </Text>
      {lines.map((line, index) => (
        <Text
          key={`${index}:${line}`}
          color={
            line.startsWith('> ') ? theme.text.primary : theme.text.secondary
          }
        >
          {line}
        </Text>
      ))}
      {inputActive ? (
        <Box marginTop={1}>
          <Text color={theme.text.accent}>{'>'} </Text>
          {prompt ? (
            <Text>{prompt}</Text>
          ) : (
            <Text color={theme.text.secondary}>
              {getPeekInputPlaceholder()}
            </Text>
          )}
        </Box>
      ) : null}
      <Text color={theme.text.secondary}>
        {getPeekFooter(inputActive ? inputMode : undefined, queuedPrompts)}
      </Text>
    </Box>
  );
}

function getPeekFooter(
  inputMode: 'answer' | 'send' | undefined,
  queuedPrompts: string[] | undefined,
): string {
  if (inputMode) {
    return 'enter to send · space to close · ctrl+x to delete';
  }
  if (queuedPrompts?.length) {
    return 'waiting for response · space to close · ctrl+x to delete';
  }
  return 'enter to open · space to close · ctrl+x to delete';
}

function AgentViewPromptBox({
  promptInput,
  placeholder,
}: {
  promptInput: AgentViewPromptInput;
  placeholder: string;
}) {
  return (
    <Box flexDirection="column">
      <BaseTextInput
        buffer={promptInput.buffer}
        onSubmit={() => undefined}
        showCursor
        placeholder={placeholder}
        isActive={false}
        borderColor={theme.border.focused}
      />
      {promptInput.showSuggestions ? (
        <Box marginLeft={2} marginRight={2}>
          <SuggestionsDisplay
            suggestions={promptInput.suggestions}
            activeIndex={promptInput.activeSuggestionIndex}
            isLoading={promptInput.isLoadingSuggestions}
            width={promptInput.suggestionsWidth}
            scrollOffset={promptInput.visibleStartIndex}
            userInput={promptInput.buffer.text}
            mode={
              promptInput.completionMode === CompletionMode.SLASH
                ? 'slash'
                : 'reverse'
            }
          />
        </Box>
      ) : null}
      <Text color={theme.text.secondary}>
        {'enter to open · space to reply · ctrl+x to delete ·'}
      </Text>
    </Box>
  );
}

function getSessionPeekLines(
  row: AgentRosterRow,
  panel: AgentViewSessionPanel,
  queuedPrompts: readonly string[] | undefined,
  maxWidth: number,
): string[] {
  const lines =
    panel.content === 'message'
      ? panel.lines
      : [
          cleanRowText(row.lastResult) ?? cleanRowText(row.summary),
          formatWaitingLine(row.waitingFor),
          getQueuedPromptLine(queuedPrompts),
        ].filter((line): line is string => Boolean(line));
  const normalized = lines
    .map((line) => cleanSingleLineText(stripUnsafeCharacters(line)))
    .filter(Boolean);
  const visible = normalized.slice(0, 5);
  if (normalized.length > visible.length) {
    visible[visible.length - 1] = '…';
  }
  return visible.map((line) => truncateToWidth(line, maxWidth));
}

function getPanelTitle(panel: AgentViewPanel): string {
  if (panel.kind === 'session') return panel.sessionId;
  if (panel.kind === 'filter') return 'Filter';
  return panel.title;
}

function formatWaitingLine(waitingFor: string | undefined): string | undefined {
  if (!waitingFor || waitingFor === 'response') {
    return undefined;
  }
  const text = cleanSingleLineText(waitingFor);
  return text ? `Waiting: ${text}` : undefined;
}

function getQueuedPromptLine(
  queuedPrompts: readonly string[] | undefined,
): string | undefined {
  if (!queuedPrompts || queuedPrompts.length === 0) {
    return undefined;
  }
  const latest = cleanSingleLineText(queuedPrompts.at(-1) ?? '');
  if (!latest) {
    return undefined;
  }
  return `Waiting for response: ${latest}`;
}

function getRosterSections(
  rows: AgentRosterRow[],
  groupMode: AgentRosterGroupMode,
): Array<{
  key: string;
  label: string;
  rows: Array<{ row: AgentRosterRow; index: number }>;
}> {
  const sections = new Map<
    string,
    Array<{ row: AgentRosterRow; index: number }>
  >();
  rows.forEach((row, index) => {
    const label =
      groupMode === 'directory' ? row.project : getStateGroupLabel(row);
    const section = sections.get(label) ?? [];
    section.push({ row, index });
    sections.set(label, section);
  });
  return Array.from(sections, ([key, sectionRows]) => ({
    key,
    label: cleanSingleLineText(key),
    rows: sectionRows,
  }));
}

function getStateGroupLabel(row: AgentRosterRow): string {
  if (row.pinned) return 'Pinned';
  switch (row.stateGroup) {
    case 'needs_input':
      return 'Needs input';
    case 'working':
      return 'Working';
    case 'done':
      return 'Completed';
    default:
      return row.stateLabel;
  }
}

function isCtrlInput(
  input: string,
  key: { ctrl?: boolean },
  letter: string,
  code: string,
): boolean {
  return (key.ctrl && input.toLowerCase() === letter) || input === code;
}

function RosterRow({
  row,
  selected,
}: {
  row: AgentRosterRow;
  selected: boolean;
}) {
  const prefix = selected ? '>' : ' ';
  const marker = row.iconShape === 'alive' ? '*' : '.';
  const name = formatRowName(row);
  const output = formatRowOutput(row);
  const columns = formatRosterRowColumns({
    name,
    output,
    ageLabel: row.ageLabel,
  });

  return (
    <Box height={1}>
      <Text color={selected ? theme.text.accent : theme.text.secondary}>
        {prefix}{' '}
      </Text>
      <Text color={getRosterMarkerColor(row)}>{marker}</Text>
      <Text color={selected ? theme.text.accent : theme.text.primary}>
        {' '}
        {columns.name}{' '}
      </Text>
      <Text color={selected ? theme.text.accent : theme.text.secondary}>
        {columns.output} {columns.ageLabel}
      </Text>
    </Box>
  );
}

function getRosterMarkerColor(row: AgentRosterRow): string {
  switch (row.iconTone) {
    case 'needs_input':
      return theme.status.warning;
    case 'working':
      return theme.status.success;
    case 'failed':
      return theme.status.error;
    case 'stopped':
      return theme.status.error;
    case 'ready':
      return theme.text.secondary;
    default:
      return theme.text.secondary;
  }
}

function formatRowName(row: AgentRosterRow): string {
  return (
    cleanRowText(row.displayName) ??
    cleanRowText(row.title) ??
    'Untitled session'
  );
}

function formatRowOutput(row: AgentRosterRow): string {
  return cleanRowText(row.subtitle) ?? cleanRowText(row.lastResult) ?? '';
}

function cleanRowText(value: string | undefined): string | undefined {
  // Worker/model output is untrusted; strip unsafe control sequences before
  // rendering it into the operator's terminal.
  const text = value ? cleanSingleLineText(value) : undefined;
  return text ? text : undefined;
}

function formatRosterRowColumns({
  name,
  output,
  ageLabel,
}: {
  name: string;
  output: string;
  ageLabel: string;
}): { name: string; output: string; ageLabel: string } {
  const width = Math.max(32, Math.min(process.stdout.columns ?? 120, 160));
  const chromeWidth = stringWidth(`> *   ${ageLabel}`);
  const available = Math.max(12, width - chromeWidth);
  const nameWidth = Math.min(Math.max(10, Math.floor(available * 0.38)), 30);
  const outputWidth = Math.max(8, available - nameWidth);
  return {
    name: padEndToWidth(truncateToWidth(name, nameWidth), nameWidth),
    output: truncateToWidth(output, outputWidth),
    ageLabel,
  };
}

function padEndToWidth(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`;
}
