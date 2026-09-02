/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wiring tests for the OpenTUI app shell (Batch 5 — backend composition root).
 *
 * The shell is kept real together with the pieces it composes — the concrete
 * {@link OpenTuiAppHost}, the {@link OpenTuiSlashGateway} routing gate, and the
 * {@link OpenTuiErrorBoundary}. Only the collaborators the shell delegates to
 * are stubbed: the slash dispatcher (so a submission resolves to a chosen
 * outcome without running a real command) and the two child widgets it renders
 * (the dialog mount and the composer, reduced to string markers that also
 * capture their props). This asserts the seams the design names for this batch:
 *
 *  - composer input flows through the gateway and the outcome is applied:
 *    `open_dialog` swaps the composer for the dialog mount, `submit_prompt`
 *    reaches the live-turn seam, `quit` reaches the entry, a non-slash input
 *    (dispatcher returns false) is sent as a prompt, with pasted image paths
 *    forwarded as a structured argument rather than folded into the text;
 *  - a failed dispatcher initialization rejects later submissions with the
 *    recorded reason instead of misrouting to the model;
 *  - the confirmation bridge renders a real modal (shell / action) and the
 *    returned promise settles with the dialog's resolution, so a command can
 *    never hang waiting for a renderer;
 *  - the session re-key reaches the entry seam, or reports that no owner is
 *    wired to re-key the UI-side session state;
 *  - user history rows drive the composer's history, and an error thrown in the
 *    subtree is caught by the boundary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { OpenTuiApp } from './opentui-app-shell.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { SlashCommand } from '../commands/types.js';
import type { OpenTuiDispatchOutcome } from './commands-dispatch.js';

const mocks = vi.hoisted(() => {
  const state = {
    handleResult: undefined as unknown,
    loadRejects: false,
    host: null as unknown,
    inputProps: null as Record<string, unknown> | null,
    dialogProps: null as Record<string, unknown> | null,
    toolConfirmProps: null as Record<string, unknown> | null,
    shellConfirmProps: null as Record<string, unknown> | null,
    actionConfirmProps: null as Record<string, unknown> | null,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useTerminalDimensions: () => ({ width: 120, height: 40 }),
  useRenderer: () => ({
    addInputHandler: () => {},
    removeInputHandler: () => {},
  }),
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

// Slash dispatcher: every submission resolves to the current handleResult; the
// constructor captures the host so history can be driven from a test.
vi.mock('./commands-dispatch.js', () => ({
  OpenTuiSlashDispatcher: class {
    constructor(
      host: unknown,
      _services: unknown,
      commands: readonly unknown[],
    ) {
      mocks.state.host = host;
      this._commands = commands;
    }
    _commands: readonly unknown[];
    get commands() {
      return this._commands;
    }
    async loadCommands() {
      if (mocks.state.loadRejects) throw new Error('registry exploded');
    }
    canRunDuringStreaming() {
      return false;
    }
    cancel() {}
    dispose() {}
    async handle() {
      return mocks.state.handleResult;
    }
  },
}));

// Child widgets: string markers that also record their props for assertions.
vi.mock('./opentui-dialog-mount.js', () => ({
  OpenTuiDialogMount: (props: Record<string, unknown>) => {
    mocks.state.dialogProps = props;
    const request = props['request'] as { dialog: string };
    return `dialog:${request.dialog}`;
  },
}));
vi.mock('./input-prompt.js', () => ({
  OpenTuiInputPrompt: (props: Record<string, unknown>) => {
    mocks.state.inputProps = props;
    return 'input-prompt';
  },
}));
vi.mock('./dialogs-confirm.js', () => ({
  OpenTuiToolConfirmation: (props: Record<string, unknown>) => {
    mocks.state.toolConfirmProps = props;
    return 'tool-confirm';
  },
  OpenTuiShellConfirmation: (props: Record<string, unknown>) => {
    mocks.state.shellConfirmProps = props;
    return 'shell-confirm';
  },
  OpenTuiActionConfirmation: (props: Record<string, unknown>) => {
    mocks.state.actionConfirmProps = props;
    return 'action-confirm';
  },
}));

const CONFIG = {} as unknown as Config;
const SETTINGS = { merged: {} } as unknown as LoadedSettings;
const getSessionStats = () => ({}) as unknown as SessionStatsState;

function renderApp(overrides: Partial<Parameters<typeof OpenTuiApp>[0]> = {}) {
  const props: Parameters<typeof OpenTuiApp>[0] = {
    config: CONFIG,
    settings: SETTINGS,
    logger: null,
    commands: [] as readonly SlashCommand[],
    getSessionStats,
    ...overrides,
  };
  return render(<OpenTuiApp {...props} />);
}

/** Flush the mount effect so the gateway attaches (or records init failure). */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Run one composer submission and flush the async dispatch. */
async function submit(text: string, imagePaths?: string[]): Promise<void> {
  const onSubmit = mocks.state.inputProps?.['onSubmit'] as (
    t: string,
    i?: string[],
  ) => void;
  await act(async () => {
    onSubmit(text, imagePaths);
    await Promise.resolve();
  });
}

describe('OpenTuiApp shell wiring', () => {
  beforeEach(() => {
    mocks.state.handleResult = { kind: 'handled' };
    mocks.state.loadRejects = false;
    mocks.state.host = null;
    mocks.state.inputProps = null;
    mocks.state.dialogProps = null;
    mocks.state.toolConfirmProps = null;
    mocks.state.shellConfirmProps = null;
    mocks.state.actionConfirmProps = null;
    mocks.state.keyboardHandlers.length = 0;
  });

  it('renders the composer inside the error boundary by default', async () => {
    renderApp();
    await settle();
    expect(screen.getByText('input-prompt')).toBeTruthy();
  });

  it('reserves the update-notification slot, hidden while a dialog is open', async () => {
    renderApp({ updateNotice: 'Update available: v1.2.3' });
    await settle();
    expect(screen.getByText('Update available: v1.2.3')).toBeTruthy();

    // A dialog opening must hide the banner (ink parity: !dialogsVisible).
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'help' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/help');
    expect(screen.getByText('dialog:help')).toBeTruthy();
    expect(screen.queryByText('Update available: v1.2.3')).toBeNull();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
    });
    expect(screen.getByText('Update available: v1.2.3')).toBeTruthy();
  });

  it('routes an open_dialog outcome to the dialog mount and closes it', async () => {
    renderApp();
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'help' },
    } satisfies OpenTuiDispatchOutcome;

    await submit('/help');
    expect(screen.getByText('dialog:help')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
    });
    expect(screen.getByText('input-prompt')).toBeTruthy();
  });

  it('sends a submit_prompt outcome to the live-turn seam', async () => {
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = {
      kind: 'submit_prompt',
      content: 'rewind to checkpoint',
    } satisfies OpenTuiDispatchOutcome;

    await submit('/rewind apply');
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'rewind to checkpoint',
      undefined,
      {
        modelOverride: undefined,
        onComplete: undefined,
        refreshContextFilesOnWrite: undefined,
      },
    );
  });

  it("forwards a submit_prompt outcome's per-turn options to the seam", async () => {
    const onSubmitPrompt = vi.fn();
    const onComplete = async () => {};
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = {
      kind: 'submit_prompt',
      content: 'summarize',
      modelOverride: 'qwen3-max',
      refreshContextFilesOnWrite: true,
      onComplete,
    } satisfies OpenTuiDispatchOutcome;

    await submit('/model summarize');
    expect(onSubmitPrompt).toHaveBeenCalledWith('summarize', undefined, {
      modelOverride: 'qwen3-max',
      refreshContextFilesOnWrite: true,
      onComplete,
    });
  });

  it('reaches the entry seam on a quit outcome', async () => {
    const onQuit = vi.fn();
    renderApp({ onQuit });
    await settle();
    const messages = [{ type: 'user', text: 'bye', id: 1 }] as never;
    mocks.state.handleResult = {
      kind: 'quit',
      messages,
    } satisfies OpenTuiDispatchOutcome;

    await submit('/quit');
    expect(onQuit).toHaveBeenCalledWith(messages);
  });

  it('sends a non-slash input (dispatcher returns false) as a plain prompt', async () => {
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = false;

    await submit('summarize the diff');
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'summarize the diff',
      undefined,
    );
  });

  it('passes pasted image paths through structured, not folded into the text', async () => {
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = false;

    await submit('what is in these', ['a.png', 'b.png']);
    // The shell has no business choosing an image encoding: the entry layer
    // builds the real parts (ink: attachments), so the paths stay separate.
    expect(onSubmitPrompt).toHaveBeenCalledWith('what is in these', [
      'a.png',
      'b.png',
    ]);
  });

  it('reports a not-wired notice for a plain prompt when no seam is provided', async () => {
    renderApp();
    await settle();
    mocks.state.handleResult = false;

    await submit('hello there');
    expect(
      screen.getByText('The live prompt turn is not wired in this shell.'),
    ).toBeTruthy();
  });

  it('rejects submissions after a failed dispatcher init', async () => {
    const onSubmitPrompt = vi.fn();
    mocks.state.loadRejects = true;
    renderApp({ commands: undefined, onSubmitPrompt });
    await settle();

    await submit('/help');
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(
      screen.getByText(/failed to initialize \(registry exploded\)/),
    ).toBeTruthy();
  });

  it('drives the composer history from the host transcript', async () => {
    renderApp();
    await settle();
    const host = mocks.state.host as {
      addItem: (item: unknown, ts: number) => void;
    };
    await act(async () => {
      host.addItem({ type: 'user', text: 'earlier question' }, 1000);
    });
    const userMessages = mocks.state.inputProps?.['userMessages'] as string[];
    expect(userMessages).toContain('earlier question');
  });

  it('routes the session re-key to the entry seam', async () => {
    const onStartNewSession = vi.fn();
    renderApp({ onStartNewSession });
    await settle();
    const host = mocks.state.host as {
      startNewSession: (id: string) => void;
    };
    await act(async () => {
      host.startNewSession('sess-2');
    });
    expect(onStartNewSession).toHaveBeenCalledWith('sess-2');
    expect(screen.queryByText(/not re-keyed/)).toBeNull();
  });

  it('reports when no owner is wired to re-key the session state', async () => {
    renderApp();
    await settle();
    const host = mocks.state.host as {
      startNewSession: (id: string) => void;
    };
    await act(async () => {
      host.startNewSession('sess-2');
    });
    expect(
      screen.getByText('Session state was not re-keyed for the new session.'),
    ).toBeTruthy();
  });

  it('renders the shell confirmation modal and settles with its resolution', async () => {
    renderApp();
    await settle();
    const host = mocks.state.host as {
      presentShellConfirmation: (
        commands: readonly string[],
      ) => Promise<{ outcome: ToolConfirmationOutcome }>;
      presentActionConfirmation: (prompt: unknown) => Promise<boolean>;
    };

    const pending = host.presentShellConfirmation([
      'rm -rf build',
      'npm publish',
    ]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('shell-confirm')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();
    const resolution = {
      outcome: ToolConfirmationOutcome.ProceedOnce,
      approvedCommands: ['rm -rf build', 'npm publish'],
    };
    await act(async () => {
      (mocks.state.shellConfirmProps?.['onResolve'] as (r: unknown) => void)(
        resolution,
      );
    });
    await expect(pending).resolves.toEqual(resolution);
    expect(screen.getByText('input-prompt')).toBeTruthy();

    const actionPending = host.presentActionConfirmation('delete?');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('action-confirm')).toBeTruthy();
    await act(async () => {
      (mocks.state.actionConfirmProps?.['onResolve'] as (c: boolean) => void)(
        true,
      );
    });
    await expect(actionPending).resolves.toBe(true);
  });

  it('gives a waiting tool call priority over the composer and settles it', async () => {
    const onToolCallSettled = vi.fn();
    const call = {
      callId: 'call-1',
      name: 'run_shell_command',
      confirmationDetails: { type: 'info', title: 'ok?' },
    } as never;
    renderApp({
      waitingToolCalls: [call],
      onToolCallSettled,
    });
    await settle();
    expect(screen.getByText('tool-confirm')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();

    await act(async () => {
      (mocks.state.toolConfirmProps?.['onSettled'] as () => void)();
    });
    expect(onToolCallSettled).toHaveBeenCalledWith('call-1');
  });

  it('passes streaming state and interrupt through to the composer', async () => {
    const onInterrupt = vi.fn();
    renderApp({ streaming: true, onInterrupt });
    await settle();
    expect(mocks.state.inputProps?.['streaming']).toBe(true);
    (mocks.state.inputProps?.['onInterrupt'] as () => void)();
    expect(onInterrupt).toHaveBeenCalled();
  });

  it('catches a subtree render error inside the error boundary', async () => {
    const boom = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingView = () => {
      throw new Error('transcript blew up');
    };
    renderApp({ renderMain: () => <ThrowingView /> });
    await settle();
    expect(
      screen.getByText('Something went wrong while rendering.'),
    ).toBeTruthy();
    boom.mockRestore();
  });
});
