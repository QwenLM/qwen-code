/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render } from 'ink-testing-library';
import { act } from 'react';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import {
  AgentViewRoster,
  type AgentViewRosterProps,
  type AgentViewSessionPanel,
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

  afterEach(() => {
    cleanup();
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

  it('dispatches and attaches legacy VSCode Shift+Enter without a backslash', () => {
    const onDispatch = vi.fn(() => true);

    renderRoster({
      prompt: 'ship it',
      onDispatch,
    });

    press('\\\r', {});

    expect(onDispatch).toHaveBeenCalledWith(true, 'ship it');
  });

  it('attaches the selected session on empty Enter or right arrow', () => {
    const onAttachSession = vi.fn();

    renderRoster({
      prompt: '',
      onAttachSession,
    });

    press('', { return: true });
    press('', { rightArrow: true });

    expect(onAttachSession).toHaveBeenCalledTimes(2);
    expect(onAttachSession).toHaveBeenNthCalledWith(1, 'alpha');
    expect(onAttachSession).toHaveBeenNthCalledWith(2, 'alpha');
  });

  it('moves the cursor right instead of attaching while a prompt is typed', () => {
    const onAttachSession = vi.fn();
    const onPromptChange = vi.fn();

    renderRoster({
      prompt: 'ab',
      onAttachSession,
      onPromptChange,
    });

    press('', { leftArrow: true });
    press('', { rightArrow: true });
    press('c', {});

    expect(onAttachSession).not.toHaveBeenCalled();
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

  it('keeps a trailing line feed in the prompt without dispatching', () => {
    const onDispatch = vi.fn(() => true);
    const onPromptChange = vi.fn();

    renderRoster({ onDispatch, onPromptChange });

    press('abc\n', {});

    expect(onDispatch).not.toHaveBeenCalled();
    expect(onPromptChange).toHaveBeenLastCalledWith('abc\n');
  });

  it('drops terminal escape sequences but keeps focus-like user text', () => {
    const onPromptChange = vi.fn();

    renderRoster({ onPromptChange });

    press('\x1b[I', {});
    press('\x1b[?u', {});
    press('\x1b[10;20R', {});
    press('[?u', {});
    press('[10;20R', {});
    press('[27;2;13~', {});
    expect(onPromptChange).not.toHaveBeenCalled();

    press('[Info] check', {});
    expect(onPromptChange).toHaveBeenLastCalledWith('[Info] check');
  });

  it('does not append terminal responses to peek replies', () => {
    const onPeekPromptChange = vi.fn();

    renderRoster({
      peekPanel: sessionPanel(),
      peekInputMode: 'send',
      onPeekPromptChange,
    });

    press('[?u', {});

    expect(onPeekPromptChange).not.toHaveBeenCalled();
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
    const onPeekSession = vi.fn();

    renderRoster({
      prompt: '',
      onPeekSession,
    });

    press(' ', {});

    expect(onPeekSession).toHaveBeenCalledWith('alpha');
  });

  it('toggles pin, renames, and stops the selected session from shortcuts', () => {
    const onTogglePinSession = vi.fn();
    const onRenameSession = vi.fn();
    const onStopOrRemoveSession = vi.fn();

    renderRoster({
      prompt: 'Build Fix',
      onTogglePinSession,
      onRenameSession,
      onStopOrRemoveSession,
    });

    press('t', { ctrl: true });
    press('r', { ctrl: true });
    press('x', { ctrl: true });

    expect(onTogglePinSession).toHaveBeenCalledWith('alpha');
    expect(onRenameSession).toHaveBeenCalledWith('alpha', 'Build Fix');
    expect(onStopOrRemoveSession).toHaveBeenCalledWith('alpha');
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
    expect(onInterrupt).toHaveBeenCalledWith(false);
  });

  it('clears the live peek draft before processing more same-tick input', () => {
    const onPeekPromptChange = vi.fn();
    const onInterrupt = vi.fn();

    renderRoster({
      peekPrompt: 'a',
      peekPanel: sessionPanel(),
      peekInputMode: 'send',
      onPeekPromptChange,
      onInterrupt,
    });

    pressTogether([
      ['c', { ctrl: true }],
      ['b', {}],
    ]);

    expect(onInterrupt).toHaveBeenCalledWith(true);
    expect(onPeekPromptChange).toHaveBeenNthCalledWith(1, '');
    expect(onPeekPromptChange).toHaveBeenNthCalledWith(2, 'b');
  });

  it('clears live main input when typing and Ctrl+C arrive together', () => {
    const onPromptChange = vi.fn();
    const onInterrupt = vi.fn();

    renderRoster({ onPromptChange, onInterrupt });

    pressTogether([
      ['a', {}],
      ['c', { ctrl: true }],
    ]);

    expect(onPromptChange).toHaveBeenLastCalledWith('');
    expect(onInterrupt).toHaveBeenCalledWith(true);
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

  it('sanitizes directory group labels', () => {
    const { lastFrame } = renderRoster({
      groupMode: 'directory',
      rows: [
        row('alpha', {
          project: 'safe\nInjected\x1b]52;c;Y2xpcGJvYXJk\x07',
        }),
      ],
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('safe Injected');
    expect(output).not.toContain('52;c');
  });

  it('targets the moved row when Down and Enter arrive together', () => {
    const onAttachSession = vi.fn();

    renderRoster({
      rows: [row('alpha'), row('beta')],
      selectedIndex: 0,
      onAttachSession,
    });

    pressTogether([
      ['', { downArrow: true }],
      ['', { return: true }],
    ]);

    expect(onAttachSession).toHaveBeenCalledWith('beta');
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

  it('does not let repeated lagging prompt echoes overwrite newer text', async () => {
    const onPromptChange = vi.fn();
    const onDispatch = vi.fn(() => true);
    const props: AgentViewRosterProps = {
      rows: [row('alpha')],
      prompt: '',
      selectedIndex: 0,
      groupMode: 'state',
      onPromptChange,
      onPeekPromptChange: vi.fn(),
      onDispatch,
      onSubmitPeekPrompt: vi.fn(() => true),
      onAttachSession: vi.fn(),
      onPeekSession: vi.fn(),
      onTogglePinSession: vi.fn(),
      onRenameSession: vi.fn(),
      onStopOrRemoveSession: vi.fn(),
      onToggleGroupMode: vi.fn(),
      onShowHelp: vi.fn(),
      onInterrupt: vi.fn(),
      onMoveSelection: vi.fn(),
      onCancel: vi.fn(),
    };
    const element = (prompt: string) => (
      <KeypressProvider kittyProtocolEnabled={false}>
        <AgentViewRoster {...props} prompt={prompt} />
      </KeypressProvider>
    );
    const { rerender } = render(element(''));

    press('h', {});
    press('e', {});
    press('l', {});
    press('l', {});
    press('', { backspace: true });
    press('p', {});
    const echoes = onPromptChange.mock.calls.map(([value]) => value as string);
    expect(echoes).toEqual(['h', 'he', 'hel', 'hell', 'hel', 'help']);

    for (const echo of echoes) {
      act(() => rerender(element(echo)));
    }
    press('', { return: true });

    expect(onDispatch).toHaveBeenCalledWith(false, 'help');
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

  it('accepts the active slash suggestion on Enter', async () => {
    const onDispatch = vi.fn(() => true);
    const onPromptChange = vi.fn();
    renderRoster({
      prompt: '/qu',
      onDispatch,
      onPromptChange,
      slashCommands: slashCommands([{ name: 'quit' }]),
    });
    await settleCompletion();

    press('', { return: true });
    await settleCompletion();

    expect(onPromptChange).toHaveBeenLastCalledWith('/quit ');
    expect(onDispatch).not.toHaveBeenCalled();
  });

  it('edits the peek prompt separately from the main dispatch prompt', () => {
    const onPromptChange = vi.fn();
    const onPeekPromptChange = vi.fn();
    const onSubmitPeekPrompt = vi.fn(() => true);

    renderRoster({
      prompt: 'new task',
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
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

  it('does not resurrect a submitted peek reply in the same tick', () => {
    const onPeekPromptChange = vi.fn();
    const onSubmitPeekPrompt = vi.fn(() => true);

    renderRoster({
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
      onPeekPromptChange,
      onSubmitPeekPrompt,
    });

    press('x', {});
    press('', { return: true });
    press('y', {});

    expect(onSubmitPeekPrompt).toHaveBeenCalledWith('x');
    expect(onPeekPromptChange).toHaveBeenLastCalledWith('y');
  });

  it('submits a non-empty peek prompt on Enter', () => {
    const onSubmitPeekPrompt = vi.fn(() => true);

    renderRoster({
      peekPrompt: 'continue',
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
      onSubmitPeekPrompt,
    });

    press('', { return: true });

    expect(onSubmitPeekPrompt).toHaveBeenCalledOnce();
  });

  it('submits peek input when text and carriage return arrive together', () => {
    const onSubmitPeekPrompt = vi.fn(() => true);

    renderRoster({
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
      onSubmitPeekPrompt,
    });

    press('continue\r', {});

    expect(onSubmitPeekPrompt).toHaveBeenCalledWith('continue');
  });

  it('keeps multi-line peek pastes in the reply instead of submitting early', () => {
    const onPeekPromptChange = vi.fn();
    const onSubmitPeekPrompt = vi.fn(() => true);

    renderRoster({
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
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
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
      onPeekPromptChange,
    });

    press('', { backspace: true });

    expect(onPeekPromptChange).toHaveBeenCalledWith('looks good ');
  });

  it('closes an open session peek on Space', () => {
    const onCancel = vi.fn();

    renderRoster({
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
      onCancel,
    });

    press(' ', {});

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('keeps a same-tick peek reply when Space follows typed text', () => {
    const onCancel = vi.fn();
    const onPeekPromptChange = vi.fn();

    renderRoster({
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
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
      peekPanel: sessionPanel({
        lines: ['State: idle / alive', 'Summary: ready'],
      }),
      peekInputMode: 'send',
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
      peekPanel: sessionPanel({
        content: 'message',
        tone: 'error',
        lines: ['worker is not responding'],
      }),
      peekInputMode: 'send',
    });

    const output = lastFrame() ?? '';
    expect(output).toContain('worker is not responding');
    expect(output).not.toContain('stale result');
  });

  it('shows informational panel lines over empty row activity', () => {
    const { lastFrame } = renderRoster({
      rows: [row('alpha', { summary: undefined, lastResult: undefined })],
      peekPanel: sessionPanel({
        content: 'message',
        lines: ['Session added to Agent View.'],
      }),
    });

    expect(lastFrame()).toContain('Session added to Agent View.');
  });

  it('does not attach another row from a stale error panel', () => {
    const onAttachSession = vi.fn();
    const onTogglePinSession = vi.fn();
    const onRenameSession = vi.fn();
    const onStopOrRemoveSession = vi.fn();
    renderRoster({
      rows: [row('beta')],
      peekPanel: sessionPanel({
        content: 'message',
        tone: 'error',
        lines: ['worker is gone'],
      }),
      peekInputMode: 'send',
      onAttachSession,
      onTogglePinSession,
      onRenameSession,
      onStopOrRemoveSession,
    });

    press('', { return: true });
    press('', { rightArrow: true });
    press('t', { ctrl: true });
    press('r', { ctrl: true });
    press('x', { ctrl: true });

    expect(onAttachSession).not.toHaveBeenCalled();
    expect(onTogglePinSession).not.toHaveBeenCalled();
    expect(onRenameSession).not.toHaveBeenCalled();
    expect(onStopOrRemoveSession).not.toHaveBeenCalled();
  });

  it('keeps blocking answers visible while follow-up prompts are queued', () => {
    const { lastFrame } = renderRoster({
      rows: [
        row('alpha', {
          waitingFor: undefined,
          queuedPromptCount: 1,
          actions: {
            ...row('alpha').actions,
            needsBlockingAnswer: true,
          },
        }),
      ],
      peekPanel: sessionPanel(),
      peekPrompt: 'yes',
      peekInputMode: 'answer',
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
      peekPanel: sessionPanel(),
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
      peekPanel: sessionPanel({
        lines: ['Result: old model line', 'Summary: session summary'],
      }),
      peekInputMode: 'send',
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
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      peekInputMode: 'send',
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
    const onStopOrRemoveSession = vi.fn();
    const onAttachSession = vi.fn();

    renderRoster({
      rows: [row('beta'), row('alpha')],
      selectedIndex: 0,
      peekPanel: sessionPanel({ lines: ['Result: ready'] }),
      onStopOrRemoveSession,
      onAttachSession,
    });

    press('x', { ctrl: true });
    expect(onStopOrRemoveSession).toHaveBeenCalledWith('alpha');

    press('', { return: true });
    expect(onAttachSession).toHaveBeenCalledWith('alpha');
  });

  it('locks roster selection and rename shortcuts while a peek is open', () => {
    const onMoveSelection = vi.fn();
    const onRenameSession = vi.fn();
    const onTogglePinSession = vi.fn();

    renderRoster({
      rows: [row('beta'), row('alpha')],
      selectedIndex: 0,
      prompt: 'hidden name',
      peekPanel: sessionPanel(),
      peekInputMode: 'send',
      onMoveSelection,
      onRenameSession,
      onTogglePinSession,
    });

    press('', { upArrow: true });
    press('r', { ctrl: true });
    press('t', { ctrl: true });

    expect(onMoveSelection).not.toHaveBeenCalled();
    expect(onRenameSession).not.toHaveBeenCalled();
    expect(onTogglePinSession).not.toHaveBeenCalled();
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
        onSubmitPeekPrompt={vi.fn(() => true)}
        onAttachSession={vi.fn()}
        onPeekSession={vi.fn()}
        onTogglePinSession={vi.fn()}
        onRenameSession={vi.fn()}
        onStopOrRemoveSession={vi.fn()}
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

function sessionPanel(
  overrides: Partial<AgentViewSessionPanel> = {},
): AgentViewSessionPanel {
  return {
    kind: 'session',
    sessionId: 'alpha',
    content: 'activity',
    lines: [],
    ...overrides,
  };
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

function pressTogether(inputs: Array<[string, TestKey]>) {
  const handler = inputState.handlers.at(-1);
  if (!handler) {
    throw new Error('AgentViewRoster did not register an input handler');
  }
  act(() => {
    for (const [input, key] of inputs) {
      handler(input, key);
    }
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
