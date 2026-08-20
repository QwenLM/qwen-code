/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render as inkRender } from 'ink-testing-library';
import type { ComponentProps, ReactElement } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentViewApp } from './AgentViewApp.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import type { AgentRosterRow } from './roster-model.js';

vi.mock('../../services/BuiltinCommandLoader.js', () => ({
  BuiltinCommandLoader: class {
    loadCommands() {
      return Promise.resolve([
        {
          name: 'model',
          description: 'Switch the model for this session',
          kind: 'built-in',
          action: () => undefined,
        },
        {
          name: 'login',
          description: 'Connect an LLM provider',
          kind: 'built-in',
          action: () => undefined,
        },
        {
          name: 'logout',
          description: 'Clear provider credentials',
          kind: 'built-in',
          action: () => undefined,
        },
      ]);
    }
  },
}));

describe('AgentViewApp', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('dispatches the current prompt as a background session', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const loadRows = vi.fn(async () => [row('new-session')]);
    const onExit = vi.fn();
    const onAttachRequested = vi.fn();
    const { stdin } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'working',
            stateGroup: 'working',
            taskState: 'running',
            iconTone: 'working',
            actions: {
              ...row('session-1').actions,
              canReply: false,
              canStop: true,
            },
          }),
        ]}
        actions={{
          dispatchPrompt,
          peekSelected: vi.fn(),
          sendToSession: vi.fn(),
          answerSession: vi.fn(),
          pinSession: vi.fn(),
          renameSession: vi.fn(),
          stopSession: vi.fn(),
          removeSession: vi.fn(),
          loadRows,
        }}
        onExit={onExit}
        onAttachRequested={onAttachRequested}
      />,
    );

    for (const char of 'ship it') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();
    await flushInk();

    expect(dispatchPrompt).toHaveBeenCalledWith('ship it', false);
    expect(loadRows).toHaveBeenCalled();
    expect(onAttachRequested).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
  }, 20_000);

  it('requests attach for the selected row on empty Enter', async () => {
    const onAttachRequested = vi.fn();
    const onExit = vi.fn();
    const { stdin } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions()}
        onExit={onExit}
        onAttachRequested={onAttachRequested}
      />,
    );

    stdin.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(onAttachRequested).toHaveBeenCalledWith('session-1');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('keeps the prompt and shows dispatch errors', async () => {
    const dispatchPrompt = vi.fn(async () => {
      throw new Error('Timed out waiting for Agent View supervisor response');
    });
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt })}
        onExit={vi.fn()}
      />,
    );

    for (const char of 'ship it') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await settleInput();

    expect(dispatchPrompt).toHaveBeenCalledWith('ship it', false);
    await waitForFrame(lastFrame, 'Timed out');
    // The failure itself must be visible, not just the restored prompt.
    expect(lastFrame()).toContain('Timed out waiting for Agent View');
    // The prompt must actually survive the failed dispatch.
    expect(lastFrame()).toContain('> ship it');
  });

  it('does not overwrite newer input when an earlier dispatch fails', async () => {
    let rejectDispatch: ((error: Error) => void) | undefined;
    const dispatchPrompt = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectDispatch = reject;
        }),
    );
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt })}
        onExit={vi.fn()}
      />,
    );

    for (const char of 'first') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await settleInput();
    for (const char of 'newer') {
      stdin.write(char);
      await Promise.resolve();
    }

    await act(async () => {
      rejectDispatch?.(new Error('dispatch failed'));
      await flushInk();
    });

    expect(lastFrame()).toContain('> newer');
    expect(lastFrame()).not.toContain('> first');
  });

  it('keeps a rowless initial error panel visible', () => {
    const { lastFrame } = render(
      <AgentViewApp
        rows={[]}
        actions={actions()}
        initialPeekPanel={{
          title: 'missing-session',
          lines: ['adopt failed'],
          error: true,
        }}
        onExit={vi.fn()}
      />,
    );

    expect(lastFrame()).toContain('adopt failed');
  });

  it('keeps a successful dispatch when the row refresh fails', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const loadRows = vi.fn(async () => {
      throw new Error('daemon unavailable');
    });
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt, loadRows })}
        onExit={vi.fn()}
      />,
    );

    for (const char of 'ship it') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await waitForFrame(lastFrame, 'Dispatched.');

    // waitForFrame returns silently on timeout, so pin the wait explicitly.
    expect(lastFrame()).toContain('Dispatched.');
    // The prompt must stay cleared; restoring it would let a re-Enter
    // duplicate the dispatched session.
    expect(lastFrame()).not.toContain('> ship it');

    // The refresh failure must not mask the successful dispatch: no error
    // notice and no restored prompt (a re-Enter would duplicate the session).
    expect(dispatchPrompt).toHaveBeenCalledTimes(1);
    expect(dispatchPrompt).toHaveBeenCalledWith('ship it', false);
    expect(loadRows).toHaveBeenCalled();
    expect(lastFrame()).not.toContain('daemon unavailable');
  });

  it('shows peek details for the selected row on Space', async () => {
    const peekSelected = vi.fn(async () => ({
      title: 'session-1',
      lines: ['State: idle / alive', 'Summary: done'],
    }));
    const { stdin } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={{
          dispatchPrompt: vi.fn(),
          peekSelected,
          sendToSession: vi.fn(),
          answerSession: vi.fn(),
          pinSession: vi.fn(),
          renameSession: vi.fn(),
          stopSession: vi.fn(),
          removeSession: vi.fn(),
          loadRows: vi.fn(),
        }}
        onExit={vi.fn()}
      />,
    );

    stdin.write(' ');
    await settleInput();

    expect(peekSelected).toHaveBeenCalledWith('session-1');
  });

  it('answers a needs-input session from an open peek without exiting', async () => {
    const answerSession = vi.fn(async () => ({ answered: true }));
    const onExit = vi.fn();
    const { stdin } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'needs_input',
            stateGroup: 'needs_input',
            taskState: 'waiting',
            inputState: 'permission',
            waitingFor: 'Edit',
            actions: {
              ...row('session-1').actions,
              // Production shape: deriveActions makes canReply and
              // needsBlockingAnswer mutually exclusive; the answer path must
              // still be reachable.
              canReply: false,
              needsBlockingAnswer: true,
            },
          }),
        ]}
        actions={actions({
          answerSession,
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['Waiting: approval'],
          }),
        })}
        onExit={onExit}
      />,
    );

    stdin.write(' ');
    await settleInput();
    for (const char of 'yes') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await settleInput();

    expect(answerSession).toHaveBeenCalledWith('session-1', 'yes');
    expect(onExit).not.toHaveBeenCalled();
  });

  it('does not resurrect a closed peek when the reply send fails', async () => {
    let rejectSend: ((error: Error) => void) | undefined;
    const sendToSession = vi.fn(
      () =>
        new Promise<{ sent: boolean }>((_, reject) => {
          rejectSend = reject;
        }),
    );
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({
          sendToSession,
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['Result: ready'],
          }),
        })}
        onExit={vi.fn()}
      />,
    );

    stdin.write(' ');
    await settleInput();
    for (const char of 'hello') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await settleInput();
    expect(sendToSession).toHaveBeenCalledWith('session-1', 'hello');

    // Close the peek while the send is still in flight (Space cancels once
    // the reply input is inactive; ESC is buffered by the readline layer).
    stdin.write(' ');
    await settleInput();
    expect(lastFrame()).not.toContain('space to close');

    await act(async () => {
      rejectSend?.(new Error('worker is gone'));
      await flushInk();
    });

    // The failure must not resurrect the panel the user explicitly closed,
    // but it still needs to be visible outside the hidden peek input.
    expect(lastFrame()).not.toContain('space to close');
    expect(lastFrame()).toContain('Reply was not sent: worker is gone');
  });

  it('does not target another session from a stale error peek', async () => {
    let notify: (() => void) | undefined;
    const sendToSession = vi.fn(async () => {
      throw new Error('worker is gone');
    });
    const dispatchPrompt = vi.fn();
    const onAttachRequested = vi.fn();
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1'), row('session-2')]}
        actions={actions({
          dispatchPrompt,
          sendToSession,
          loadRows: vi.fn(async () => [row('session-2')]),
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['Result: ready'],
          }),
          subscribeToChanges: (onChange) => {
            notify = onChange;
            return { dispose: vi.fn() };
          },
        })}
        onExit={vi.fn()}
        onAttachRequested={onAttachRequested}
      />,
    );

    stdin.write(' ');
    await settleInput();
    for (const char of 'hello') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await vi.waitFor(() => expect(sendToSession).toHaveBeenCalledOnce());
    await waitForFrame(lastFrame, 'worker is gone');
    expect(lastFrame()).toContain('worker is gone');

    await act(async () => {
      notify?.();
    });
    await flushInk();
    for (const char of 'retry') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();

    expect(sendToSession).toHaveBeenCalledOnce();
    expect(dispatchPrompt).not.toHaveBeenCalled();
    expect(onAttachRequested).not.toHaveBeenCalled();
  });

  it('sends soft needs-input replies as follow-ups', async () => {
    const sendToSession = vi.fn(async () => ({ sent: true }));
    const answerSession = vi.fn(async () => ({ answered: true }));
    const { stdin } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'needs_input',
            stateGroup: 'needs_input',
            taskState: 'waiting',
            inputState: 'soft_question',
            waitingFor: 'response',
            inputKind: 'soft',
            actions: {
              ...row('session-1').actions,
              canReply: true,
              needsBlockingAnswer: false,
            },
          }),
        ]}
        actions={actions({
          sendToSession,
          answerSession,
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['Result: What next?'],
          }),
        })}
        onExit={vi.fn()}
      />,
    );

    stdin.write(' ');
    await settleInput();
    for (const char of 'next') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await settleInput();

    expect(sendToSession).toHaveBeenCalledWith('session-1', 'next');
    expect(answerSession).not.toHaveBeenCalled();
  });

  it('sends a follow-up to a completed session from an open peek', async () => {
    const sendToSession = vi.fn(async () => ({ sent: true }));
    const loadRows = vi.fn(async () => [
      row('session-1', {
        state: 'completed',
        stateLabel: 'Completed',
        queuedPromptCount: 1,
        queuedPromptPreview: 'continue',
      }),
    ]);
    const { stdin } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'completed',
            stateLabel: 'Completed',
          }),
        ]}
        actions={actions({
          sendToSession,
          loadRows,
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['Result: done'],
          }),
        })}
        onExit={vi.fn()}
      />,
    );

    stdin.write(' ');
    await flushInk();
    for (const char of 'continue') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await settleInput();

    expect(sendToSession).toHaveBeenCalledWith('session-1', 'continue');
  }, 10_000);

  it('keeps a second peek reply while the first is in flight', async () => {
    const answerSession = vi.fn(() => new Promise(() => {}));
    const onAttachRequested = vi.fn();
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'needs_input',
            stateGroup: 'needs_input',
            taskState: 'waiting',
            inputState: 'permission',
            waitingFor: 'Edit',
            actions: {
              ...row('session-1').actions,
              canReply: false,
              needsBlockingAnswer: true,
            },
          }),
        ]}
        actions={actions({
          answerSession,
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['Waiting: Edit'],
          }),
        })}
        onExit={vi.fn()}
        onAttachRequested={onAttachRequested}
      />,
    );

    stdin.write(' ');
    await flushInk();
    for (const char of 'yes') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await vi.waitFor(() => expect(answerSession).toHaveBeenCalledOnce());
    await waitForFrame(lastFrame, '> reply');
    expect(lastFrame()).toContain('> reply');
    for (const char of 'no wait') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();

    expect(answerSession).toHaveBeenCalledOnce();
    expect(answerSession).toHaveBeenCalledWith('session-1', 'yes');
    expect(lastFrame()).toContain('no wait');
    expect(lastFrame()).toContain('Reply is still being sent.');

    stdin.write('\r');
    await flushInk();

    expect(answerSession).toHaveBeenCalledOnce();
    expect(onAttachRequested).not.toHaveBeenCalled();
  }, 10_000);

  it('shows the persisted pending prompt when reopening a peek', async () => {
    const sendToSession = vi.fn();
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'working',
            stateLabel: 'Working',
            stateGroup: 'working',
            queuedPromptCount: 1,
            queuedPromptPreview: 'continue',
          }),
        ]}
        actions={actions({
          sendToSession,
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['Result: done'],
          }),
        })}
        onExit={vi.fn()}
      />,
    );

    stdin.write(' ');
    await flushInk();

    expect(lastFrame()).toContain('Waiting for response: continue');
    expect(lastFrame()).not.toContain('> reply');
    for (const char of 'again') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();
    expect(sendToSession).not.toHaveBeenCalled();
    expect(lastFrame()).not.toContain('again');
  }, 10_000);

  it('refreshes an open peek when a pending reply completes', async () => {
    const sendToSession = vi.fn();
    const actionsForTest = actions({
      sendToSession,
      peekSelected: async () => ({
        title: 'session-1',
        lines: ['Result: old output'],
      }),
    });
    const { stdin, lastFrame, rerender } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'working',
            stateLabel: 'Working',
            stateGroup: 'working',
            lastResult: 'first line',
            queuedPromptCount: 1,
            queuedPromptPreview: 'continue',
          }),
        ]}
        actions={actionsForTest}
        onExit={vi.fn()}
      />,
    );

    stdin.write(' ');
    await flushInk();
    expect(lastFrame()).toContain('Waiting for response: continue');

    rerender(
      <KeypressProvider kittyProtocolEnabled={false}>
        <AgentViewApp
          rows={[
            row('session-1', {
              state: 'needs_input',
              stateLabel: 'Needs Input',
              stateGroup: 'needs_input',
              waitingFor: 'response',
              lastResult: 'final question?',
            }),
          ]}
          actions={actionsForTest}
          onExit={vi.fn()}
        />
      </KeypressProvider>,
    );
    await flushInk();
    expect(sendToSession).not.toHaveBeenCalled();
    // The open peek must reflect the refreshed row, not stale panel data.
    await waitForFrame(lastFrame, 'final question?');
    expect(lastFrame()).toContain('final question?');
  }, 10_000);

  it('does not send a follow-up to a working session from an open peek', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const sendToSession = vi.fn(async () => ({ sent: true }));
    const onAttachRequested = vi.fn();
    const { stdin } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'working',
            stateLabel: 'Working',
            stateGroup: 'working',
            actions: {
              ...row('session-1').actions,
              canReply: false,
            },
          }),
        ]}
        actions={actions({
          dispatchPrompt,
          sendToSession,
          peekSelected: async () => ({
            title: 'session-1',
            lines: ['State: working / alive'],
          }),
        })}
        onExit={vi.fn()}
        onAttachRequested={onAttachRequested}
      />,
    );

    stdin.write(' ');
    await flushInk();
    for (const char of 'continue') {
      stdin.write(char);
      await Promise.resolve();
    }
    await flushInk();

    expect(sendToSession).not.toHaveBeenCalled();
    expect(dispatchPrompt).not.toHaveBeenCalled();
    expect(onAttachRequested).not.toHaveBeenCalled();

    // Enter must not deliver the peek reply either: the session cannot
    // accept replies while working (canReply: false), so it attaches
    // instead of sending.
    stdin.write('\r');
    await settleInput();
    expect(sendToSession).not.toHaveBeenCalled();
    expect(dispatchPrompt).not.toHaveBeenCalled();
    expect(onAttachRequested).toHaveBeenCalledWith('session-1');
  }, 10_000);

  it('pins the selected row with Ctrl+T', async () => {
    const pinSession = vi.fn(async () => ({ pinned: true }));
    const { stdin } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'working',
            stateGroup: 'working',
            taskState: 'running',
            iconTone: 'working',
            actions: {
              ...row('session-1').actions,
              canReply: false,
              canStop: true,
            },
          }),
        ]}
        actions={actions({ pinSession })}
        onExit={vi.fn()}
      />,
    );

    stdin.write('\x14');
    await settleInput();

    expect(pinSession).toHaveBeenCalledWith('session-1');
  });

  it('renames the selected row with Ctrl+R using the prompt', async () => {
    const renameSession = vi.fn(async () => ({ displayName: 'Build Fix' }));
    const { stdin } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ renameSession })}
        onExit={vi.fn()}
      />,
    );

    for (const char of 'Build Fix') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\x12');
    await settleInput();

    expect(renameSession).toHaveBeenCalledWith('session-1', 'Build Fix');
  });

  it('stops and then removes the selected row with Ctrl+X', async () => {
    const stopSession = vi.fn(async () => ({ stopped: true }));
    const removeSession = vi.fn(async () => ({ removed: true }));
    const { stdin } = render(
      <AgentViewApp
        rows={[
          row('session-1', {
            state: 'working',
            stateGroup: 'working',
            taskState: 'running',
            iconTone: 'working',
            actions: {
              ...row('session-1').actions,
              canReply: false,
              canStop: true,
            },
          }),
        ]}
        actions={actions({ stopSession, removeSession })}
        onExit={vi.fn()}
      />,
    );

    stdin.write('\x18');
    await flushInk();
    stdin.write('\x18');
    await settleInput();

    expect(stopSession).toHaveBeenCalledWith('session-1');
    expect(removeSession).toHaveBeenCalledWith('session-1');
  });

  it('stops a non-running session before allowing remove', async () => {
    const stopSession = vi.fn(async () => ({ stopped: true }));
    const removeSession = vi.fn(async () => ({ removed: true }));
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ stopSession, removeSession })}
        onExit={vi.fn()}
      />,
    );

    stdin.write('\x18');
    await flushInk();

    expect(stopSession).toHaveBeenCalledWith('session-1');
    expect(removeSession).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Stopped. Press Ctrl+X again to remove.');

    stdin.write('\x18');
    await settleInput();

    expect(removeSession).toHaveBeenCalledWith('session-1');
  });

  it('preserves another session remove window when an earlier stop fails', async () => {
    let rejectFirstStop: (error: Error) => void = () => {};
    const rows = [row('session-a'), row('session-b')];
    const stopSession = vi.fn((sessionId: string) =>
      sessionId === 'session-a'
        ? new Promise<never>((_resolve, reject) => {
            rejectFirstStop = reject;
          })
        : Promise.resolve({ stopped: true }),
    );
    const removeSession = vi.fn(async () => ({ removed: true }));
    const { stdin } = render(
      <AgentViewApp
        rows={rows}
        actions={actions({
          stopSession,
          removeSession,
          loadRows: vi.fn(async () => rows),
        })}
        onExit={vi.fn()}
      />,
    );

    stdin.write('\x18');
    await settleInput();
    stdin.write('\u001b[B');
    await flushInk();
    stdin.write('\x18');
    await flushInk();

    rejectFirstStop(new Error('session-a stop failed'));
    await flushInk();
    stdin.write('\x18');
    await flushInk();

    expect(stopSession).toHaveBeenCalledWith('session-a');
    expect(stopSession).toHaveBeenCalledWith('session-b');
    expect(removeSession).toHaveBeenCalledWith('session-b');
  });

  it('expires the Ctrl+X remove confirmation window', async () => {
    vi.useFakeTimers();
    const stopSession = vi.fn(async () => ({ stopped: true }));
    const removeSession = vi.fn(async () => ({ removed: true }));
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ stopSession, removeSession })}
        onExit={vi.fn()}
      />,
    );

    stdin.write('\x18');
    await flushInk();
    expect(stopSession).toHaveBeenCalledOnce();
    expect(lastFrame()).toContain('Stopped. Press Ctrl+X again to remove.');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    await settleInput();
    expect(lastFrame()).not.toContain('Press Ctrl+X again to remove.');

    stdin.write('\x18');
    await flushInk();

    expect(removeSession).not.toHaveBeenCalled();
    expect(stopSession).toHaveBeenCalledTimes(2);
    expect(lastFrame()).toContain('Stopped. Press Ctrl+X again to remove.');
  });

  it('keeps dispatch input active after the Ctrl+X remove hint', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const removeSession = vi.fn(async () => ({ removed: true }));
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt, removeSession })}
        onExit={vi.fn()}
      />,
    );

    stdin.write('\x18');
    await flushInk();
    expect(lastFrame()).toContain('Stopped. Press Ctrl+X again to remove.');

    for (const char of 'new task') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();

    expect(removeSession).not.toHaveBeenCalled();
    expect(dispatchPrompt).toHaveBeenCalledWith('new task', false);
  });

  it('keeps dispatch input active after removing a session', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const removeSession = vi.fn(async () => ({ removed: true }));
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt, removeSession })}
        onExit={vi.fn()}
      />,
    );

    stdin.write('\x18');
    await settleInput();
    stdin.write('\x18');
    await settleInput();
    await flushInk();
    expect(removeSession).toHaveBeenCalledWith('session-1');

    for (const char of 'next task') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();

    expect(dispatchPrompt).toHaveBeenCalledWith('next task', false);
    expect(lastFrame()).toContain('describe a task for a new session');
  });

  it('uses s: prompts as filters instead of dispatch prompts', async () => {
    const dispatchPrompt = vi.fn();
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[
          row('idle-session', { state: 'idle', stateLabel: 'Idle' }),
          row('working-session', {
            state: 'working',
            stateLabel: 'Working',
            stateGroup: 'working',
          }),
        ]}
        actions={actions({ dispatchPrompt })}
        onExit={vi.fn()}
      />,
    );

    for (const char of 's:idle') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();

    expect(dispatchPrompt).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Showing 1 matching session(s).');
  });

  it('keeps rows visible while typing a new-session prompt', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[
          row('launch-session', { displayName: 'Launchpad' }),
          row('other'),
        ]}
        actions={actions({ dispatchPrompt })}
        onExit={vi.fn()}
      />,
    );

    for (const char of 'launch') {
      stdin.write(char);
      await Promise.resolve();
    }
    await flushInk();
    // Rows must stay rendered while the prompt is being typed.
    expect(lastFrame()).toContain('Launchpad');

    stdin.write('\r');
    await settleInput();

    expect(dispatchPrompt).toHaveBeenCalledWith('launch', false);
  });

  it('shows shortcut help', async () => {
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions()}
        onExit={vi.fn()}
      />,
    );

    stdin.write('?');
    await flushInk();

    expect(lastFrame()).toContain('Shortcuts');
    expect(lastFrame()).toContain('Ctrl+S: toggle grouping');
  });

  it('dispatches slash commands as new-session input', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const onAttachRequested = vi.fn();
    const { stdin } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt })}
        onExit={vi.fn()}
        onAttachRequested={onAttachRequested}
      />,
    );

    for (const char of '/model') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();

    expect(dispatchPrompt).toHaveBeenCalledWith('/model', false);
    expect(onAttachRequested).not.toHaveBeenCalled();
  });

  it.each(['/quit', '/exit', '/quit now', '/exit now'] as const)(
    'handles %s locally by exiting the roster',
    async (input) => {
      const dispatchPrompt = vi.fn();
      const onExit = vi.fn();
      const { stdin } = render(
        <AgentViewApp
          rows={[row('session-1')]}
          actions={actions({ dispatchPrompt })}
          onExit={onExit}
        />,
      );

      for (const char of input) {
        stdin.write(char);
        await Promise.resolve();
      }
      stdin.write('\r');
      await flushInk();

      expect(dispatchPrompt).not.toHaveBeenCalled();
      expect(onExit).toHaveBeenCalledOnce();
    },
  );

  it.each(['/resume named-session', '/continue named-session'] as const)(
    'handles %s locally instead of dispatching it',
    async (input) => {
      const dispatchPrompt = vi.fn();
      const onResumeRequested = vi.fn();
      const { stdin } = render(
        <AgentViewApp
          rows={[row('session-1')]}
          actions={actions({ dispatchPrompt })}
          onExit={vi.fn()}
          onResumeRequested={onResumeRequested}
        />,
      );

      for (const char of input) {
        stdin.write(char);
        await Promise.resolve();
      }
      stdin.write('\r');
      await flushInk();

      expect(dispatchPrompt).not.toHaveBeenCalled();
      expect(onResumeRequested).toHaveBeenCalledOnce();
    },
  );

  it('keeps only one dispatch in flight while a new session is starting', async () => {
    let resolveDispatch: (value: unknown) => void = () => undefined;
    const dispatchPrompt = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt })}
        onExit={vi.fn()}
      />,
    );

    for (const char of 'slow') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await settleInput();
    for (const char of 'next') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatchPrompt).toHaveBeenCalledOnce();
    expect(dispatchPrompt).toHaveBeenCalledWith('slow', false);
    expect(lastFrame()).toContain('Starting session');
    expect(lastFrame()).toContain('> next');

    resolveDispatch({ sessionId: 'new-session' });
    await flushInk();
  });

  it('keeps unknown slash prompts dispatchable for user commands and skills', async () => {
    const dispatchPrompt = vi.fn(async () => ({ sessionId: 'new-session' }));
    const { stdin } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({ dispatchPrompt })}
        onExit={vi.fn()}
      />,
    );

    for (const char of '/zz') {
      stdin.write(char);
      await Promise.resolve();
    }
    stdin.write('\r');
    await flushInk();

    expect(dispatchPrompt).toHaveBeenCalledWith('/zz', false);
  }, 10_000);

  it('clears input on Ctrl+C and exits on a repeated Ctrl+C', async () => {
    const onExit = vi.fn();
    const { stdin, lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions()}
        onExit={onExit}
      />,
    );

    stdin.write('x');
    await flushInk();
    expect(lastFrame()).toContain('> x');

    stdin.write('\x03');
    await flushInk();
    expect(lastFrame()).not.toContain('> x');
    expect(onExit).not.toHaveBeenCalled();

    stdin.write('\x03');
    await flushInk();
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('refreshes rows on the configured interval', async () => {
    vi.useFakeTimers();
    try {
      const loadRows = vi.fn(async () => [row('session-2')]);
      const { lastFrame } = render(
        <AgentViewApp
          rows={[row('session-1')]}
          actions={actions({ loadRows })}
          onExit={vi.fn()}
          refreshIntervalMs={10}
        />,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      await Promise.resolve();

      expect(loadRows).toHaveBeenCalledOnce();
      expect(lastFrame()).toContain('session-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes rows when the supervisor subscription reports a change', async () => {
    let notify: (() => void) | undefined;
    const loadRows = vi.fn(async () => [row('session-2')]);
    const { lastFrame } = render(
      <AgentViewApp
        rows={[row('session-1')]}
        actions={actions({
          loadRows,
          subscribeToChanges: (onChange) => {
            notify = onChange;
            return { dispose: vi.fn() };
          },
        })}
        onExit={vi.fn()}
      />,
    );

    await act(async () => {
      notify?.();
    });
    await flushInk();

    expect(loadRows).toHaveBeenCalledOnce();
    expect(lastFrame()).toContain('session-2');
  });
});

function render(element: ReactElement) {
  return inkRender(
    <KeypressProvider kittyProtocolEnabled={false}>{element}</KeypressProvider>,
  );
}

function actions(
  overrides: Partial<ComponentProps<typeof AgentViewApp>['actions']> = {},
): ComponentProps<typeof AgentViewApp>['actions'] {
  return {
    dispatchPrompt: vi.fn(),
    peekSelected: vi.fn(),
    sendToSession: vi.fn(),
    answerSession: vi.fn(),
    pinSession: vi.fn(),
    renameSession: vi.fn(),
    stopSession: vi.fn(),
    removeSession: vi.fn(),
    loadRows: vi.fn(async () => [row('session-1')]),
    ...overrides,
  };
}

async function flushInk(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve();
    await new Promise((resolve) => process.nextTick(resolve));
  }
}

async function settleInput(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForFrame(
  lastFrame: () => string | undefined,
  text: string,
): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await flushInk();
    if (lastFrame()?.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function row(
  sessionId: string,
  overrides: Partial<AgentRosterRow> = {},
): AgentRosterRow {
  return {
    sessionId,
    displayName: sessionId,
    state: 'idle',
    stateLabel: 'Idle',
    stateGroup: 'done',
    taskState: 'ready',
    inputState: 'none',
    runtimeState: 'alive',
    recoverability: 'live',
    iconShape: 'alive',
    iconTone: 'ready',
    title: sessionId,
    subtitle: '',
    actions: {
      canAttach: true,
      canPeek: true,
      canReply: true,
      canStop: false,
      canRemove: true,
      canRespawn: false,
      canHibernate: true,
      needsBlockingAnswer: false,
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
