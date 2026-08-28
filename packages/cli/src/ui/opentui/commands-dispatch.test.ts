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
import {
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from '../commands/types.js';
import type { HistoryItem } from '../types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import {
  OpenTuiSlashDispatcher,
  shouldHideSlashCommandInvocation,
  type OpenTuiDispatchOutcome,
} from './commands-dispatch.js';
import type { OpenTuiCommandHost } from './commands-context.js';

const { logSlashCommandSpy, loadInteractiveCommandsMock } = vi.hoisted(() => ({
  logSlashCommandSpy: vi.fn(),
  loadInteractiveCommandsMock: vi.fn(),
}));

vi.mock('./slash-dispatch.js', () => ({
  loadInteractiveCommands: (...args: unknown[]) =>
    loadInteractiveCommandsMock(...args),
}));

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
    setMemoryFileCount: () => push('setMemoryFileCount'),
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

  it('hides the invocation echo for dialog-opening bare roots (ink parity)', async () => {
    const dialogStub = (name: string): SlashCommand =>
      stub({
        name,
        action: () => ({ type: 'message', messageType: 'info', content: name }),
      });
    const commands = ['help', 'settings', 'status', 'stats'].map(dialogStub);
    const { host } = await dispatch('/help', commands);
    expect(host.items.some((item) => item.type === 'user')).toBe(false);
  });

  it('keeps the invocation echo for work-performing subcommands', async () => {
    const commands = [
      stub({
        name: 'status',
        subCommands: [
          stub({
            name: 'paths',
            action: () => ({
              type: 'message',
              messageType: 'info',
              content: 'paths',
            }),
          }),
        ],
      }),
    ];
    const { host } = await dispatch('/status paths', commands);
    expect(host.items[0]).toMatchObject({
      type: 'user',
      text: '/status paths',
      sentToModel: false,
    });
  });
});

describe('shouldHideSlashCommandInvocation (slashCommandProcessor parity)', () => {
  const cmd = (name: string, kind = CommandKind.BUILT_IN): SlashCommand =>
    stub({ name, kind });

  it.each([
    'auth',
    'diff',
    'editor',
    'help',
    'settings',
    'status',
    'stats',
    'theme',
  ])('hides bare /%s', (root) => {
    expect(shouldHideSlashCommandInvocation(cmd(root), [root], '')).toBe(true);
  });

  it('keeps /theme visible under NO_COLOR (it prints feedback instead)', () => {
    const prev = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    try {
      expect(
        shouldHideSlashCommandInvocation(cmd('theme'), ['theme'], ''),
      ).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = prev;
    }
  });

  it.each([
    ['effort', ''],
    ['statusline', ''],
    ['model', ''],
    ['model', '--fast'],
    ['model', '--vision --global'],
  ])('hides bare /%s %j (picker-only)', (root, args) => {
    expect(shouldHideSlashCommandInvocation(cmd(root), [root], args)).toBe(
      true,
    );
  });

  it.each([
    ['model', 'qwen-max'],
    ['model', '--fast qwen3-coder-flash'],
    ['effort', 'high'],
    ['statusline', 'show'],
  ])('keeps /%s %j (work-performing)', (root, args) => {
    expect(shouldHideSlashCommandInvocation(cmd(root), [root], args)).toBe(
      false,
    );
  });

  it('never hides non-builtin commands', () => {
    expect(
      shouldHideSlashCommandInvocation(
        cmd('help', CommandKind.SKILL),
        ['help'],
        '',
      ),
    ).toBe(false);
    expect(shouldHideSlashCommandInvocation(undefined, ['help'], '')).toBe(
      false,
    );
  });
});

describe('canRunDuringStreaming (ink AppContainer fast path)', () => {
  it('reports the command opt-in flag', () => {
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(host, services, [
      stub({ name: 'help', canRunDuringStreaming: true }),
      stub({ name: 'clear' }),
    ]);
    expect(dispatcher.canRunDuringStreaming('/help')).toBe(true);
    expect(dispatcher.canRunDuringStreaming('/clear')).toBe(false);
    expect(dispatcher.canRunDuringStreaming('not a command')).toBe(false);
  });
});

describe('startup-window registry self-heal', () => {
  beforeEach(() => {
    loadInteractiveCommandsMock.mockReset();
  });

  const skillCommand = (): SlashCommand =>
    stub({
      name: 'qc-helper',
      kind: CommandKind.SKILL,
      action: () => ({
        type: 'message',
        messageType: 'info',
        content: 'expanded',
      }),
    });

  // The startup race attaches the first dispatcher before
  // config.initialize() finishes: the registry has the builtin commands
  // but no skills, so /qc-helper fails to resolve.
  const servicesWithSkillManager = (getSkillManager: () => object | null) => ({
    ...services,
    config: {
      getSkillManager,
    } as unknown as Config,
  });

  it('reloads the registry when a command fails to resolve instead of reporting Unknown', async () => {
    loadInteractiveCommandsMock.mockResolvedValue([skillCommand()]);
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      servicesWithSkillManager(() => ({})),
      [stub({ name: 'help' })],
    );

    const outcome = await dispatcher.handle('/qc-helper fix the issue');

    expect(outcome).toEqual({ kind: 'handled' });
    expect(loadInteractiveCommandsMock).toHaveBeenCalledTimes(1);
    expect(host.items.at(-1)).toMatchObject({
      type: 'info',
      text: 'expanded',
    });
  });

  it('waits for the skill manager to appear before reloading the registry', async () => {
    loadInteractiveCommandsMock.mockResolvedValue([skillCommand()]);
    const host = createFakeHost();
    let skillManager: object | null = null;
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      servicesWithSkillManager(() => skillManager),
      [],
    );

    vi.useFakeTimers();
    try {
      const pending = dispatcher.handle('/qc-helper wait');
      // While config.initialize() is still in flight, the reload must
      // not run against the incomplete state.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(loadInteractiveCommandsMock).not.toHaveBeenCalled();
      skillManager = {};
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toEqual({ kind: 'handled' });
    } finally {
      vi.useRealTimers();
    }
    expect(loadInteractiveCommandsMock).toHaveBeenCalledTimes(1);
  });

  it('retries once per dispatcher and reuses the reloaded registry', async () => {
    loadInteractiveCommandsMock.mockResolvedValue([skillCommand()]);
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      servicesWithSkillManager(() => ({})),
      [],
    );

    expect(await dispatcher.handle('/qc-helper one')).toEqual({
      kind: 'handled',
    });
    // The second dispatch resolves from the reloaded registry: the
    // startup retry is one-shot, so no further loader call happens.
    expect(await dispatcher.handle('/qc-helper two')).toEqual({
      kind: 'handled',
    });
    expect(loadInteractiveCommandsMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the Unknown message when there is no config to reload from', async () => {
    const { outcome, host } = await dispatch('/nope', []);
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items.at(-1)).toMatchObject({
      type: 'error',
      text: 'Unknown command: /nope',
    });
    expect(loadInteractiveCommandsMock).not.toHaveBeenCalled();
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

  it('reveals the hidden /model invocation when the command emits a message (ink revealHiddenInvocation parity)', async () => {
    const commands = [
      stub({
        name: 'model',
        // Bare `/model` is picker-only (hidden invocation), but the
        // command can still reject its arguments / environment and return
        // a message — the invocation echo must then appear paired with it.
        action: () => ({
          type: 'message',
          messageType: 'error',
          content: 'bad model id',
        }),
      }),
    ];
    const { outcome, host } = await dispatch('/model', commands);
    expect(outcome).toEqual({ kind: 'handled' });
    expect(host.items).toHaveLength(2);
    expect(host.items[0]).toMatchObject({ type: 'user', text: '/model' });
    expect(host.items[1]).toMatchObject({
      type: 'error',
      text: 'bad model id',
    });
  });

  it('message results are recorded in the chat-recording output phase (ink parity)', async () => {
    const recordSlashCommand = vi.fn();
    const config = {
      getChatRecordingService: () => ({ recordSlashCommand }),
    } as unknown as Config;
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
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      { ...services, config },
      commands,
    );
    await dispatcher.handle('/warn');
    expect(recordSlashCommand).toHaveBeenCalledTimes(2);
    const resultPhase = recordSlashCommand.mock.calls[1][0];
    expect(resultPhase.phase).toBe('result');
    expect(resultPhase.outputHistoryItems).toEqual([
      { type: 'warning', text: 'careful' },
    ]);
  });

  it('submit_prompt outcomes carry refreshContextFilesOnWrite (ink parity)', async () => {
    const commands = [
      stub({
        name: 'memory-add',
        action: () => ({
          type: 'submit_prompt',
          content: 'remember this',
          refreshContextFilesOnWrite: true,
        }),
      }),
      stub({
        name: 'plain',
        action: () => ({
          type: 'submit_prompt',
          content: 'plain prompt',
        }),
      }),
    ];
    const marked = await dispatch('/memory-add remember this', commands);
    expect(marked.outcome).toMatchObject({
      kind: 'submit_prompt',
      refreshContextFilesOnWrite: true,
    });
    const unmarked = await dispatch('/plain', commands);
    expect(unmarked.outcome).toMatchObject({ kind: 'submit_prompt' });
    expect(
      (unmarked.outcome as { refreshContextFilesOnWrite?: boolean })
        .refreshContextFilesOnWrite,
    ).toBeUndefined();
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

  it('/resume <id> awaits handleResume', async () => {
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
    ];
    const resume = await dispatch('/resume', commands);
    expect(resume.outcome).toEqual({ kind: 'handled' });
    expect(resume.host.resumedSessions).toEqual(['s-9']);

    const picker = await dispatch('/resume-picker', commands);
    expect(picker.outcome).toEqual({
      kind: 'open_dialog',
      request: { dialog: 'resume', matchedSessions: [] },
    });
  });

  it('/branch awaits handleBranch', async () => {
    // Gate is held closed. If dispatch properly awaits handleBranch, its promise
    // stays pending. If dispatch uses void, it resolves immediately.
    let resolveHandleBranch!: () => void;
    const handleBranchGate = new Promise<void>((res) => {
      resolveHandleBranch = res;
    });
    const branchNames: Array<string | undefined> = [];
    const host = createFakeHost();
    host.handleBranch = async (name) => {
      await handleBranchGate;
      branchNames.push(name);
    };

    const commands = [
      stub({
        name: 'branch',
        action: () => ({ type: 'dialog', dialog: 'branch', name: 'wip' }),
      }),
    ];
    const dispatcher = new OpenTuiSlashDispatcher(host, services, commands);

    const handlePromise = dispatcher.handle('/branch');

    // Race: if dispatch did NOT await handleBranch, it already resolved and wins.
    // If dispatch IS awaiting, the race times out (undefined sentinel wins).
    const sentinel = Symbol('pending');
    const raceResult = await Promise.race([
      handlePromise.then(() => 'resolved'),
      Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => sentinel),
    ]);

    // dispatch must still be pending (blocked on the gate) — not yet resolved.
    expect(raceResult).toBe(sentinel);

    // Now unblock and let everything complete.
    resolveHandleBranch();
    const outcome = await handlePromise;
    expect(outcome).toEqual({ kind: 'handled' });
    expect(branchNames).toEqual(['wip']);
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
      hiddenInvocation: false,
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

  it('records hiddenInvocation=true for bare picker invocations (ink parity)', async () => {
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
          name: 'settings',
          action: () => undefined,
        }),
      ],
    );

    await dispatcher.handle('/settings');
    expect(recordSlashCommand).toHaveBeenCalledTimes(2);
    expect(recordSlashCommand.mock.calls[0][0]).toEqual({
      phase: 'invocation',
      rawCommand: '/settings',
      sentToModel: false,
      hiddenInvocation: true,
    });
    // The hidden invocation never echoed, so the result phase has no output.
    expect(recordSlashCommand.mock.calls[1][0].outputHistoryItems).toEqual([]);
  });

  it('skips recording for the built-in /advisor by identity (ink parity)', async () => {
    const recordSlashCommand = vi.fn();
    const config = {
      getChatRecordingService: () => ({ recordSlashCommand }),
    } as unknown as Config;
    const host = createFakeHost();
    const advisorAction = (): SlashCommandActionReturn => ({
      type: 'message',
      messageType: 'info',
      content: 'advisor says hi',
    });
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      { ...services, config },
      [
        stub({ name: 'advisor', action: advisorAction }),
        // A user-defined command shadowing the name is NOT the built-in and
        // must still be recorded.
        {
          ...stub({ name: 'advisor', action: advisorAction }),
          kind: CommandKind.SKILL,
        },
      ],
    );

    await dispatcher.handle('/advisor');
    expect(recordSlashCommand).not.toHaveBeenCalled();

    // Re-dispatch through the non-built-in shadow (remove the built-in from
    // the registry by dispatching with only the shadow installed).
    recordSlashCommand.mockClear();
    const shadowOnly = new OpenTuiSlashDispatcher(
      createFakeHost(),
      { ...services, config },
      [
        {
          ...stub({ name: 'advisor', action: advisorAction }),
          kind: CommandKind.SKILL,
        },
      ],
    );
    await shadowOnly.handle('/advisor');
    expect(recordSlashCommand).toHaveBeenCalled();
  });
});

describe('extension refresh subscription (ink processor parity)', () => {
  it('subscribes to the shared ExtensionRefreshState and surfaces reload notices', () => {
    const extensionRefreshState = new ExtensionRefreshState();
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      { ...services, extensionRefreshState },
      [],
    );

    extensionRefreshState.markExtensionsChanged();
    expect(
      host.items.some(
        (item) =>
          item.type === 'info' &&
          item.text ===
            'Extensions changed on disk. Run /reload-plugins to apply updates.',
      ),
    ).toBe(true);

    extensionRefreshState.markExtensionsReloadFailed();
    expect(
      host.items.some(
        (item) =>
          item.type === 'info' &&
          item.text ===
            'Extension reload did not complete. Run /reload-plugins to try again.',
      ),
    ).toBe(true);

    dispatcher.dispose();
    extensionRefreshState.resetForTesting();
    const itemsAfterDispose = host.items.length;
    extensionRefreshState.markExtensionsChanged();
    expect(host.items.length).toBe(itemsAfterDispose);
  });
});
