/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI full-parity dispatcher against the ink
 * `useSlashCommandProcessor.handleSlashCommand` behavior, using the
 * ORIGINAL shared parser and stub commands that return each
 * `SlashCommandActionReturn` kind.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SlashCommandStatus,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import type { HistoryItem } from '../types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import {
  OpenTuiSlashDispatcher,
  type OpenTuiDispatchOutcome,
} from './commands-dispatch.js';
import type { OpenTuiCommandHost } from './commands-context.js';

const logSlashCommandSpy = vi.fn();

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    logSlashCommand: (...args: unknown[]) => logSlashCommandSpy(...args),
  };
});

function stub(
  overrides: Partial<SlashCommand> & { name: string },
): SlashCommand {
  return {
    description: `stub ${overrides.name}`,
    kind: CommandKind.BUILT_IN,
    ...overrides,
  };
}

interface FakeHost extends OpenTuiCommandHost {
  items: HistoryItem[];
  updates: Array<{ id: number; updates: Record<string, unknown> }>;
  calls: string[];
  sessionNames: Array<string | null>;
  allowlistAdds: string[][];
  processingFlags: boolean[];
  shellConfirmations: string[][];
  actionConfirmations: number;
  resumedSessions: string[];
  branchNames: Array<string | undefined>;
}

function createFakeHost(): FakeHost {
  let nextId = 0;
  const items: FakeHost['items'] = [];
  const updates: FakeHost['updates'] = [];
  const calls: string[] = [];
  const sessionNames: Array<string | null> = [];
  const allowlistAdds: string[][] = [];
  const processingFlags: boolean[] = [];
  const shellConfirmations: string[][] = [];
  const resumedSessions: string[] = [];
  const branchNames: Array<string | undefined> = [];
  let shellResolution = {
    outcome: ToolConfirmationOutcome.Cancel,
    approvedCommands: [] as string[],
  };
  let actionConfirmation = false;
  const push = (name: string) => calls.push(name);

  const host: FakeHost = {
    items,
    updates,
    calls,
    sessionNames,
    allowlistAdds,
    processingFlags,
    shellConfirmations,
    actionConfirmations: 0,
    resumedSessions,
    branchNames,
    getHistory: () => items,
    addItem: (item, timestamp) => {
      const id = nextId++;
      items.push({ ...item, id, timestamp } as HistoryItem);
      return id;
    },
    updateItem: (id, updatesArg) => {
      updates.push({ id, updates: updatesArg as never });
    },
    clearItems: () => {
      push('clearItems');
      items.length = 0;
    },
    loadHistory: () => push('loadHistory'),
    refreshStatic: () => push('refreshStatic'),
    clearPendingState: () => push('clearPendingState'),
    cancelBtw: () => push('cancelBtw'),
    btwItem: null,
    setBtwItem: () => push('setBtwItem'),
    btwAbortControllerRef: { current: null },
    pendingItem: null,
    setPendingItem: (item) => {
      host.pendingItem = item;
      push('setPendingItem');
    },
    setDebugMessage: () => push('setDebugMessage'),
    toggleVimEnabled: async () => true,
    setGeminiMdFileCount: () => push('setGeminiMdFileCount'),
    reloadCommands: () => {
      push('reloadCommands');
    },
    setSessionName: (name) => {
      sessionNames.push(name);
    },
    isIdle: () => true,
    extensionsUpdateState: new Map(),
    dispatchExtensionStateUpdate: () => push('dispatchExtensionStateUpdate'),
    addConfirmUpdateExtensionRequest: () =>
      push('addConfirmUpdateExtensionRequest'),
    sessionStats: {
      sessionId: 'sess-1',
      sessionStartTime: new Date(),
      metrics: {},
      lastPromptTokenCount: 0,
      promptCount: 0,
    } as unknown as SessionStatsState,
    sessionShellAllowlist: new Set<string>(),
    addSessionShellAllowlist: (commands) => {
      allowlistAdds.push([...commands]);
      for (const cmd of commands) host.sessionShellAllowlist.add(cmd);
    },
    setIsProcessing: (flag) => processingFlags.push(flag),
    presentShellConfirmation: async (commands) => {
      shellConfirmations.push([...commands]);
      return shellResolution;
    },
    presentActionConfirmation: async () => {
      host.actionConfirmations += 1;
      return actionConfirmation;
    },
    handleResume: async (sessionId) => {
      resumedSessions.push(sessionId);
    },
    handleBranch: async (name) => {
      branchNames.push(name);
    },
  };
  Object.defineProperty(host, '__setShellResolution', {
    value: (resolution: typeof shellResolution) => {
      shellResolution = resolution;
    },
  });
  Object.defineProperty(host, '__setActionConfirmation', {
    value: (confirmed: boolean) => {
      actionConfirmation = confirmed;
    },
  });
  return host;
}

function setShellResolution(
  host: FakeHost,
  resolution: {
    outcome: ToolConfirmationOutcome;
    approvedCommands?: string[];
  },
): void {
  (
    host as unknown as {
      __setShellResolution: (r: typeof resolution) => void;
    }
  ).__setShellResolution(resolution);
}

function setActionConfirmation(host: FakeHost, confirmed: boolean): void {
  (
    host as unknown as { __setActionConfirmation: (c: boolean) => void }
  ).__setActionConfirmation(confirmed);
}

const services = {
  config: null,
  settings: {} as LoadedSettings,
  logger: null,
};

async function dispatch(
  input: string,
  commands: SlashCommand[],
  hostOverride?: Partial<FakeHost>,
): Promise<{ outcome: OpenTuiDispatchOutcome | false; host: FakeHost }> {
  const host = createFakeHost();
  Object.assign(host, hostOverride);
  const dispatcher = new OpenTuiSlashDispatcher(host, services, commands);
  return { outcome: await dispatcher.handle(input), host };
}

describe('guards (ink handleSlashCommand parity)', () => {
  it('returns false for non-slash input and path-like input', async () => {
    const { outcome: plain } = await dispatch('hello world', []);
    expect(plain).toBe(false);
    const { outcome: pathLike } = await dispatch('/usr/bin/ls', []);
    expect(pathLike).toBe(false);
    const { outcome: question } = await dispatch('?', [
      stub({ name: 'help', altNames: ['?'] }),
    ]);
    expect(question).not.toBe(false);
  });

  it('echoes the invocation as a user item, skipped for /btw', async () => {
    const commands = [
      stub({
        name: 'greet',
        action: () => ({
          type: 'message',
          messageType: 'info',
          content: 'hi',
        }),
      }),
      stub({
        name: 'btw',
        action: () => ({
          type: 'message',
          messageType: 'info',
          content: 'side',
        }),
      }),
    ];
    const { host } = await dispatch('/greet', commands);
    expect(host.items[0]).toMatchObject({
      type: 'user',
      text: '/greet',
      sentToModel: false,
    });

    const { host: btwHost } = await dispatch('/btw something', commands);
    expect(btwHost.items.some((item) => item.type === 'user')).toBe(false);
  });
});

describe('result mapping (all SlashCommandActionReturn kinds)', () => {
  it('unknown commands produce the ink error message', async () => {
    const { outcome, host } = await dispatch('/nope', []);
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items.at(-1)).toMatchObject({
      type: 'error',
      text: 'Unknown command: /nope',
    });
  });

  it('message results become history items by messageType', async () => {
    const commands = [
      stub({
        name: 'warn',
        action: () => ({
          type: 'message',
          messageType: 'warning',
          content: 'careful',
        }),
      }),
    ];
    const { outcome, host } = await dispatch('/warn', commands);
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items.at(-1)).toMatchObject({
      type: 'warning',
      text: 'careful',
    });
  });

  it('replaces the vim toggle message with a faithful unsupported notice (G-11b)', async () => {
    const commands = [
      stub({
        name: 'vim',
        action: async (context) => {
          const enabled = await context.ui.toggleVimEnabled();
          return {
            type: 'message',
            messageType: 'info',
            content: enabled
              ? 'Entered Vim mode. Run /vim again to exit.'
              : 'Exited Vim mode.',
          };
        },
      }),
    ];
    // The host reports vim off (the renderer has no vim mode); without the
    // override the ink message would misleadingly say "Exited Vim mode."
    const { outcome, host } = await dispatch('/vim', commands, {
      toggleVimEnabled: async () => false,
    });
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items.at(-1)).toMatchObject({
      type: 'info',
      text: 'Vim mode is not yet available in the OpenTUI renderer.',
    });
  });

  it('parent commands without an action list subcommands (info)', async () => {
    const commands = [
      stub({
        name: 'memory',
        subCommands: [
          stub({ name: 'add', description: 'add memory' }),
          stub({ name: 'show', description: 'show memory' }),
        ],
      }),
    ];
    const { outcome, host } = await dispatch('/memory', commands);
    expect(outcome).toEqual({ kind: 'handled' });
    const item = host.items.at(-1);
    expect(item).toMatchObject({ type: 'info' });
    expect(item?.text).toContain("'/memory' requires a subcommand");
  });

  it('dialog results route through the registry', async () => {
    const commands = [
      stub({
        name: 'theme',
        action: () => ({ type: 'dialog', dialog: 'theme' }),
      }),
      stub({
        name: 'model',
        action: () => ({
          type: 'dialog',
          dialog: 'fast-model',
          persistScope: 'workspace',
        }),
      }),
      stub({
        name: 'arena',
        action: () => ({ type: 'dialog', dialog: 'arena_start' }),
      }),
    ];
    const theme = await dispatch('/theme', commands);
    expect(theme.outcome).toEqual({
      kind: 'open_dialog',
      request: { dialog: 'theme' },
    });
    const model = await dispatch('/model', commands);
    expect(model.outcome).toEqual({
      kind: 'open_dialog',
      request: { dialog: 'model', mode: 'fast', persistScope: 'workspace' },
    });
    const arena = await dispatch('/arena', commands);
    expect(arena.outcome).toEqual({
      kind: 'open_dialog',
      request: { dialog: 'arena', mode: 'start' },
    });
  });

  it('/resume <id> awaits handleResume; /branch awaits handleBranch', async () => {
    const commands = [
      stub({
        name: 'resume',
        action: () => ({ type: 'dialog', dialog: 'resume', sessionId: 's-9' }),
      }),
      stub({
        name: 'resume-picker',
        action: () => ({
          type: 'dialog',
          dialog: 'resume',
          matchedSessions: [],
        }),
      }),
      stub({
        name: 'branch',
        action: () => ({ type: 'dialog', dialog: 'branch', name: 'wip' }),
      }),
    ];
    const resume = await dispatch('/resume', commands);
    expect(resume.outcome).toEqual({ kind: 'handled' });
    expect(resume.host.resumedSessions).toEqual(['s-9']);

    const picker = await dispatch('/resume-picker', commands);
    expect(picker.outcome).toEqual({
      kind: 'open_dialog',
      request: { dialog: 'resume', matchedSessions: [] },
    });

    const branch = await dispatch('/branch', commands);
    expect(branch.host.branchNames).toEqual(['wip']);
  });

  it('quit and tool results surface untouched', async () => {
    const commands = [
      stub({
        name: 'quit',
        action: () => ({ type: 'quit', messages: [] }),
      }),
      stub({
        name: 'github',
        action: () => ({
          type: 'tool',
          toolName: 'run_shell_command',
          toolArgs: { command: 'gh auth' },
        }),
      }),
    ];
    const quit = await dispatch('/quit', commands);
    expect(quit.outcome).toEqual({ kind: 'quit', messages: [] });
    const tool = await dispatch('/github', commands);
    expect(tool.outcome).toEqual({
      kind: 'schedule_tool',
      toolName: 'run_shell_command',
      toolArgs: { command: 'gh auth' },
    });
  });

  it('submit_prompt passes content, modelOverride and onComplete', async () => {
    const onComplete = async () => {};
    const commands = [
      stub({
        name: 'skill',
        action: () => ({
          type: 'submit_prompt',
          content: [{ text: 'do it' }],
          modelOverride: 'fast-model-x',
          onComplete,
        }),
      }),
    ];
    const { outcome, host } = await dispatch('/skill', commands);
    expect(outcome).toEqual({
      kind: 'submit_prompt',
      content: [{ text: 'do it' }],
      modelOverride: 'fast-model-x',
      onComplete,
    });
    // Invocation item marked as sent to the model, like ink updateItem.
    expect(host.updates).toEqual([{ id: 0, updates: { sentToModel: true } }]);
  });

  it('goal_control renders per the ink idle/cause rules', async () => {
    const snapshotWithGoal = {
      v: 2,
      goal: { objective: 'x' },
      activity: 'idle',
    };
    const statusCommand = stub({
      name: 'goal',
      action: () =>
        ({
          type: 'goal_control',
          operation: { kind: 'status' },
          response: { snapshot: snapshotWithGoal },
        }) as never,
    });
    const { host: statusHost } = await dispatch('/goal', [statusCommand]);
    expect(statusHost.items.at(-1)).toMatchObject({
      type: 'goal_state',
      snapshot: snapshotWithGoal,
    });

    const busyCommand = stub({
      name: 'goal',
      action: () =>
        ({
          type: 'goal_control',
          operation: { kind: 'pause' },
          response: { snapshot: snapshotWithGoal },
          cause: 'user',
        }) as never,
    });
    const { host: busyHost } = await dispatch('/goal', [busyCommand], {
      isIdle: () => false,
    });
    expect(busyHost.items.some((item) => item.type === 'goal_state')).toBe(
      false,
    );

    const noGoalCommand = stub({
      name: 'goal',
      action: () =>
        ({
          type: 'goal_control',
          operation: { kind: 'status' },
          response: { snapshot: { v: 2, goal: null, activity: 'idle' } },
        }) as never,
    });
    const { host: noGoalHost } = await dispatch('/goal', [noGoalCommand]);
    expect(noGoalHost.items.at(-1)).toMatchObject({
      type: 'info',
      text: 'No Goal set.',
    });
  });

  it('load_history applies client history, clears, then re-adds items', async () => {
    const setHistory = vi.fn();
    const config = {
      getGeminiClient: () => ({ setHistory }),
    } as unknown as Config;
    const commands = [
      stub({
        name: 'restore',
        action: () => ({
          type: 'load_history',
          history: [{ type: 'info', text: 'restored' }],
          clientHistory: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      }),
    ];
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      { ...services, config },
      commands,
    );
    const outcome = await dispatcher.handle('/restore');
    expect(outcome).toEqual({ kind: 'handled' });
    expect(setHistory).toHaveBeenCalledWith([
      { role: 'user', parts: [{ text: 'hi' }] },
    ]);
    expect(host.calls).toContain('clearItems');
    expect(host.items.at(-1)).toMatchObject({ type: 'info', text: 'restored' });
  });

  it('confirm_action: decline cancels, accept re-runs with overwriteConfirmed', async () => {
    const seenContexts: Array<boolean | undefined> = [];
    let firstRun = true;
    const commands = [
      stub({
        name: 'cd',
        action: (context) => {
          seenContexts.push(context.overwriteConfirmed);
          if (firstRun) {
            firstRun = false;
            return {
              type: 'confirm_action',
              prompt: 'Overwrite?',
              originalInvocation: { raw: '/cd /tmp' },
            };
          }
          return { type: 'message', messageType: 'info', content: 'done' };
        },
      }),
    ];

    const decline = await dispatch('/cd /tmp', commands);
    expect(decline.outcome).toEqual({ kind: 'handled' });
    expect(decline.host.actionConfirmations).toBe(1);
    expect(decline.host.items.at(-1)).toMatchObject({
      type: 'info',
      text: 'Operation cancelled.',
    });

    const host = createFakeHost();
    setActionConfirmation(host, true);
    firstRun = true;
    seenContexts.length = 0;
    const dispatcher = new OpenTuiSlashDispatcher(host, services, commands);
    const outcome = await dispatcher.handle('/cd /tmp');
    expect(outcome).toEqual({ kind: 'handled' });
    expect(seenContexts).toEqual([undefined, true]);
    // No duplicate invocation echo on the recursive run.
    expect(host.items.filter((item) => item.type === 'user')).toHaveLength(1);
  });

  it('confirm_shell_commands honors outcomes and one-time allowlists', async () => {
    const seenAllowlists: Array<ReadonlySet<string>> = [];
    let firstRun = true;
    const commands = [
      stub({
        name: 'cd',
        action: (context) => {
          seenAllowlists.push(new Set(context.session.sessionShellAllowlist));
          if (firstRun) {
            firstRun = false;
            return {
              type: 'confirm_shell_commands',
              commandsToConfirm: ['rm -rf /'],
              originalInvocation: { raw: '/cd' },
            };
          }
          return { type: 'message', messageType: 'info', content: 'ok' };
        },
      }),
    ];

    // Cancel → nothing re-runs.
    const cancel = await dispatch('/cd', commands);
    expect(cancel.outcome).toEqual({ kind: 'handled' });
    expect(cancel.host.shellConfirmations).toEqual([['rm -rf /']]);

    // ProceedOnce → re-run sees the approved commands once.
    const host = createFakeHost();
    setShellResolution(host, {
      outcome: ToolConfirmationOutcome.ProceedOnce,
      approvedCommands: ['rm -rf /'],
    });
    firstRun = true;
    seenAllowlists.length = 0;
    const dispatcher = new OpenTuiSlashDispatcher(host, services, commands);
    await dispatcher.handle('/cd');
    expect(seenAllowlists.map((set) => [...set])).toEqual([[], ['rm -rf /']]);
    expect(host.allowlistAdds).toEqual([]);

    // ProceedAlways → the session allowlist grows persistently.
    const alwaysHost = createFakeHost();
    setShellResolution(alwaysHost, {
      outcome: ToolConfirmationOutcome.ProceedAlways,
      approvedCommands: ['ls'],
    });
    firstRun = true;
    const alwaysDispatcher = new OpenTuiSlashDispatcher(
      alwaysHost,
      services,
      commands,
    );
    await alwaysDispatcher.handle('/cd');
    expect(alwaysHost.allowlistAdds).toEqual([['ls']]);
    expect(alwaysHost.sessionShellAllowlist.has('ls')).toBe(true);
  });

  it('stream_messages is rejected in interactive mode', async () => {
    const commands = [
      stub({
        name: 'compress',
        action: () => ({
          type: 'stream_messages',
          messages: (async function* () {})(),
        }),
      }),
    ];
    const { outcome, host } = await dispatch('/compress', commands);
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items.at(-1)).toMatchObject({
      type: 'error',
      text: 'stream_messages result type is not supported in interactive mode',
    });
  });

  it('thrown actions produce the error text as an item', async () => {
    const commands = [
      stub({
        name: 'boom',
        action: () => {
          throw new Error('kaboom');
        },
      }),
    ];
    const { outcome, host } = await dispatch('/boom', commands);
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items.at(-1)).toMatchObject({ type: 'error', text: 'kaboom' });
  });
});

describe('stacked skills (ink merge parity)', () => {
  function skillStub(name: string): SlashCommand {
    return stub({
      name,
      kind: CommandKind.SKILL,
      description: `skill ${name}`,
      action: () => ({
        type: 'submit_prompt',
        content: [{ text: `${name} content ` }],
      }),
    });
  }

  it('merges multiple skills plus trailing text into one submission', async () => {
    const commands = [skillStub('alpha'), skillStub('beta')];
    const { outcome, host } = await dispatch(
      '/alpha /beta do the thing',
      commands,
    );
    if (outcome === false || outcome.kind !== 'submit_prompt') {
      throw new Error(`expected submit_prompt, got ${String(outcome)}`);
    }
    expect(outcome.content).toEqual([
      { text: 'alpha content ' },
      { text: 'beta content ' },
      { text: 'do the thing' },
    ]);
    expect(host.updates).toEqual([{ id: 0, updates: { sentToModel: true } }]);
  });
});

describe('cancellation, telemetry and recording', () => {
  beforeEach(() => {
    logSlashCommandSpy.mockClear();
  });

  it('cancel() aborts the action and reports like ink', async () => {
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(host, services, [
      stub({
        name: 'slow',
        action: () =>
          new Promise(() => {
            // Never resolves; cancellation must unblock.
          }),
      }),
    ]);
    const pending = dispatcher.handle('/slow');
    await new Promise((resolve) => setTimeout(resolve, 10));
    dispatcher.cancel();
    const outcome = await pending;
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items.some((item) => item.text === 'Command cancelled.')).toBe(
      true,
    );
    expect(host.processingFlags.at(-1)).toBe(false);
  });

  it('logs SUCCESS/ERROR slash-command telemetry like ink', async () => {
    const config = {
      getChatRecordingService: () => undefined,
    } as unknown as Config;
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      { ...services, config },
      [
        stub({
          name: 'greet',
          action: () => ({
            type: 'message',
            messageType: 'info',
            content: 'hi',
          }),
        }),
        stub({
          name: 'boom',
          action: () => {
            throw new Error('x');
          },
        }),
      ],
    );
    await dispatcher.handle('/greet');
    expect(logSlashCommandSpy).toHaveBeenCalledTimes(1);
    expect(logSlashCommandSpy.mock.calls[0][1]).toMatchObject({
      command: 'greet',
      status: SlashCommandStatus.SUCCESS,
    });

    await dispatcher.handle('/boom');
    expect(logSlashCommandSpy).toHaveBeenCalledTimes(2);
    expect(logSlashCommandSpy.mock.calls[1][1]).toMatchObject({
      command: 'boom',
      status: SlashCommandStatus.ERROR,
    });
  });

  it('records invocations + output items, honoring the skip list', async () => {
    const recordSlashCommand = vi.fn();
    const config = {
      getChatRecordingService: () => ({ recordSlashCommand }),
    } as unknown as Config;
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      { ...services, config },
      [
        stub({
          name: 'greet',
          action: (context) => {
            context.ui.addItem({ type: 'info', text: 'from action' }, 1);
            return undefined;
          },
        }),
        stub({
          name: 'clear',
          altNames: ['reset', 'new'],
          action: () => ({
            type: 'message',
            messageType: 'info',
            content: 'cleared',
          }),
        }),
      ],
    );

    await dispatcher.handle('/greet');
    expect(recordSlashCommand).toHaveBeenCalledTimes(2);
    expect(recordSlashCommand.mock.calls[0][0]).toEqual({
      phase: 'invocation',
      rawCommand: '/greet',
      sentToModel: false,
    });
    const resultPhase = recordSlashCommand.mock.calls[1][0];
    expect(resultPhase.phase).toBe('result');
    expect(resultPhase.outputHistoryItems).toEqual([
      { type: 'info', text: 'from action' },
    ]);

    recordSlashCommand.mockClear();
    await dispatcher.handle('/clear');
    expect(recordSlashCommand).not.toHaveBeenCalled();
  });
});
