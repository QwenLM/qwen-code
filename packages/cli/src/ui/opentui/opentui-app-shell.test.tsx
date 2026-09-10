/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Wiring tests for the OpenTUI app shell (Batch 5 — backend composition root).
 *
 * The shell is kept real together with the pieces it composes — the concrete
 * {@link OpenTuiAppHost}, the {@link OpenTuiSlashGateway} routing gate, and the
 * {@link OpenTuiErrorBoundary}. Only the collaborators the shell delegates to
 * are stubbed: the slash dispatcher (so a submission resolves to a chosen
 * outcome without running a real command) and the child widgets it renders (the
 * dialog mount and the composer, reduced to string markers that also capture
 * their props). This asserts the seams the design names for this batch:
 *
 *  - composer input flows through the gateway and the outcome is applied:
 *    `open_dialog` swaps the composer for the dialog mount, `submit_prompt`
 *    reaches the live-turn seam, `quit` reaches the entry, a non-slash input
 *    (dispatcher returns false) is sent as a prompt, with pasted image paths
 *    forwarded as a structured argument rather than folded into the text;
 *  - a submission that arrives while a turn responds is held unless the command
 *    opted into running mid-turn, then replayed in order on the idle edge;
 *  - a prompt reaches the live-turn seam as typed, with the raw text also
 *    riding along as provenance — `@path` expansion belongs to the stream
 *    layer, so text queued mid-turn is expanded too;
 *  - a failed dispatcher initialization rejects later submissions with the
 *    recorded reason instead of misrouting to the model;
 *  - the confirmation bridge renders a real modal (shell / action) and the
 *    returned promise settles with the dialog's resolution, so a command can
 *    never hang waiting for a renderer;
 *  - the session re-key reaches the entry seam, or reports that no owner is
 *    wired to re-key the UI-side session state;
 *  - host history writes reach the live transcript as projected events and a
 *    host clear arrives as an empty reset;
 *  - user history rows drive the composer's history, and an error thrown in the
 *    subtree is caught by the boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { OpenTuiApp } from './opentui-app-shell.js';
import { STATUS_INDICATOR_WIDTH } from './messages.js';
import { hasSlashCommandPathSeparator } from '../utils/commandUtils.js';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { SlashCommand } from '../commands/types.js';
import type { OpenTuiDispatchOutcome } from './commands-dispatch.js';

const mocks = vi.hoisted(() => {
  const state = {
    handleResult: undefined as unknown,
    handleResults: [] as unknown[],
    loadRejects: false,
    deferDuringStreaming: false,
    deferGate: null as null | ((text: string) => boolean | Promise<boolean>),
    handledTexts: [] as string[],
    host: null as unknown,
    /** One entry per dispatcher construction: churn means the host was rebuilt. */
    hosts: [] as unknown[],
    dispatcherConstructions: 0,
    inputProps: null as Record<string, unknown> | null,
    dialogProps: null as Record<string, unknown> | null,
    toolConfirmProps: null as Record<string, unknown> | null,
    shellConfirmProps: null as Record<string, unknown> | null,
    actionConfirmProps: null as Record<string, unknown> | null,
    bannerProps: null as Record<string, unknown> | null,
    footerProps: null as Record<string, unknown> | null,
    loadingProps: null as Record<string, unknown> | null,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    exitInProgress: false,
    /** Runs while a dispatched command is still awaiting its outcome. */
    onHandle: null as null | ((text: string) => void),
    /** Resolved immediately, so the drain never blocks on a shell lane. */
    executeUserShell: vi.fn(() => Promise.resolve()),
    /** Holds the dispatcher's busy slot on this text until released. */
    holdHandleOn: null as string | null,
    releaseHandle: null as null | (() => void),
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

// Slash dispatcher: a submission resolves to the next queued handleResults
// entry, or to handleResult when that queue is empty; the constructor captures
// the host so history can be driven from a test.
vi.mock('./commands-dispatch.js', () => ({
  OpenTuiSlashDispatcher: class {
    constructor(
      host: unknown,
      _services: unknown,
      commands: readonly unknown[],
    ) {
      mocks.state.host = host;
      mocks.state.hosts.push(host);
      mocks.state.dispatcherConstructions += 1;
      this._commands = commands;
    }
    _commands: readonly unknown[];
    get commands() {
      return this._commands;
    }
    async loadCommands() {
      if (mocks.state.loadRejects) throw new Error('registry exploded');
    }
    async mustDeferDuringStreaming(text: string) {
      const gate = mocks.state.deferGate;
      return gate ? gate(text) : mocks.state.deferDuringStreaming;
    }
    // The shell's entry tag asks this predicate; mirror the real rule.
    takesAsSlashCommand(text: string) {
      const trimmed = text.trim();
      if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
        return false;
      }
      return !(
        trimmed.startsWith('/') && hasSlashCommandPathSeparator(trimmed)
      );
    }
    cancel() {}
    dispose() {}
    async handle(text: string) {
      if (
        mocks.state.holdHandleOn === text &&
        mocks.state.releaseHandle === null
      ) {
        await new Promise<void>((resolve) => {
          mocks.state.releaseHandle = resolve;
        });
      }
      mocks.state.handledTexts.push(text);
      mocks.state.onHandle?.(text);
      const queued = mocks.state.handleResults;
      return queued.length > 0 ? queued.shift() : mocks.state.handleResult;
    }
  },
}));

// Child widgets: string markers that also record their props for assertions.
vi.mock('./shell-mode.js', () => ({
  executeUserShell: mocks.state.executeUserShell,
}));
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
vi.mock('./opentui-header.js', () => ({
  OpenTuiBanner: (props: Record<string, unknown>) => {
    mocks.state.bannerProps = props;
    return <span>banner</span>;
  },
}));
vi.mock('./opentui-footer.js', () => ({
  OpenTuiFooter: (props: Record<string, unknown>) => {
    mocks.state.footerProps = props;
    return <span>footer</span>;
  },
  OpenTuiLoadingIndicator: (props: Record<string, unknown>) => {
    mocks.state.loadingProps = props;
    return <span>loading-indicator</span>;
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
vi.mock('./exit-lifecycle.js', () => ({
  isExitInProgress: () => mocks.state.exitInProgress,
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
    mocks.state.handleResults.length = 0;
    mocks.state.loadRejects = false;
    mocks.state.deferDuringStreaming = false;
    mocks.state.deferGate = null;
    mocks.state.handledTexts.length = 0;
    mocks.state.host = null;
    mocks.state.hosts.length = 0;
    mocks.state.dispatcherConstructions = 0;
    mocks.state.inputProps = null;
    mocks.state.dialogProps = null;
    mocks.state.toolConfirmProps = null;
    mocks.state.shellConfirmProps = null;
    mocks.state.actionConfirmProps = null;
    mocks.state.bannerProps = null;
    mocks.state.footerProps = null;
    mocks.state.loadingProps = null;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.exitInProgress = false;
    mocks.state.onHandle = null;
    mocks.state.holdHandleOn = null;
    mocks.state.releaseHandle = null;
    mocks.state.executeUserShell.mockClear();
  });

  afterEach(() => {
    mocks.state.executeUserShell.mockImplementation(() => Promise.resolve());
  });

  it('renders the composer inside the error boundary by default', async () => {
    renderApp();
    await settle();
    expect(screen.getByText('input-prompt')).toBeTruthy();
  });

  it('mounts the restored banner and footer, and feeds them the streaming flag', async () => {
    renderApp({ streaming: true });
    await settle();
    expect(screen.getByText('banner')).toBeTruthy();
    expect(screen.getByText('footer')).toBeTruthy();
    expect(mocks.state.footerProps?.['streaming']).toBe(true);
    expect(mocks.state.loadingProps?.['streaming']).toBe(true);
  });

  it('builds one host, and one dispatcher, across re-renders', async () => {
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      onTranscriptEvent: vi.fn(),
      onTranscriptReset: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    // A turn re-renders this component repeatedly. Every transcript seam prop
    // above is a stable identity (the live turn memoizes them with empty-dep
    // useCallbacks), so rebuilding the host here would mean the shell's own
    // memo broke — and a churning host loses `host.history` per render.
    for (const streaming of [true, false, true, false]) {
      await act(async () => {
        view.rerender(<OpenTuiApp {...props} streaming={streaming} />);
        await Promise.resolve();
      });
    }

    expect(mocks.state.dispatcherConstructions).toBe(1);
    expect(new Set(mocks.state.hosts).size).toBe(1);
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

  it('routes settings sub-dialog rows to their own dialogs (U-9)', async () => {
    renderApp();
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'settings' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/settings');
    expect(screen.getByText('dialog:settings')).toBeTruthy();

    const onSelectSetting = mocks.state.dialogProps?.['onSelectSetting'] as (
      name: string,
    ) => void;
    expect(typeof onSelectSetting).toBe('function');

    // Ink DialogManager parity: each row opens the dialog ink opens, the
    // model rows in their own mode. Each selection replaces the current
    // request, so no close/re-open dance is needed between rows.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['ui.theme', { dialog: 'theme' }],
      ['general.preferredEditor', { dialog: 'editor' }],
      ['fastModel', { dialog: 'model', mode: 'fast' }],
      ['visionModel', { dialog: 'model', mode: 'vision' }],
    ];
    for (const [name, request] of cases) {
      await act(async () => {
        onSelectSetting(name);
      });
      expect(mocks.state.dialogProps?.['request']).toEqual(request);
    }

    await act(async () => {
      onSelectSetting('some.other.setting');
    });
    expect(screen.getByText('input-prompt')).toBeTruthy();
  });

  it('fills the composer through the entry-owned handle (U-9)', async () => {
    const setText = vi.fn();
    const composerHandle = { current: { getText: () => '', setText } };
    renderApp({ composerHandle });
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'arena', mode: 'start' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/arena start');
    expect(screen.getByText('dialog:arena')).toBeTruthy();

    // The picker unmounts the prompt before remounting it, so the shell
    // fills through the polling injector rather than the current handle.
    const fillInput = mocks.state.dialogProps?.['fillInput'] as (
      text: string,
    ) => void;
    expect(typeof fillInput).toBe('function');
    await act(async () => {
      fillInput('/arena start --models a,b ');
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(setText).toHaveBeenCalledWith('/arena start --models a,b ');
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
        // The recorded invocation is already on the transcript, so the live
        // turn must not echo the generated content as a second user row.
        invocationEchoed: true,
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
      invocationEchoed: true,
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
      {
        submittedPrompt: 'summarize the diff',
      },
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
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'what is in these',
      ['a.png', 'b.png'],
      { submittedPrompt: 'what is in these' },
    );
  });

  it('forwards an @-mention raw, leaving expansion to the stream layer', async () => {
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = false;

    // Expanding here would miss the text a turn queues mid-way, so the shell
    // hands over what was typed and `livePromptEvents` resolves the mentions.
    await submit('summarize @src/a.ts');
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'summarize @src/a.ts',
      undefined,
      { submittedPrompt: 'summarize @src/a.ts' },
    );
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

  it('routes a host history write to the live transcript (U-28)', async () => {
    const onTranscriptEvent = vi.fn();
    renderApp({ onTranscriptEvent });
    await settle();
    const host = mocks.state.host as {
      addItem: (item: unknown, ts: number) => void;
    };
    await act(async () => {
      host.addItem({ type: 'info', text: 'Report filed.' }, 1000);
    });
    expect(onTranscriptEvent).toHaveBeenCalledWith({
      type: 'info',
      text: 'Report filed.',
    });
  });

  it('routes a host clear to an empty transcript reset (U-29)', async () => {
    const onTranscriptReset = vi.fn();
    renderApp({ onTranscriptReset });
    await settle();
    const host = mocks.state.host as { clearItems: () => void };
    await act(async () => {
      host.clearItems();
    });
    expect(onTranscriptReset).toHaveBeenCalledWith([]);
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

  it('passes the follow-up suggestion and its dismiss through (U-7)', async () => {
    const onPromptSuggestionDismiss = vi.fn();
    renderApp({ promptSuggestion: 'Run the tests', onPromptSuggestionDismiss });
    await settle();
    expect(mocks.state.inputProps?.['promptSuggestion']).toBe('Run the tests');
    (mocks.state.inputProps?.['onPromptSuggestionDismiss'] as () => void)();
    expect(onPromptSuggestionDismiss).toHaveBeenCalledTimes(1);
  });

  it('holds a mid-turn slash command until the turn ends', async () => {
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/compress');
    expect(mocks.state.handledTexts).toEqual([]);
    expect(screen.getByText(/Queued \/compress/)).toBeTruthy();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/compress']);
  });

  it('runs a mid-turn slash command that opted into streaming at once', async () => {
    renderApp({ streaming: true });
    await settle();
    await submit('/help');
    expect(mocks.state.handledTexts).toEqual(['/help']);
  });

  it('claims a mid-turn shell-mode ?btw for the dispatcher, not the shell', async () => {
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('?btw why');
    expect(mocks.state.handledTexts).toEqual(['?btw why']);
    expect(screen.queryByText(/Queued/)).toBeNull();

    // The idle edge must not resurrect it on the shell lane either.
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['?btw why']);
    expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
  });

  it('keeps a slash-prefixed path on the shell lane when queued mid-turn', async () => {
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('/usr/bin/ls --color');
    expect(screen.getByText(/Queued \/usr\/bin\/ls/)).toBeTruthy();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual([]);
    expect(mocks.state.executeUserShell).toHaveBeenCalledWith(
      CONFIG,
      '/usr/bin/ls --color',
      props.onTranscriptEvent,
      expect.any(AbortSignal),
      // The `!` row renders behind the 2-col input indicator, so the child
      // runs over that inner width (R1-42).
      expect.objectContaining({
        width: 120 - STATUS_INDICATOR_WIDTH,
        height: 40,
      }),
    );
  });

  it('dispatches a slash command instead of running it as shell at idle (U-33)', async () => {
    render(
      <OpenTuiApp
        config={CONFIG}
        settings={SETTINGS}
        logger={null}
        commands={[] as readonly SlashCommand[]}
        getSessionStats={getSessionStats}
        streaming={false}
      />,
    );
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('/help');
    expect(mocks.state.handledTexts).toEqual(['/help']);
    expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
  });

  it('holds a second shell submission and quit aborts every command', async () => {
    const signals: AbortSignal[] = [];
    mocks.state.executeUserShell.mockImplementation(((
      _config: unknown,
      _command: string,
      _emit: unknown,
      signal: AbortSignal,
    ) => {
      signals.push(signal);
      return new Promise<void>(() => {});
    }) as unknown as () => Promise<void>);
    mocks.state.handleResults.push(false as unknown as OpenTuiDispatchOutcome, {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome);
    const onQuit = vi.fn();
    const onInterrupt = vi.fn();
    const onSubmitPrompt = vi.fn();
    renderApp({
      onQuit,
      onInterrupt,
      onSubmitPrompt,
      onTranscriptEvent: vi.fn(),
    });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('sleep 10');
    // While the command runs, a second submission must queue behind it
    // instead of starting a concurrent model turn or a racing shell.
    await submit('hello');
    expect(screen.getByText(/Queued hello/)).toBeTruthy();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(signals).toHaveLength(1);

    await submit('/quit');
    expect(onQuit).toHaveBeenCalledWith([]);
    // Nothing survives the exit: the queued command is discarded and the
    // running one's controller is aborted (a single-slot ref keeps only the
    // newest and orphans the first).
    expect(mocks.state.handledTexts).toEqual(['sleep 10', '/quit']);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('routes a prompt held behind a running shell command to the turn seam (R5-5)', async () => {
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onTranscriptEvent = vi.fn();
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt, onTranscriptEvent });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('sleep 10');
    // Shell mode was toggled off while the command still runs (the Esc path):
    // the plain prompt must not start a turn behind the `!` command, whose
    // completion injects LLM history between sends — a concurrent turn turns
    // that write into a mid-turn addHistory (R5-5).
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    await submit('hello');
    expect(screen.getByText(/Queued hello/)).toBeTruthy();
    expect(onSubmitPrompt).not.toHaveBeenCalled();

    await act(async () => {
      releaseShell();
      await shellDone;
    });
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'hello',
      undefined,
      expect.objectContaining({ submittedPrompt: 'hello' }),
    );
  });

  it('carries a held prompt image attachments through the drain (R5-5 fix-induced)', async () => {
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onTranscriptEvent = vi.fn();
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt, onTranscriptEvent });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('sleep 10');
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    await submit('explain this', ['/tmp/screenshot.png']);
    expect(screen.getByText(/Queued explain this/)).toBeTruthy();
    expect(onSubmitPrompt).not.toHaveBeenCalled();

    await act(async () => {
      releaseShell();
      await shellDone;
    });
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'explain this',
      ['/tmp/screenshot.png'],
      expect.objectContaining({ submittedPrompt: 'explain this' }),
    );
  });

  it('re-checks the gate between drain entries so a mid-drain dialog holds the remainder (R6-4)', async () => {
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    // `/theme` models a canRunDuringStreaming command: admitted during the
    // shell entry's await window, everything else defers behind the turn.
    mocks.state.deferGate = (text: string) => text !== '/theme';
    mocks.state.handleResults.push({
      kind: 'open_dialog',
      request: { dialog: 'theme' },
    } satisfies OpenTuiDispatchOutcome);
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('make');
    await submit('/chat save ckpt');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    // The drain started and is parked on the shell entry's await window; the
    // mid-drain `/theme` is admitted straight through the gate and opens the
    // dialog.
    await submit('/theme');
    expect(mocks.state.handledTexts).toEqual(['/theme']);
    expect(screen.getByText('dialog:theme')).toBeTruthy();

    await act(async () => {
      releaseShell();
      await shellDone;
      await Promise.resolve();
    });
    // The second entry must not dispatch behind the dialog the drain's own
    // entry gate would refuse.
    expect(mocks.state.handledTexts).toEqual(['/theme']);

    await act(async () => {
      (mocks.state.dialogProps?.['onClose'] as () => void)();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/theme', '/chat save ckpt']);
  });

  it('runs a command queued during a drain after the drain, not beside it (R5-6)', async () => {
    // A third submission queued while the drain runs must wait for the busy
    // slot instead of a second drain instance racing the first (R5-6): the
    // loser would be dropped with the gateway's busy rejection.
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.holdHandleOn = '/review';
    mocks.state.deferDuringStreaming = true;
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('make');
    await submit('/review');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    // The drain started: `make` runs on the shell lane while /review waits
    // behind it in the same drain.
    expect(mocks.state.executeUserShell).toHaveBeenCalledTimes(1);

    await submit('/status');

    await act(async () => {
      releaseShell();
      await shellDone;
      // The revision bump from the release re-arms the drain while the busy
      // slot is still held for /review.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // /review's dispatch holds the busy slot (the mock took the hold), so
    // nothing has run to completion yet.
    expect(mocks.state.releaseHandle).not.toBeNull();
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      mocks.state.releaseHandle?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual(['/review', '/status']);
    expect(screen.queryByText(/already running/)).toBeNull();
  });

  it('reports an executeUserShell rejection and releases the shell gate (R5-7)', async () => {
    const onTranscriptEvent = vi.fn();
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    renderApp({ onTranscriptEvent });
    await settle();
    mocks.state.executeUserShell.mockImplementation(() =>
      Promise.reject(new Error('spawn failed')),
    );
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('boom');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const errorEvent = onTranscriptEvent.mock.calls
      .map((call) => call[0] as { type: string; text: string })
      .find((event) => event.type === 'error');
    expect(errorEvent?.text).toContain('spawn failed');

    // The controller left the gate set: a later command still runs instead of
    // queueing behind a lane wedged for the rest of the session.
    const second = vi.fn(() => Promise.resolve());
    mocks.state.executeUserShell.mockImplementation(second);
    await submit('echo ok');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Queued echo ok/)).toBeNull();
  });

  it('sends shell-mode slash input to the init error when the stack failed (R5-8)', async () => {
    mocks.state.loadRejects = true;
    const onQuit = vi.fn();
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: undefined as unknown as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onQuit,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('/quit');
    // No dispatcher exists to tag the submission, so the shell lane must not
    // claim it: the recorded init-error rejection is the truthful answer
    // (R5-8), not a bash execution of `/quit`.
    expect(screen.getByText(/failed to initialize/)).toBeTruthy();
    expect(screen.queryByText(/Queued/)).toBeNull();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
    expect(onQuit).not.toHaveBeenCalled();
  });

  it('stops the turn and exits on a mid-turn quit instead of queueing it', async () => {
    const onQuit = vi.fn();
    const onInterrupt = vi.fn();
    // The dispatcher exempts the quit family from the mid-turn gate, so the
    // shell has to reach the exit while the turn is still responding.
    renderApp({ streaming: true, onQuit, onInterrupt });
    await settle();
    mocks.state.handleResult = {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome;

    await submit('/quit');
    expect(mocks.state.handledTexts).toEqual(['/quit']);
    expect(screen.queryByText(/Queued/)).toBeNull();
    expect(onQuit).toHaveBeenCalledWith([]);
    // Cancel before exiting: the drain must not race a stream still writing.
    expect(onInterrupt.mock.invocationCallOrder[0]).toBeLessThan(
      onQuit.mock.invocationCallOrder[0],
    );
  });

  it('normalizes bare quit tokens ahead of the mid-turn gate and the dispatch', async () => {
    // ink normalizes the whole quit family where its handleFinalSubmit puts the
    // check — before the queue — so an `exit` typed mid-response stops the stream
    // instead of queueing behind it or reaching the model as text. The text the
    // gate is asked about is the ordering witness: `/quit`, never `exit`.
    const gateSeen: string[] = [];
    mocks.state.deferGate = (text) => {
      gateSeen.push(text);
      const command = text.trim();
      return command.startsWith('/') && command !== '/quit';
    };
    const onQuit = vi.fn();
    const onSubmitPrompt = vi.fn();
    renderApp({ streaming: true, onQuit, onSubmitPrompt });
    await settle();
    mocks.state.handleResult = {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome;

    const tokens = ['exit', 'quit', ':q', ':q!', ':wq', ':wq!'];
    for (const token of tokens) await submit(token);

    expect(gateSeen).toEqual(tokens.map(() => '/quit'));
    expect(mocks.state.handledTexts).toEqual(tokens.map(() => '/quit'));
    expect(onQuit).toHaveBeenCalledTimes(tokens.length);
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(screen.queryByText(/Queued/)).toBeNull();
  });

  it('drains a held command whose defer verdict lands after the idle edge', async () => {
    // The gate awaits the command registry, so its verdict can land after the
    // turn it was asked about has already ended (R1-1).
    const gate: { release: (defer: boolean) => void } = {
      release: () => {
        throw new Error('the mid-turn gate never asked for a verdict');
      },
    };
    mocks.state.deferGate = () =>
      new Promise<boolean>((resolve) => {
        gate.release = resolve;
      });
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    const onSubmit = mocks.state.inputProps?.['onSubmit'] as (
      t: string,
    ) => void;
    await act(async () => {
      onSubmit('/compress');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual([]);

    // The turn ends while the verdict is still outstanding.
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual([]);

    // The verdict queues the command onto an already-idle session; it must run
    // without waiting for another streaming transition. The macrotask flush
    // lets the resumed submission's queue push re-render and re-run the drain.
    await act(async () => {
      gate.release(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual(['/compress']);
  });

  it('replays held commands in submission order, pausing behind a submit_prompt', async () => {
    const onSubmitPrompt = vi.fn();
    mocks.state.deferDuringStreaming = true;
    mocks.state.handleResults = [
      { kind: 'submit_prompt', content: 'generated' },
      { kind: 'handled' },
    ] satisfies OpenTuiDispatchOutcome[];
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onSubmitPrompt,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/first');
    await submit('/second');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/first']);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);

    // The first outcome started a turn, so the command behind it waits for
    // that turn rather than racing the stream it just opened (R1-5).
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={true} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/first']);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/first', '/second']);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
  });

  it('holds the queue behind a dialog the drain opened, resuming on close', async () => {
    mocks.state.deferDuringStreaming = true;
    mocks.state.handleResults = [
      { kind: 'open_dialog', request: { dialog: 'theme' } },
      { kind: 'open_dialog', request: { dialog: 'resume' } },
    ] satisfies OpenTuiDispatchOutcome[];
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/theme');
    await submit('/resume');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    // The first dialog owns the UI; the second must not overwrite it (R1-7).
    expect(mocks.state.handledTexts).toEqual(['/theme']);
    expect(screen.getByText('dialog:theme')).toBeTruthy();
    expect(screen.queryByText('dialog:resume')).toBeNull();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/theme', '/resume']);
    expect(screen.getByText('dialog:resume')).toBeTruthy();
  });

  it('does not replay a held command over a dialog the user is in', async () => {
    // `/settings` opts into mid-turn streaming, so its dialog opens while the
    // turn still streams; the held `/model` must wait for it to close (R1-12).
    mocks.state.deferGate = (text) => text === '/model';
    mocks.state.handleResults = [
      { kind: 'open_dialog', request: { dialog: 'settings' } },
      { kind: 'handled' },
    ] satisfies OpenTuiDispatchOutcome[];
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/model');
    expect(mocks.state.handledTexts).toEqual([]);
    // The composer unmounts once a dialog opens, so this is the reachable
    // order: held first, dialog second.
    await submit('/settings');
    expect(mocks.state.handledTexts).toEqual(['/settings']);
    expect(screen.getByText('dialog:settings')).toBeTruthy();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/settings']);
    expect(screen.getByText('dialog:settings')).toBeTruthy();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/settings', '/model']);
  });

  it('drops both mid-turn queues when a quit exits during the turn', async () => {
    const onQuit = vi.fn();
    const onInterrupt = vi.fn();
    const onPopQueue = vi.fn(() => 'queued prompt');
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onQuit,
      onInterrupt,
      onPopQueue,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/compress');
    expect(screen.getByText(/Queued \/compress/)).toBeTruthy();

    // Quit is exempt from the gate, so it reaches the exit while streaming.
    mocks.state.deferDuringStreaming = false;
    mocks.state.handleResult = {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome;
    await submit('/quit');
    expect(onQuit).toHaveBeenCalledWith([]);

    // The interrupt ends the turn, which is the idle edge that wakes the drain:
    // the held command must not replay into the exit cleanup (R1-8), and the
    // steering queue must not be promoted into a fresh turn by the same abort
    // (R1-10) — so it is discarded before the interrupt fires.
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/quit']);
    expect(onPopQueue.mock.invocationCallOrder[0]).toBeLessThan(
      onInterrupt.mock.invocationCallOrder[0],
    );
  });

  it('does not replay held commands once an exit drain is in flight', async () => {
    // The Ctrl+C/Ctrl+D double press and render-error exits never pass through
    // this shell's quit branch, so they cannot clear the ref at the source —
    // the drain itself must consult the shared exit latch (R2-1).
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/first');
    await submit('/second');
    expect(mocks.state.handledTexts).toEqual([]);

    // The exit drain starts (exitSession), then the idle edge the drain waits
    // on crosses — the snapshot must not dispatch behind the teardown.
    mocks.state.exitInProgress = true;
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual([]);
  });

  it('stops between dispatches when the exit starts while one is in flight', async () => {
    // The crossing the edge check cannot see: the drain is already past it,
    // and the exit begins while '/first' awaits its outcome. Only the in-loop
    // latch check keeps '/second' back (R4-1).
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/first');
    await submit('/second');
    expect(mocks.state.handledTexts).toEqual([]);

    mocks.state.onHandle = () => {
      mocks.state.exitInProgress = true;
    };
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual(['/first']);
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
