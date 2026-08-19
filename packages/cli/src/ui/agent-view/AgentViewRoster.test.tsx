/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { act } from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  AgentViewRoster,
  type AgentViewRosterProps,
} from './AgentViewRoster.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import type { AgentRosterRow } from './roster-model.js';

interface TestKey {
  return?: boolean;
  shift?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  home?: boolean;
  end?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

type InputHandler = (input: string, key: TestKey) => void;

const inputState = vi.hoisted(() => ({
  handlers: [] as InputHandler[],
}));

vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useInput: (handler: InputHandler) => {
      inputState.handlers.push(handler);
    },
  };
});

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 140, rows: 24 }),
}));

describe('AgentViewRoster', () => {
  beforeEach(() => {
    inputState.handlers = [];
  });

  it('renders roster rows and the prompt', () => {
    const { lastFrame } = renderRoster({
      rows: [
        row('alpha', {
          displayName: 'Launchpad',
          pinned: true,
          summary: 'Waiting on approval',
          lastResult: 'Ready to continue',
        }),
        row('beta', {
          stateLabel: 'Working',
          project: 'core',
          ageLabel: '2m',
          aliveIndicator: 'hibernating',
          waitingFor: 'tests',
          lastResult: 'What would you like to test?',
        }),
      ],
      selectedIndex: 1,
      prompt: 'check status',
      groupMode: 'state',
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('* Launchpad');
    expect(output).toContain('Pinned');
    expect(output).toContain('Ready to continue');
    expect(output).toContain('enter to open');
    expect(output).toContain('space to reply');
    expect(output).toContain('ctrl+x to delete');
    expect(output).not.toContain('Waiting on approval');
    expect(output).toMatch(/> \* beta\s+What would you like to test\? 2m/);
    expect(output).toContain('check status');
  });

  it('renders the Qwen header with model and directory details', () => {
    const { lastFrame } = renderRoster({
      header: {
        version: '0.20.0',
        authLabel: 'API Key',
        providerLabel: 'IdealLab',
        model: 'qwen3.7-max',
        cwd: '/workspace/qwen-code',
      },
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('██╔═══██╗');
    expect(output).toContain('Qwen Code');
    expect(output).toContain('(v0.20.0)');
    expect(output).toContain('API Key | [IdealLab] qwen3.7-max');
    expect(output).toContain('/workspace/qwen-code');
    expect(output).toContain('Tips:');
  });

  it('dispatches prompt in the background on Enter', () => {
    const onDispatch = vi.fn(() => true);

    renderRoster({
      prompt: 'ship it',
      onDispatch,
    });

    press('', { return: true });

    expect(onDispatch).toHaveBeenCalledWith(false, 'ship it');
  });

  it('dispatches prompt when a PTY sends carriage return', () => {
    const onDispatch = vi.fn(() => true);

    renderRoster({
      prompt: 'ship it',
      onDispatch,
    });

    press('\r', {});

    expect(onDispatch).toHaveBeenCalledWith(false, 'ship it');
  });

  it('dispatches when a PTY sends text and carriage return together', () => {
    const onDispatch = vi.fn(() => true);

    renderRoster({
      onDispatch,
    });

    press('ship it\r', {});

    expect(onDispatch).toHaveBeenCalledWith(false, 'ship it');
  });

  it('attaches the selected session on empty Enter or right arrow', () => {
    const onAttachSelected = vi.fn();

    renderRoster({
      prompt: '',
      onAttachSelected,
    });

    press('', { return: true });
    press('', { rightArrow: true });

    expect(onAttachSelected).toHaveBeenCalledTimes(2);
  });

  it('moves the cursor right instead of attaching while a prompt is typed', () => {
    const onAttachSelected = vi.fn();
    const onPromptChange = vi.fn();

    renderRoster({
      prompt: 'ab',
      onAttachSelected,
      onPromptChange,
    });

    press('', { leftArrow: true });
    press('', { rightArrow: true });
    press('c', {});

    expect(onAttachSelected).not.toHaveBeenCalled();
    expect(onPromptChange).toHaveBeenLastCalledWith('abc');
  });

  it('supports Home and End in the roster prompt', () => {
    const onPromptChange = vi.fn();

    renderRoster({
      prompt: 'ab',
      onPromptChange,
    });

    press('', { home: true });
    press('X', {});

    expect(onPromptChange).toHaveBeenLastCalledWith('Xab');
  });

  it('inserts multi-line pastes instead of dropping the tail', () => {
    const onDispatch = vi.fn(() => true);
    const onPromptChange = vi.fn();

    renderRoster({
      onDispatch,
      onPromptChange,
    });

    press('fix the login bug\nalso update the tests', {});

    expect(onDispatch).not.toHaveBeenCalled();
    expect(onPromptChange).toHaveBeenLastCalledWith(
      'fix the login bug\nalso update the tests',
    );
  });

  it('drops real focus sequences but keeps focus-like user text', () => {
    const onPromptChange = vi.fn();

    renderRoster({ onPromptChange });

    press('\x1b[I', {});
    expect(onPromptChange).not.toHaveBeenCalled();

    press('[Info] check', {});
    expect(onPromptChange).toHaveBeenLastCalledWith('[Info] check');
  });

  it('moves selection and cancels from keyboard shortcuts', () => {
    const onMoveSelection = vi.fn();
    const onCancel = vi.fn();

    renderRoster({
      onMoveSelection,
      onCancel,
    });

    press('', { upArrow: true });
    press('', { downArrow: true });
    press('', { escape: true });

    expect(onMoveSelection).toHaveBeenNthCalledWith(1, -1);
    expect(onMoveSelection).toHaveBeenNthCalledWith(2, 1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('peeks the selected session on Space when prompt is empty', () => {
    const onPeekSelected = vi.fn();

    renderRoster({
      prompt: '',
      onPeekSelected,
    });

    press(' ', {});

    expect(onPeekSelected).toHaveBeenCalledOnce();
  });

  it('toggles pin, renames, and stops the selected session from shortcuts', () => {
    const onTogglePinSelected = vi.fn();
    const onRenameSelected = vi.fn();
    const onStopOrRemoveSelected = vi.fn();

    renderRoster({
      prompt: 'Build Fix',
      onTogglePinSelected,
      onRenameSelected,
      onStopOrRemoveSelected,
    });

    press('t', { ctrl: true });
    press('r', { ctrl: true });
    press('x', { ctrl: true });

    expect(onTogglePinSelected).toHaveBeenCalledOnce();
    expect(onRenameSelected).toHaveBeenCalledWith('Build Fix');
    expect(onStopOrRemoveSelected).toHaveBeenCalledOnce();
  });

  it('toggles grouping, shows help, and reports Ctrl+C', () => {
    const onToggleGroupMode = vi.fn();
    const onShowHelp = vi.fn();
    const onInterrupt = vi.fn();

    renderRoster({
      onToggleGroupMode,
      onShowHelp,
      onInterrupt,
    });

    press('s', { ctrl: true });
    press('?', {});
    press('c', { ctrl: true });

    expect(onToggleGroupMode).toHaveBeenCalledOnce();
    expect(onShowHelp).toHaveBeenCalledOnce();
    expect(onInterrupt).toHaveBeenCalledOnce();
  });

  it('can group rows by directory', () => {
    const { lastFrame } = renderRoster({
      groupMode: 'directory',
      rows: [
        row('alpha', { project: 'qwen-code' }),
        row('beta', { project: 'other' }),
      ],
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('qwen-code');
    expect(output).toContain('other');
  });

  it('reports prompt edits for printable input and backspace', async () => {
    const onPromptChange = vi.fn();

    renderRoster({
      prompt: 'ab',
      onPromptChange,
    });

    press('c', {});
    await settleCompletion();
    press('', { backspace: true });
    await settleCompletion();

    expect(onPromptChange).toHaveBeenNthCalledWith(1, 'abc');
    expect(onPromptChange).toHaveBeenNthCalledWith(2, 'ab');
  });

  it('routes arrow and tab keys to slash completion while suggestions are visible', async () => {
    const onMoveSelection = vi.fn();
    const onPromptChange = vi.fn();
    const { lastFrame } = renderRoster({
      prompt: '/mo',
      onMoveSelection,
      onPromptChange,
      slashCommands: slashCommands([{ name: 'model' }]),
    });
    await settleCompletion();

    const output = lastFrame() ?? '';
    expect(output).toContain('model');

    press('', { downArrow: true });
    press('', { tab: true });
    await settleCompletion();

    expect(onMoveSelection).not.toHaveBeenCalled();
    expect(onPromptChange).toHaveBeenLastCalledWith('/model ');
  });

  it('edits the peek prompt separately from the main dispatch prompt', () => {
    const onPromptChange = vi.fn();
    const onPeekPromptChange = vi.fn();
    const onSubmitPeekPrompt = vi.fn();

    renderRoster({
      prompt: 'new task',
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onPromptChange,
      onPeekPromptChange,
      onSubmitPeekPrompt,
    });

    press('x', {});
    press('', { return: true });

    expect(onPromptChange).not.toHaveBeenCalled();
    expect(onPeekPromptChange).toHaveBeenCalledWith('x');
    // The typed peek text accumulates imperatively, so Enter submits it even
    // before React re-renders with the new peekPrompt prop.
    expect(onSubmitPeekPrompt).toHaveBeenCalledWith('x');
  });

  it('submits a non-empty peek prompt on Enter', () => {
    const onSubmitPeekPrompt = vi.fn();

    renderRoster({
      peekPrompt: 'continue',
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onSubmitPeekPrompt,
    });

    press('', { return: true });

    expect(onSubmitPeekPrompt).toHaveBeenCalledOnce();
  });

  it('submits peek input when text and carriage return arrive together', () => {
    const onSubmitPeekPrompt = vi.fn();

    renderRoster({
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onSubmitPeekPrompt,
    });

    press('continue\r', {});

    expect(onSubmitPeekPrompt).toHaveBeenCalledWith('continue');
  });

  it('keeps multi-line peek pastes in the reply instead of submitting early', () => {
    const onPeekPromptChange = vi.fn();
    const onSubmitPeekPrompt = vi.fn();

    renderRoster({
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onPeekPromptChange,
      onSubmitPeekPrompt,
    });

    press('line one\nline two', {});

    expect(onSubmitPeekPrompt).not.toHaveBeenCalled();
    expect(onPeekPromptChange).toHaveBeenLastCalledWith('line one\nline two');
  });

  it('deletes a full emoji code point on peek backspace', () => {
    const onPeekPromptChange = vi.fn();

    renderRoster({
      peekPrompt: 'looks good 👍',
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onPeekPromptChange,
    });

    press('', { backspace: true });

    expect(onPeekPromptChange).toHaveBeenCalledWith('looks good ');
  });

  it('closes an open session peek on Space', () => {
    const onCancel = vi.fn();

    renderRoster({
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onCancel,
    });

    press(' ', {});

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps a same-tick peek reply when Space follows typed text', () => {
    const onCancel = vi.fn();
    const onPeekPromptChange = vi.fn();

    renderRoster({
      peekPanel: { title: 'alpha', lines: ['Result: ready'] },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onCancel,
      onPeekPromptChange,
    });

    press('y', {});
    press(' ', {});

    expect(onCancel).not.toHaveBeenCalled();
    expect(onPeekPromptChange).toHaveBeenLastCalledWith('y ');
  });

  it('renders peek panel details', () => {
    const { lastFrame } = renderRoster({
      rows: [row('alpha', { summary: 'ready' })],
      peekPanel: {
        title: 'alpha',
        lines: ['State: idle / alive', 'Summary: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('ready');
    expect(output).toContain('enter to send');
    expect(output).toContain('space to close');
    expect(output).not.toContain('Summary: ready');
    expect(output).not.toContain('State: idle / alive');
  });

  it('shows error panel lines over stale row output', () => {
    const { lastFrame } = renderRoster({
      rows: [row('alpha', { summary: 'stale result' })],
      peekPanel: {
        title: 'alpha',
        lines: ['worker is not responding'],
        error: true,
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('worker is not responding');
    expect(output).not.toContain('stale result');
  });

  it('keeps blocking answers visible while follow-up prompts are queued', () => {
    const { lastFrame } = renderRoster({
      rows: [row('alpha', { waitingFor: 'Edit', queuedPromptCount: 1 })],
      peekPanel: { title: 'alpha', lines: [] },
      peekPrompt: 'yes',
      peekInputMode: 'answer',
      peekInputTarget: 'alpha',
      peekQueuedPrompts: ['continue'],
    });

    expect(lastFrame()).toContain('> yes');
    expect(lastFrame()).toContain('enter to send');
  });

  it('renders worker text as sanitized single lines', () => {
    const { lastFrame } = renderRoster({
      rows: [
        row('alpha', {
          displayName: 'first\nsecond',
          waitingFor: '\u001b]0;spoof\u0007Edit\nfile',
        }),
      ],
      peekPanel: { title: 'alpha', lines: [] },
      peekInputTarget: 'alpha',
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('first second');
    expect(output).toContain('Waiting: Edit file');
    expect(output).not.toContain('spoof');
  });

  it('renders notices without hiding the dispatch input', () => {
    const { lastFrame } = renderRoster({
      notice: {
        lines: ['Press Ctrl+X again to remove.'],
      },
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('Press Ctrl+X again to remove.');
    expect(output).toContain('describe a task for a new session');
  });

  it('prefers the latest row output over peek summary details', () => {
    const { lastFrame } = renderRoster({
      rows: [
        row('alpha', {
          lastResult: 'latest model line',
          summary: 'session summary',
        }),
      ],
      peekPanel: {
        title: 'alpha',
        lines: ['Result: old model line', 'Summary: session summary'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('latest model line');
    expect(output).not.toContain('old model line');
    expect(output).not.toContain('session summary');
  });

  it('keeps the session peek open when selection moves after refresh', () => {
    const { lastFrame } = renderRoster({
      rows: [
        row('new-selection', { summary: 'new row' }),
        row('alpha', { summary: 'peeked row' }),
      ],
      selectedIndex: 0,
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('peeked row');
    expect(output).toContain('reply');
    expect(output).not.toContain('send follow-up to alpha');
  });

  it('inserts pasted text that reads like a control key instead of executing it', () => {
    const onPromptChange = vi.fn();

    renderRoster({
      prompt: 'abc',
      onPromptChange,
    });

    // A multi-codepoint chunk is a paste; the literal word "delete" must
    // land in the buffer instead of deleting a character.
    press('delete', {});

    expect(onPromptChange).toHaveBeenLastCalledWith('abcdelete');
  });

  it('locks Ctrl+X and Enter to the peeked session while a peek is open', () => {
    const onStopOrRemoveSelected = vi.fn();
    const onAttachSelected = vi.fn();

    renderRoster({
      rows: [row('beta'), row('alpha')],
      selectedIndex: 0,
      peekPanel: {
        title: 'alpha',
        lines: ['Result: ready'],
      },
      onStopOrRemoveSelected,
      onAttachSelected,
    });

    press('x', { ctrl: true });
    expect(onStopOrRemoveSelected).toHaveBeenCalledWith('alpha');

    press('', { return: true });
    expect(onAttachSelected).toHaveBeenCalledWith('alpha');
  });

  it('locks roster selection and rename shortcuts while a peek is open', () => {
    const onMoveSelection = vi.fn();
    const onRenameSelected = vi.fn();
    const onTogglePinSelected = vi.fn();

    renderRoster({
      rows: [row('beta'), row('alpha')],
      selectedIndex: 0,
      prompt: 'hidden name',
      peekPanel: { title: 'alpha', lines: [] },
      peekInputMode: 'send',
      peekInputTarget: 'alpha',
      onMoveSelection,
      onRenameSelected,
      onTogglePinSelected,
    });

    press('', { upArrow: true });
    press('r', { ctrl: true });
    press('t', { ctrl: true });

    expect(onMoveSelection).not.toHaveBeenCalled();
    expect(onRenameSelected).not.toHaveBeenCalled();
    expect(onTogglePinSelected).not.toHaveBeenCalled();
  });
});

function renderRoster(overrides: Partial<AgentViewRosterProps> = {}) {
  return render(
    <KeypressProvider kittyProtocolEnabled={false}>
      <AgentViewRoster
        rows={[row('alpha')]}
        prompt=""
        selectedIndex={0}
        groupMode="state"
        onPromptChange={vi.fn()}
        onPeekPromptChange={vi.fn()}
        onDispatch={vi.fn(() => true)}
        onSubmitPeekPrompt={vi.fn()}
        onAttachSelected={vi.fn()}
        onPeekSelected={vi.fn()}
        onTogglePinSelected={vi.fn()}
        onRenameSelected={vi.fn()}
        onStopOrRemoveSelected={vi.fn()}
        onToggleGroupMode={vi.fn()}
        onShowHelp={vi.fn()}
        onInterrupt={vi.fn()}
        onMoveSelection={vi.fn()}
        onCancel={vi.fn()}
        {...overrides}
      />
    </KeypressProvider>,
  );
}

function press(input: string, key: TestKey) {
  const handler = inputState.handlers.at(-1);
  if (!handler) {
    throw new Error('AgentViewRoster did not register an input handler');
  }
  act(() => {
    handler(input, key);
  });
}

async function settleCompletion() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function row(
  sessionId: string,
  overrides: Partial<AgentRosterRow> = {},
): AgentRosterRow {
  return {
    sessionId,
    displayName: sessionId,
    state: 'needs_input',
    stateLabel: 'Needs Input',
    stateGroup: 'needs_input',
    taskState: 'waiting',
    inputState: 'permission',
    runtimeState: 'alive',
    recoverability: 'live',
    iconShape: 'alive',
    iconTone: 'needs_input',
    title: sessionId,
    subtitle: '',
    actions: {
      canAttach: true,
      canPeek: true,
      canReply: false,
      canStop: false,
      canRemove: true,
      canRespawn: false,
      canHibernate: false,
      needsBlockingAnswer: true,
    },
    project: 'qwen-code',
    projectCwd: '/workspace/qwen-code',
    activeCwd: '/workspace/qwen-code',
    cwd: '/workspace/qwen-code',
    ageMs: 60_000,
    ageLabel: '1m',
    updatedAt: '2026-07-17T10:00:00.000Z',
    alive: true,
    aliveIndicator: 'alive',
    ...overrides,
  };
}

function slashCommands(
  commands: Array<{ name: string; description?: string }>,
): SlashCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? command.name,
    kind: CommandKind.BUILT_IN,
    action: () => undefined,
  }));
}
