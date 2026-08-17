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
import type { AgentRosterGroupMode, AgentRosterRow } from './roster-model.js';
import { FOCUS_IN, FOCUS_OUT } from '../hooks/useFocus.js';

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
  selectedIndex: number;
  groupMode: AgentRosterGroupMode;
  header?: AgentViewHeaderInfo;
  notice?: AgentViewNotice;
  peekPanel?: AgentViewPeekPanel;
  peekPrompt?: string;
  peekInputMode?: 'answer' | 'send';
  peekInputTarget?: string;
  peekQueuedPrompts?: string[];
  slashCommands?: readonly SlashCommand[];
  onPromptChange: (prompt: string) => void;
  onPeekPromptChange: (prompt: string) => void;
  onDispatch: (attach: boolean, prompt: string) => void;
  onSubmitPeekPrompt: (promptOverride?: string) => void;
  onAttachSelected: () => void;
  onPeekSelected: () => void;
  onTogglePinSelected: () => void;
  onRenameSelected: (displayName: string) => void;
  onStopOrRemoveSelected: () => void;
  onToggleGroupMode: () => void;
  onShowHelp: () => void;
  onInterrupt: () => void;
  onMoveSelection: (delta: number) => void;
  onCancel: () => void;
}

export interface AgentViewPeekPanel {
  title: string;
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
  selectedIndex,
  groupMode,
  header,
  notice,
  peekPanel,
  peekPrompt = '',
  peekInputMode,
  peekInputTarget,
  peekQueuedPrompts,
  slashCommands = AGENT_VIEW_SLASH_COMMANDS,
  onPromptChange,
  onPeekPromptChange,
  onDispatch,
  onSubmitPeekPrompt,
  onAttachSelected,
  onPeekSelected,
  onTogglePinSelected,
  onRenameSelected,
  onStopOrRemoveSelected,
  onToggleGroupMode,
  onShowHelp,
  onInterrupt,
  onMoveSelection,
  onCancel,
}: AgentViewRosterProps) {
  const loadedSlashCommands = useAgentViewSlashCommands(slashCommands);
  const promptInput = useAgentViewPromptInput({
    prompt,
    slashCommands: loadedSlashCommands,
    onPromptChange,
  });
  const currentPrompt = promptInput.buffer.text;
  const hasPrompt = currentPrompt.trim().length > 0;
  const hasPeekPrompt = peekPrompt.trim().length > 0;
  const peekPromptPending = Boolean(peekQueuedPrompts?.length);
  const peekInputActive = Boolean(
    peekPanel && peekInputMode && !peekPromptPending,
  );
  const peekRow =
    rows.find((row) => row.sessionId === peekInputTarget) ??
    rows.find((row) => row.sessionId === peekPanel?.title);
  const sessionPeekActive = Boolean(
    peekPanel && peekRow && peekPanel.title === peekRow.sessionId,
  );

  useInput((input, key) => {
    // The roster uses ink's raw useInput, which bypasses KeypressContext's
    // FOCUS_EVENT_PATTERN filter, so focus in/out sequences must be dropped
    // here as well or they would be treated as stray keystrokes.
    if (isTerminalFocusInput(input)) {
      return;
    }

    if (key.escape) {
      if (promptInput.showSuggestions) {
        promptInput.dismissCompletion();
        return;
      }
      onCancel();
      return;
    }

    if (isCtrlInput(input, key, 't', '\x14') && rows.length > 0) {
      onTogglePinSelected();
      return;
    }

    if (isCtrlInput(input, key, 'r', '\x12') && rows.length > 0) {
      const displayName = currentPrompt.trim();
      promptInput.buffer.setText('');
      onPromptChange('');
      onRenameSelected(displayName);
      return;
    }

    if (isCtrlInput(input, key, 'x', '\x18') && rows.length > 0) {
      onStopOrRemoveSelected();
      return;
    }

    if (isCtrlInput(input, key, 's', '\x13')) {
      onToggleGroupMode();
      return;
    }

    if (isCtrlInput(input, key, 'c', '\x03')) {
      if (!peekInputActive && hasPrompt) {
        promptInput.buffer.setText('');
        onPromptChange('');
        onInterrupt();
        return;
      }
      onInterrupt();
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
      return;
    }

    if (key.upArrow) {
      onMoveSelection(-1);
      return;
    }

    if (key.downArrow) {
      onMoveSelection(1);
      return;
    }

    const returnPrefix = getReturnInputPrefix(input, key);
    const isReturn = returnPrefix !== undefined;

    if (sessionPeekActive && !peekInputActive) {
      if (isReturn && rows.length > 0) {
        onAttachSelected();
      } else if (input === ' ') {
        onCancel();
      }
      return;
    }

    if (isReturn) {
      if (peekInputActive) {
        const submittedPeekPrompt = `${peekPrompt}${returnPrefix}`;
        if (submittedPeekPrompt.trim()) {
          onSubmitPeekPrompt(submittedPeekPrompt);
        } else if (rows.length > 0) {
          onAttachSelected();
        }
      } else {
        const submittedPrompt = `${currentPrompt}${returnPrefix}`;
        if (submittedPrompt.trim()) {
          promptInput.buffer.setText('');
          onPromptChange('');
          onDispatch(Boolean(key.shift), submittedPrompt);
        } else if (rows.length > 0) {
          onAttachSelected();
        }
      }
      return;
    }

    if (key.rightArrow) {
      if (!hasPrompt && !peekInputActive && rows.length > 0) {
        onAttachSelected();
      }
      return;
    }

    if (input === ' ' && sessionPeekActive && !hasPeekPrompt && !hasPrompt) {
      onCancel();
      return;
    }

    if (input === ' ' && !hasPrompt && !sessionPeekActive && rows.length > 0) {
      onPeekSelected();
      return;
    }

    if (key.backspace || key.delete) {
      if (peekInputActive) {
        onPeekPromptChange(peekPrompt.slice(0, -1));
      } else {
        promptInput.handleBufferKey(input, key);
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (peekInputActive) {
        onPeekPromptChange(`${peekPrompt}${input}`);
      } else {
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
            <Box key={section.label} flexDirection="column">
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
          {sessionPeekActive && peekRow ? (
            <SessionPeekBox
              row={peekRow}
              panel={peekPanel}
              prompt={peekPrompt}
              inputMode={peekInputMode}
              queuedPrompts={peekQueuedPrompts}
            />
          ) : (
            <>
              <Text bold>{peekPanel.title}</Text>
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

function isTerminalFocusInput(input: string): boolean {
  const stripped = input.split('\x1b').join('');
  return (
    input.includes(FOCUS_IN) ||
    input.includes(FOCUS_OUT) ||
    stripped === '[I' ||
    stripped === '[O' ||
    stripped.includes('[I[O') ||
    stripped.includes('[O[I')
  );
}

function isReturnInput(input: string, key: RosterInputKey): boolean {
  return getReturnInputPrefix(input, key) !== undefined;
}

function getReturnInputPrefix(
  input: string,
  key: RosterInputKey,
): string | undefined {
  if (key.return) {
    return '';
  }
  const returnIndex = input.search(/[\r\n]/);
  return returnIndex >= 0 ? input.slice(0, returnIndex) : undefined;
}

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
        if (!disposed && loadedCommands.length > 0) {
          setCommands(loadedCommands);
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
  slashCommands,
  onPromptChange,
}: {
  prompt: string;
  slashCommands: readonly SlashCommand[];
  onPromptChange: (prompt: string) => void;
}): AgentViewPromptInput {
  const inputWidth = Math.max(20, Math.min(process.stdout.columns ?? 80, 160));
  const suggestionsWidth = Math.max(20, inputWidth - 4);
  const commandContext = useMemo(() => createAgentViewCommandContext(), []);
  const lastPromptRef = useRef(prompt);
  const lastSeenPromptPropRef = useRef(prompt);
  const emittedPromptsRef = useRef<Set<string>>(new Set());
  const onChange = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === lastPromptRef.current) {
        return;
      }
      lastPromptRef.current = nextPrompt;
      emittedPromptsRef.current.add(nextPrompt);
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
    if (prompt === lastSeenPromptPropRef.current) {
      return;
    }
    lastSeenPromptPropRef.current = prompt;
    if (prompt === lastPromptRef.current) {
      return;
    }
    if (emittedPromptsRef.current.delete(prompt)) {
      lastPromptRef.current = prompt;
      if (buffer.text === '' && prompt !== '') {
        buffer.setText(prompt);
      }
      return;
    }
    lastPromptRef.current = prompt;
    if (prompt !== buffer.text) {
      buffer.setText(prompt);
    }
  }, [buffer, prompt]);

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
      if (isReturnInput(_input, key)) {
        return false;
      }
      if (key.tab) {
        acceptActiveSuggestion();
        return true;
      }
      return false;
    },
    [acceptActiveSuggestion, completion],
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
    paste: false,
    sequence: input,
  };
}

function getInputKeyName(input: string, key: RosterInputKey): string {
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
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
    name: 'model',
    description: 'Switch the model for this session',
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  },
  {
    name: 'login',
    description: 'Connect an LLM provider',
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  },
  {
    name: 'logout',
    description: 'Clear provider credentials',
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  },
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
  panel: AgentViewPeekPanel;
  prompt: string;
  inputMode: 'answer' | 'send' | undefined;
  queuedPrompts: string[] | undefined;
}) {
  const lines = getPanelDisplayLines(row, panel, queuedPrompts);
  const inputActive = Boolean(inputMode && !queuedPrompts?.length);
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
        {getPeekFooter(inputMode, queuedPrompts)}
      </Text>
    </Box>
  );
}

function getPeekFooter(
  inputMode: 'answer' | 'send' | undefined,
  queuedPrompts: string[] | undefined,
): string {
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

function getPanelDisplayLines(
  row: AgentRosterRow,
  panel: AgentViewPeekPanel,
  queuedPrompts: readonly string[] | undefined,
): string[] {
  const parsed = parsePanelLines(panel.lines);
  const output =
    cleanRowText(row.lastResult) ??
    parsed.result ??
    parsed.summary ??
    parsed.other.at(-1);
  const queuedLine = getQueuedPromptLine(queuedPrompts);
  return [output, queuedLine ?? formatWaitingLine(row.waitingFor)].filter(
    (line): line is string => Boolean(line),
  );
}

function formatWaitingLine(waitingFor: string | undefined): string | undefined {
  if (!waitingFor || waitingFor === 'response') {
    return undefined;
  }
  return `Waiting: ${waitingFor}`;
}

function parsePanelLines(lines: readonly string[]): {
  result?: string;
  summary?: string;
  other: string[];
} {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<{
      result?: string;
      summary?: string;
      other: string[];
    }>(
      (parsed, line) => {
        if (/^State:\s*/i.test(line)) return parsed;
        if (/^Cwd:\s*/i.test(line)) return parsed;
        if (/^Worker:\s*/i.test(line)) return parsed;
        const result = line.match(/^Result:\s*(.+)$/i);
        if (result?.[1]) {
          parsed.result = result[1];
          return parsed;
        }
        const summary = line.match(/^Summary:\s*(.+)$/i);
        if (summary?.[1]) {
          parsed.summary = summary[1];
          return parsed;
        }
        if (/^Waiting for response/i.test(line)) return parsed;
        if (/^Waiting:\s*/i.test(line)) return parsed;
        const prompt = line.match(/^Prompt:\s*(.+)$/i);
        parsed.other.push(prompt?.[1] ? `> ${prompt[1]}` : line);
        return parsed;
      },
      { other: [] },
    );
}

function getQueuedPromptLine(
  queuedPrompts: readonly string[] | undefined,
): string | undefined {
  if (!queuedPrompts || queuedPrompts.length === 0) {
    return undefined;
  }
  const latest = queuedPrompts.at(-1)?.trim();
  if (!latest) {
    return undefined;
  }
  return `Waiting for response: ${latest}`;
}

function getRosterSections(
  rows: AgentRosterRow[],
  groupMode: AgentRosterGroupMode,
): Array<{
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
  return Array.from(sections, ([label, sectionRows]) => ({
    label,
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
  const text = value?.trim();
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

function truncateToWidth(value: string, width: number): string {
  if (stringWidth(value) <= width) return value;
  let result = '';
  for (const char of [...value]) {
    if (stringWidth(`${result}${char}...`) > width) {
      return `${result}...`;
    }
    result += char;
  }
  return result;
}

function padEndToWidth(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - stringWidth(value)))}`;
}
