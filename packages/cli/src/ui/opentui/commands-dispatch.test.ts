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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SlashCommandStatus,
  ToolConfirmationOutcome,
  makeFakeConfig,
} from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  CommandKind,
  type SlashCommand,
  type SlashCommandActionReturn,
} from '../commands/types.js';
import { quitCommand } from '../commands/quitCommand.js';
import { cdCommand } from '../commands/cdCommand.js';
import type { HistoryItem } from '../types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { LoadedSettings } from '../../config/settings.js';
import { resetTrustedFoldersForTesting } from '../../config/trustedFolders.js';
import { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import {
  OpenTuiSlashDispatcher,
  shouldHideSlashCommandInvocation,
  type OpenTuiDispatchOutcome,
} from './commands-dispatch.js';
import type { OpenTuiCommandHost } from './commands-context.js';
import * as interactiveMods from '../../services/interactive-mod-session.js';
import { helpCommand } from '../commands/helpCommand.js';
import { clearCommand } from '../commands/clearCommand.js';
import { vimCommand } from '../commands/vimCommand.js';
import {
  OpenTuiSlashGateway,
  normalizeQuitSubmission,
} from './slash-gateway.js';

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
    loadHistory: (history) => {
      items.splice(0, items.length, ...history);
      push('loadHistory');
    },
    resetTranscript: () => push('resetTranscript'),
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
    isStreaming: () => false,
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
  it.each(['unchanged', 'changed'] as const)(
    'keeps command history current across an await when history is %s',
    async (kind) => {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let before: readonly HistoryItem[] | undefined;
      let after: readonly HistoryItem[] = [];
      const recordSlashCommand = vi.fn();
      const config = makeFakeConfig({});
      config.getChatRecordingService = () =>
        ({ recordSlashCommand }) as unknown as ReturnType<
          Config['getChatRecordingService']
        >;
      const host = createFakeHost();
      host.addItem({ type: 'info', text: 'before-await' }, 1);
      const command = stub({
        name: 'history-getter',
        action: async (context) => {
          before = context.ui.history;
          await held;
          after = context.ui.history;
          context.ui.addItem({ type: 'info', text: 'own-result' }, 3);
        },
      });
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        [command],
      );
      const pending = dispatcher.handle('/history-getter');
      try {
        await vi.waitFor(() => expect(before).toBeDefined());
        expect(before).toEqual(host.getHistory());
        if (kind === 'changed')
          host.addItem({ type: 'info', text: 'after-await' }, 2);
        const expected = [...host.getHistory()];
        release();
        expect(await pending).toEqual({ kind: 'handled' });
        expect(after).toEqual(expected);
        expect(after.every((item, index) => item === expected[index])).toBe(
          true,
        );
        expect(
          host.items.filter(
            (item) => 'text' in item && item.text === 'own-result',
          ),
        ).toHaveLength(1);
        expect(
          recordSlashCommand.mock.calls.find(
            ([value]) => value.phase === 'result',
          )?.[0].outputHistoryItems,
        ).toEqual([{ type: 'info', text: 'own-result' }]);
      } finally {
        release();
        try {
          await pending;
        } finally {
          dispatcher.dispose();
        }
      }
    },
  );
  it.each([
    ['startup', 'Error'],
    ['startup', 'string'],
    ['command', 'Error'],
    ['command', 'string'],
  ])(
    'sanitizes Mod %s errors thrown as %s before display and recording',
    async (phase, errorType) => {
      const message =
        '\u001b[31mMod failed\u001b[0m\u0007\u0008\u007f\u009f\u202e\n\t检查配置 \u001b]8;;https://example.invalid\u0007details\u001b]8;;\u0007\u2066\u2069';
      const error = errorType === 'Error' ? new Error(message) : message;
      const recordSlashCommand = vi.fn();
      const config = {
        initialize: vi.fn().mockResolvedValue(undefined),
        getChatRecordingService: () => ({ recordSlashCommand }),
      } as unknown as Config;
      const initialize = vi.fn().mockImplementation(async () => {
        if (phase === 'startup') throw error;
      });
      const owner = vi
        .spyOn(interactiveMods, 'getInteractiveModSession')
        .mockReturnValue({
          initialize,
        } as unknown as interactiveMods.InteractiveModSession);
      const action = vi.fn().mockRejectedValue(error);
      const host = createFakeHost();
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        [stub({ name: 'test', kind: CommandKind.FILE, action })],
      );
      try {
        expect(await dispatcher.handle('/test')).toEqual({ kind: 'handled' });
        expect(initialize).toHaveBeenCalledOnce();
        expect(action).toHaveBeenCalledTimes(phase === 'startup' ? 0 : 1);
        const expected = {
          type: 'error',
          text: 'Mod failed\n\t检查配置 details',
        };
        expect(host.items).toContainEqual(expect.objectContaining(expected));
        expect(recordSlashCommand).toHaveBeenCalledWith({
          phase: 'result',
          rawCommand: '/test',
          outputHistoryItems: [expected],
        });
        expect(error instanceof Error ? error.message : error).toBe(message);
      } finally {
        dispatcher.dispose();
        owner.mockRestore();
      }
    },
  );

  it.each([
    ['/compress', 'compress', CommandKind.BUILT_IN, false],
    ['/summarize', 'compress', CommandKind.BUILT_IN, false],
    ['/help', 'help', CommandKind.FILE, false],
    ['/exit', 'quit', CommandKind.FILE, false],
    ['/alpha /beta work', 'alpha', CommandKind.SKILL, false],
    ['/help', 'help', CommandKind.BUILT_IN, true],
    ['/exit', 'quit', CommandKind.BUILT_IN, true],
  ])(
    'allows only actual recovery commands after startup failure: %s (%s, %s)',
    async (input, name, kind, recovery) => {
      const error = new Error('Config startup failed');
      const config = {
        initialize: vi.fn().mockRejectedValue(error),
        getGeminiClient: () => undefined,
        getSessionId: () => 'mod-startup-failed',
      } as unknown as Config;
      const failStartup = vi.fn();
      const owner = vi
        .spyOn(interactiveMods, 'getInteractiveModSession')
        .mockReturnValue({
          ready: new Promise(() => {}),
          failStartup,
        } as unknown as interactiveMods.InteractiveModSession);
      const action = vi
        .fn()
        .mockResolvedValue({ type: 'submit_prompt', content: 'must not run' });
      const command = recovery
        ? name === 'help'
          ? helpCommand
          : quitCommand
        : stub({
            name,
            kind,
            altNames:
              name === 'compress'
                ? ['summarize']
                : name === 'quit'
                  ? ['exit']
                  : undefined,
            action,
          });
      const host = createFakeHost();
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        [command, stub({ name: 'beta', kind: CommandKind.SKILL, action })],
      );
      try {
        const outcome = await dispatcher.handle(input);
        expect(action).not.toHaveBeenCalled();
        expect(failStartup).toHaveBeenCalledTimes(recovery ? 0 : 1);
        if (recovery) {
          expect(outcome).toMatchObject({
            kind: name === 'help' ? 'open_dialog' : 'quit',
          });
          expect(config.initialize).not.toHaveBeenCalled();
        } else {
          expect(outcome).toEqual({ kind: 'handled' });
          expect(host.items).toContainEqual(
            expect.objectContaining({
              type: 'error',
              text: 'Config startup failed',
            }),
          );
        }
      } finally {
        dispatcher.dispose();
        owner.mockRestore();
      }
    },
  );

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

  it('hides only the bare /output-style invocation', async () => {
    const commands = [
      stub({
        name: 'output-style',
        action: (_context, args) =>
          args
            ? { type: 'message', messageType: 'info', content: args }
            : { type: 'dialog', dialog: 'output-style' },
      }),
    ];

    const { host: bareHost } = await dispatch('/output-style', commands);
    expect(bareHost.items.some((item) => item.type === 'user')).toBe(false);

    const { host: namedHost } = await dispatch(
      '/output-style Concise',
      commands,
    );
    expect(namedHost.items[0]).toMatchObject({
      type: 'user',
      text: '/output-style Concise',
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
    ['output-style', ''],
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
    ['output-style', 'Concise'],
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

describe('mustDeferDuringStreaming (ink AppContainer mid-turn gate)', () => {
  it('defers the slash submissions a running turn must not race', () => {
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(host, services, [
      stub({ name: 'help', canRunDuringStreaming: true }),
      stub({ name: 'clear' }),
    ]);
    expect(dispatcher.mustDeferDuringStreaming('/help')).toBe(false);
    expect(dispatcher.mustDeferDuringStreaming('/clear')).toBe(true);
    expect(dispatcher.mustDeferDuringStreaming('/nope')).toBe(true);
    expect(dispatcher.mustDeferDuringStreaming('not a command')).toBe(false);
    expect(dispatcher.mustDeferDuringStreaming('/some/path/to/file')).toBe(
      false,
    );
    expect(dispatcher.mustDeferDuringStreaming('?btw side question')).toBe(
      false,
    );
  });

  it('never defers quit, so a mid-turn exit stops the responding stream', async () => {
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(host, services, [
      quitCommand,
      stub({ name: 'clear' }),
    ]);
    // The real built-in, reached through its altName as well: the exemption has
    // to come from the command the parser resolved, not the typed token.
    expect(dispatcher.mustDeferDuringStreaming('/quit')).toBe(false);
    expect(dispatcher.mustDeferDuringStreaming('  /exit  ')).toBe(false);
    expect(dispatcher.mustDeferDuringStreaming('/clear')).toBe(true);
    // What the gate lets through is an exit, not a prompt handed to the model.
    expect(await dispatcher.handle('/exit')).toMatchObject({ kind: 'quit' });
  });
});

describe('command registry owner publication', () => {
  it.each(['session', 'target'] as const)(
    'keeps the healthy registry after a held load (%s)',
    async (change) => {
      loadInteractiveCommandsMock.mockReset();
      const config = makeFakeConfig({
        chatRecording: false,
        usageStatisticsEnabled: false,
      });
      let session = config.getSessionId();
      let target = config.getTargetDir();
      const sessionRead = vi
        .spyOn(config, 'getSessionId')
        .mockImplementation(() => session);
      const targetRead = vi
        .spyOn(config, 'getTargetDir')
        .mockImplementation(() => target);
      const oldAction = vi.fn(
        (): SlashCommandActionReturn => ({
          type: 'message',
          messageType: 'info',
          content: 'OLD_REGISTRY_ACTION',
        }),
      );
      const healthyAction = vi.fn(
        (): SlashCommandActionReturn => ({
          type: 'message',
          messageType: 'info',
          content: 'HEALTHY_REGISTRY_ACTION',
        }),
      );
      const oldCommands = [stub({ name: 'registry-owned', action: oldAction })];
      const healthyCommands = [
        stub({ name: 'registry-owned', action: healthyAction }),
      ];
      let releaseOld!: (commands: SlashCommand[]) => void;
      const held = new Promise<SlashCommand[]>((resolve) => {
        releaseOld = resolve;
      });
      const host = createFakeHost();
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        healthyCommands,
      );
      const gateway = new OpenTuiSlashGateway();
      gateway.attach(dispatcher);
      loadInteractiveCommandsMock
        .mockReturnValueOnce(held)
        .mockResolvedValue(healthyCommands);
      const pending = dispatcher.loadCommands().catch(() => undefined);
      try {
        expect(loadInteractiveCommandsMock).toHaveBeenCalledExactlyOnceWith(
          config,
          undefined,
          services.settings,
        );
        if (change === 'session') session = 'healthy-successor-session';
        else target = '/owned/healthy-successor-workspace';
        await dispatcher.loadCommands();
        expect(await gateway.dispatch('/registry-owned')).toEqual({
          kind: 'dispatched',
          outcome: { kind: 'handled' },
        });
        expect(host.items.at(-1)).toMatchObject({
          type: 'info',
          text: 'HEALTHY_REGISTRY_ACTION',
        });
        host.items.length = 0;
        releaseOld(oldCommands);
        await pending;
        expect(await gateway.dispatch('/registry-owned')).toEqual({
          kind: 'dispatched',
          outcome: { kind: 'handled' },
        });
        expect(host.items.at(-1)).toMatchObject({
          type: 'info',
          text: 'HEALTHY_REGISTRY_ACTION',
        });
        expect(dispatcher.commands).toEqual(healthyCommands);
        expect(oldAction).not.toHaveBeenCalled();
        expect(healthyAction).toHaveBeenCalledTimes(2);
      } finally {
        releaseOld(healthyCommands);
        await pending;
        dispatcher.dispose();
        sessionRead.mockRestore();
        targetRead.mockRestore();
      }
    },
  );
});

describe('startup registry request ownership', () => {
  it.each(['session', 'target'] as const)(
    'does not execute a successor action for a held old request (%s)',
    async (change) => {
      loadInteractiveCommandsMock.mockReset();
      const config = makeFakeConfig({
        chatRecording: false,
        usageStatisticsEnabled: false,
      });
      let session = config.getSessionId();
      let target = config.getTargetDir();
      const sessionRead = vi
        .spyOn(config, 'getSessionId')
        .mockImplementation(() => session);
      const targetRead = vi
        .spyOn(config, 'getTargetDir')
        .mockImplementation(() => target);
      const skillManagerRead = vi
        .spyOn(config, 'getSkillManager')
        .mockReturnValue(
          {} as NonNullable<ReturnType<Config['getSkillManager']>>,
        );
      const oldAction = vi.fn(
        (): SlashCommandActionReturn => ({
          type: 'message',
          messageType: 'info',
          content: 'OLD_SELFHEAL_ACTION',
        }),
      );
      const successorAction = vi.fn(
        (): SlashCommandActionReturn => ({
          type: 'message',
          messageType: 'info',
          content: 'HEALTHY_SUCCESSOR_ACTION',
        }),
      );
      const oldCommands = [
        stub({ name: 'workspace-action', action: oldAction }),
      ];
      const healthyCommands = [
        stub({ name: 'workspace-action', action: successorAction }),
      ];
      let releaseOld!: (commands: SlashCommand[]) => void;
      const held = new Promise<SlashCommand[]>((resolve) => {
        releaseOld = resolve;
      });
      loadInteractiveCommandsMock
        .mockReturnValueOnce(held)
        .mockResolvedValue(healthyCommands);
      const host = createFakeHost();
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        [],
      );
      const gateway = new OpenTuiSlashGateway();
      gateway.attach(dispatcher);
      const pending = gateway.dispatch('/workspace-action');
      try {
        await vi.waitFor(() =>
          expect(loadInteractiveCommandsMock).toHaveBeenCalledOnce(),
        );
        expect(gateway.isBusy()).toBe(true);
        if (change === 'session') session = 'healthy-successor-session';
        else target = '/owned/healthy-successor-workspace';
        await dispatcher.loadCommands();
        expect(dispatcher.commands).toEqual(healthyCommands);
        releaseOld(oldCommands);
        expect(await pending).toEqual({
          kind: 'dispatched',
          outcome: { kind: 'handled' },
        });
        expect(gateway.isBusy()).toBe(false);
        const oldCallsBeforeFresh = oldAction.mock.calls.length;
        const successorCallsFromOldRequest = successorAction.mock.calls.length;
        host.items.length = 0;
        expect(await gateway.dispatch('/workspace-action')).toEqual({
          kind: 'dispatched',
          outcome: { kind: 'handled' },
        });
        expect(host.items.at(-1)).toMatchObject({
          type: 'info',
          text: 'HEALTHY_SUCCESSOR_ACTION',
        });
        expect(successorCallsFromOldRequest).toBe(0);
        expect(oldCallsBeforeFresh).toBe(0);
        expect(successorAction).toHaveBeenCalledOnce();
      } finally {
        releaseOld(healthyCommands);
        await pending.catch(() => undefined);
        dispatcher.dispose();
        skillManagerRead.mockRestore();
        sessionRead.mockRestore();
        targetRead.mockRestore();
      }
    },
  );
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
      getSessionId: () => 'startup-registry-session',
      getTargetDir: () => '/owned/startup-registry-workspace',
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

  it('a signal aborted before the action race skips the action entirely (R3-5)', async () => {
    // ESC lands while the registry reload is still in flight: by the time
    // the re-parse reaches the action race the signal is already aborted,
    // and a late 'abort' listener never fires — the action's side effects
    // must not run on the cancelled submission.
    const action = vi.fn(
      (): SlashCommandActionReturn => ({
        type: 'message',
        messageType: 'info',
        content: 'side effects ran',
      }),
    );
    let resolveLoad: (commands: SlashCommand[]) => void = () => {};
    loadInteractiveCommandsMock.mockReturnValue(
      new Promise<SlashCommand[]>((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      servicesWithSkillManager(() => ({})),
      [stub({ name: 'help' })],
    );

    const pending = dispatcher.handle('/greet world');
    dispatcher.cancel();
    resolveLoad([stub({ name: 'greet', action })]);
    const outcome = await pending;

    expect(outcome).toEqual({ kind: 'handled' });
    expect(action).not.toHaveBeenCalled();
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

  it.each([
    [true, 'Entered Vim mode. Run /vim again to exit.'],
    [false, 'Exited Vim mode.'],
  ])(
    'preserves the shared /vim message and recording when enabled is %s',
    async (enabled, message) => {
      const toggleVimEnabled = vi.fn().mockResolvedValue(enabled);
      const recordSlashCommand = vi.fn();
      const config = {
        getChatRecordingService: () => ({ recordSlashCommand }),
      } as unknown as Config;
      const host = createFakeHost();
      host.toggleVimEnabled = toggleVimEnabled;
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        [vimCommand],
      );

      expect(await dispatcher.handle('/vim')).toEqual({ kind: 'handled' });
      expect(toggleVimEnabled).toHaveBeenCalledTimes(1);
      expect(host.items).toHaveLength(2);
      expect(host.items[0]).toMatchObject({ type: 'user', text: '/vim' });
      expect(host.items[1]).toMatchObject({ type: 'info', text: message });
      expect(recordSlashCommand).toHaveBeenCalledTimes(2);
      expect(recordSlashCommand).toHaveBeenNthCalledWith(1, {
        phase: 'invocation',
        rawCommand: '/vim',
        sentToModel: false,
        hiddenInvocation: false,
      });
      expect(recordSlashCommand).toHaveBeenNthCalledWith(2, {
        phase: 'result',
        rawCommand: '/vim',
        outputHistoryItems: [{ type: 'info', text: message }],
      });
    },
  );

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
      getSessionId: () => 'load-history-session',
      getLlmClient: () => ({ setHistory }),
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

  it.each([false, true])(
    'owns cancellation while durable recall is pending (cancel=%s)',
    async (cancel) => {
      const { Logger } = await import(
        '@qwen-code/qwen-code-core/core/logger.js'
      );
      const { Storage } = await import(
        '@qwen-code/qwen-code-core/config/storage.js'
      );
      const owned = fs.mkdtempSync(
        path.join(os.tmpdir(), 'slash-cancel-recall-'),
      );
      let finishLogging = () => {};
      const logging = new Promise<void>((resolve) => {
        finishLogging = resolve;
      });
      let enterLogger = () => {};
      const loggerEntered = new Promise<void>((resolve) => {
        enterLogger = resolve;
      });
      try {
        const storage = new Storage(
          path.join(owned, 'project'),
          path.join(owned, 'runtime'),
        );
        const logger = new Logger('deferred-command', storage);
        await logger.initialize();
        const logMessage = logger.logMessage.bind(logger);
        const log = vi
          .spyOn(logger, 'logMessage')
          .mockImplementationOnce(async (...args) => {
            enterLogger();
            await logging;
            return logMessage(...args);
          });
        const heldAction = vi.fn(() => ({
          type: 'message' as const,
          messageType: 'info' as const,
          content: 'held command completed',
        }));
        const nextAction = vi.fn(() => ({
          type: 'message' as const,
          messageType: 'info' as const,
          content: 'next command completed',
        }));
        const config = makeFakeConfig();
        const sessionId = config.getSessionId();
        const host = createFakeHost();
        const gateway = new OpenTuiSlashGateway();
        gateway.attach(
          new OpenTuiSlashDispatcher(host, { ...services, config, logger }, [
            stub({ name: 'held', action: heldAction }),
            stub({ name: 'next', action: nextAction }),
          ]),
        );
        const pending = gateway.dispatch('/held');
        try {
          await loggerEntered;
          expect(gateway.isBusy()).toBe(true);
          expect(heldAction).not.toHaveBeenCalled();
          if (cancel) gateway.cancel();
          finishLogging();
          const settlement = await pending;
          const firstBusy = gateway.isBusy();
          const firstCalls = heldAction.mock.calls.length;
          const firstProducedInfo = host.items.some(
            (item) => item.text === 'held command completed',
          );
          const successor = await gateway.dispatch('/next');
          expect(successor).toEqual({
            kind: 'dispatched',
            outcome: { kind: 'handled' },
          });
          expect(nextAction).toHaveBeenCalledOnce();
          expect(host.items.at(-1)).toMatchObject({
            text: 'next command completed',
          });
          expect(gateway.isBusy()).toBe(false);
          expect(config.getSessionId()).toBe(sessionId);
          expect(log).toHaveBeenCalledTimes(2);
          expect(settlement).toEqual({
            kind: 'dispatched',
            outcome: { kind: 'handled' },
          });
          expect(firstBusy).toBe(false);
          expect(firstCalls).toBe(cancel ? 0 : 1);
          expect(firstProducedInfo).toBe(!cancel);
        } finally {
          finishLogging();
          try {
            await pending;
          } finally {
            log.mockRestore();
          }
        }
      } finally {
        finishLogging();
        fs.rmSync(owned, { recursive: true, force: true });
      }
    },
  );

  it.each(['logger rejection', 'session change'] as const)(
    'releases recall ownership after %s without running the old action',
    async (change) => {
      const { Logger } = await import(
        '@qwen-code/qwen-code-core/core/logger.js'
      );
      const { Storage } = await import(
        '@qwen-code/qwen-code-core/config/storage.js'
      );
      const owned = fs.mkdtempSync(
        path.join(os.tmpdir(), 'slash-recall-owner-'),
      );
      let finishLogging = () => {};
      const logging = new Promise<void>((resolve) => {
        finishLogging = resolve;
      });
      let enterLogger = () => {};
      const loggerEntered = new Promise<void>((resolve) => {
        enterLogger = resolve;
      });
      try {
        const storage = new Storage(
          path.join(owned, 'project'),
          path.join(owned, 'runtime'),
        );
        const logger = new Logger('recall-owner', storage);
        await logger.initialize();
        const failure = new Error('owned recall write failed');
        const logMessage = logger.logMessage.bind(logger);
        const log = vi
          .spyOn(logger, 'logMessage')
          .mockImplementationOnce(async (...args) => {
            enterLogger();
            await logging;
            if (change === 'logger rejection') throw failure;
            return logMessage(...args);
          });
        const oldAction = vi.fn(() => ({
          type: 'message' as const,
          messageType: 'info' as const,
          content: 'old command completed',
        }));
        const nextAction = vi.fn(() => ({
          type: 'message' as const,
          messageType: 'info' as const,
          content: 'successor completed',
        }));
        const config = makeFakeConfig();
        let sessionId = config.getSessionId();
        const session = vi
          .spyOn(config, 'getSessionId')
          .mockImplementation(() => sessionId);
        const host = createFakeHost();
        const gateway = new OpenTuiSlashGateway();
        gateway.attach(
          new OpenTuiSlashDispatcher(host, { ...services, config, logger }, [
            stub({ name: 'old', action: oldAction }),
            stub({ name: 'next', action: nextAction }),
          ]),
        );
        const settlement = gateway.dispatch('/old').then(
          (outcome) => ({ outcome, error: undefined }),
          (error: unknown) => ({ outcome: undefined, error }),
        );
        try {
          await loggerEntered;
          expect(gateway.isBusy()).toBe(true);
          expect(oldAction).not.toHaveBeenCalled();
          if (change === 'session change') sessionId = 'successor-session';
          finishLogging();
          const result = await settlement;
          const firstBusy = gateway.isBusy();
          const firstProcessing = host.processingFlags.at(-1);
          const firstItems = [...host.items];
          const firstTelemetryCalls = logSlashCommandSpy.mock.calls.length;
          const successor = await gateway.dispatch('/next');
          expect(successor).toEqual({
            kind: 'dispatched',
            outcome: { kind: 'handled' },
          });
          expect(nextAction).toHaveBeenCalledOnce();
          expect(host.items.at(-1)).toMatchObject({
            text: 'successor completed',
          });
          expect(gateway.isBusy()).toBe(false);
          expect(host.processingFlags.at(-1)).toBe(false);
          expect(log).toHaveBeenCalledTimes(2);
          expect(oldAction).not.toHaveBeenCalled();
          expect(firstBusy).toBe(false);
          expect(firstProcessing).not.toBe(true);
          expect(firstItems).toEqual([]);
          expect(firstTelemetryCalls).toBe(0);
          if (change === 'logger rejection') {
            expect(result.error).toBe(failure);
            expect(result.outcome).toBeUndefined();
          } else {
            expect(result.error).toBeUndefined();
            expect(result.outcome).toEqual({
              kind: 'dispatched',
              outcome: { kind: 'handled' },
            });
            expect(config.getSessionId()).toBe('successor-session');
          }
        } finally {
          finishLogging();
          try {
            await settlement;
          } finally {
            log.mockRestore();
            session.mockRestore();
          }
        }
      } finally {
        finishLogging();
        fs.rmSync(owned, { recursive: true, force: true });
      }
    },
  );

  it.each(['/clear', '/reset', '/new'])(
    '%s retains input ownership through Mod shutdown and chat reset',
    async (input) => {
      let finishEnd = () => {};
      const ending = new Promise<void>((resolve) => {
        finishEnd = resolve;
      });
      let finishReset = () => {};
      const resetting = new Promise<void>((resolve) => {
        finishReset = resolve;
      });
      const syncSession = vi.fn(() => ending);
      const resetChat = vi.fn(() => resetting);
      const config = makeFakeConfig();
      vi.spyOn(config, 'initialize').mockResolvedValue();
      vi.spyOn(config, 'startNewSession').mockReturnValue('new-session');
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(undefined!);
      vi.spyOn(config, 'getLlmClient').mockReturnValue({
        resetChat,
      } as unknown as ReturnType<Config['getLlmClient']>);
      const owner = vi
        .spyOn(interactiveMods, 'getInteractiveModSession')
        .mockReturnValue({
          initialize: vi.fn().mockResolvedValue(undefined),
          syncSession,
          invalidateTools: vi.fn(),
          restoreTools: vi.fn().mockResolvedValue(undefined),
        } as unknown as interactiveMods.InteractiveModSession);
      const host = createFakeHost();
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        [clearCommand],
      );
      const gateway = new OpenTuiSlashGateway();
      gateway.attach(dispatcher);
      const pending = gateway.dispatch(input);
      try {
        await vi.waitFor(() =>
          expect(syncSession).toHaveBeenCalledWith('clear'),
        );
        gateway.cancel();
        await Promise.resolve();
        expect(gateway.isBusy()).toBe(true);
        expect(host.processingFlags.at(-1)).toBe(true);
        expect(
          host.items.some((item) => item.text === 'Command cancelled.'),
        ).toBe(false);
        expect(await gateway.dispatch('next prompt')).toMatchObject({
          kind: 'rejected',
        });
        expect(host.calls).not.toContain('clearItems');

        finishEnd();
        await vi.waitFor(() => expect(resetChat).toHaveBeenCalledOnce());
        gateway.cancel();
        await Promise.resolve();
        expect(gateway.isBusy()).toBe(true);
        expect(host.processingFlags.at(-1)).toBe(true);
        finishReset();
        await pending;
        expect(gateway.isBusy()).toBe(false);
        expect(host.processingFlags.at(-1)).toBe(false);
        expect(await gateway.dispatch('next prompt')).toEqual({
          kind: 'dispatched',
          outcome: false,
        });
      } finally {
        finishEnd();
        finishReset();
        await pending;
        owner.mockRestore();
      }
    },
  );

  it('keeps a file command named clear cancellable', async () => {
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(host, services, [
      stub({
        name: 'clear',
        kind: CommandKind.FILE,
        action: () => new Promise(() => {}),
      }),
    ]);
    const pending = dispatcher.handle('/clear');
    dispatcher.cancel();
    await expect(pending).resolves.toEqual({ kind: 'handled' });
    expect(host.processingFlags.at(-1)).toBe(false);
    expect(host.items.some((item) => item.text === 'Command cancelled.')).toBe(
      true,
    );
  });

  it('releases a failed clear and lets the next command cancel normally', async () => {
    const host = createFakeHost();
    const dispatcher = new OpenTuiSlashDispatcher(host, services, [
      {
        ...clearCommand,
        action: async () => {
          throw new Error('reset failed');
        },
      },
      stub({ name: 'compress', action: () => new Promise(() => {}) }),
    ]);
    const gateway = new OpenTuiSlashGateway();
    gateway.attach(dispatcher);
    await gateway.dispatch('/clear');
    expect(gateway.isBusy()).toBe(false);
    expect(host.items.at(-1)).toMatchObject({
      type: 'error',
      text: 'reset failed',
    });
    const pending = gateway.dispatch('/compress');
    await Promise.resolve();
    gateway.cancel();
    await pending;
    expect(gateway.isBusy()).toBe(false);
    expect(host.processingFlags.at(-1)).toBe(false);
    expect(host.items.at(-1)).toMatchObject({ text: 'Command cancelled.' });
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

  it('replays a latch set before mount once, not once per dispatcher', () => {
    const extensionRefreshState = new ExtensionRefreshState();
    // The watcher latches during startup, before any dispatcher exists.
    extensionRefreshState.markExtensionsChanged();

    const notice =
      'Extensions changed on disk. Run /reload-plugins to apply updates.';
    const count = (host: ReturnType<typeof createFakeHost>) =>
      host.items.filter((item) => item.text === notice).length;

    // The shell rebuilds the dispatcher whenever its host identity changes,
    // and the latch survives that rebuild — both must not re-announce it.
    const first = createFakeHost();
    new OpenTuiSlashDispatcher(
      first,
      { ...services, extensionRefreshState },
      [],
    ).dispose();
    expect(count(first)).toBe(1);

    const second = createFakeHost();
    new OpenTuiSlashDispatcher(
      second,
      { ...services, extensionRefreshState },
      [],
    ).dispose();
    expect(count(second)).toBe(0);
  });
});

describe('isIdleRef parity (command actions see pre-dispatch idle state)', () => {
  // Mirrors the REAL OpenTuiCommandHost (opentui-host.ts): `isIdle()` is
  // computed from the same `processing`/`streaming` flags the setters change,
  // unlike `createFakeHost()`, whose `isIdle` is a constant.
  function createProcessingLinkedHost(initiallyIdle: boolean) {
    let processing = !initiallyIdle;
    let streaming = false;
    return {
      isIdle: () => !processing && !streaming,
      isStreaming: () => streaming,
      setIsProcessing: (flag: boolean) => {
        processing = flag;
      },
      setStreaming: (flag: boolean) => {
        streaming = flag;
      },
    };
  }

  // Services for the REAL cdCommand.ts action, so the guard's own error
  // message is verified too.
  function realCdServices(
    relocateWorkingDirectory: ReturnType<typeof vi.fn>,
    merged: object = {},
  ) {
    return {
      config: {
        getTargetDir: () => os.tmpdir(),
        isRestrictiveSandbox: () => false,
        relocateWorkingDirectory,
        getLlmClient: () => ({
          addWorkingDirectoryChangedContext: vi
            .fn()
            .mockResolvedValue(undefined),
        }),
      } as unknown as Config,
      settings: { merged } as unknown as LoadedSettings,
      logger: null,
    };
  }

  it('real /cd relocates the working directory when the host was idle before dispatch', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-cd-dispatch-'),
    );
    try {
      const relocateWorkingDirectory = vi.fn().mockResolvedValue({});
      const host = createFakeHost();
      Object.assign(host, createProcessingLinkedHost(true));
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        realCdServices(relocateWorkingDirectory),
        [cdCommand],
      );

      const outcome = await dispatcher.handle(`/cd ${targetDir}`);

      expect(outcome).toEqual({ kind: 'handled' });
      expect(relocateWorkingDirectory).toHaveBeenCalled();
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  it('real /cd is refused and nothing relocates when the host was busy before dispatch', async () => {
    const targetDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-cd-dispatch-'),
    );
    try {
      const relocateWorkingDirectory = vi.fn().mockResolvedValue({});
      const host = createFakeHost();
      Object.assign(host, createProcessingLinkedHost(false));
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        realCdServices(relocateWorkingDirectory),
        [cdCommand],
      );

      const outcome = await dispatcher.handle(`/cd ${targetDir}`);

      expect(outcome).toEqual({ kind: 'handled' });
      expect(relocateWorkingDirectory).not.toHaveBeenCalled();
      expect(host.items.at(-1)).toMatchObject({
        type: 'error',
        text: 'Cannot change directory while a response or tool call is in progress.',
      });
    } finally {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
  });

  // Folder trust on, backed by a throwaway trust file, so the real /cd asks
  // before moving into the untrusted target.
  const folderTrustOn = { security: { folderTrust: { enabled: true } } };
  async function withUntrustedDir(
    run: (targetDir: string) => Promise<void>,
  ): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cd-dispatch-'));
    const prev = process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
    try {
      const targetDir = path.join(tmpDir, 'untrusted');
      fs.mkdirSync(targetDir);
      process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = path.join(
        tmpDir,
        'trustedFolders.json',
      );
      resetTrustedFoldersForTesting();
      await run(targetDir);
    } finally {
      if (prev === undefined) {
        delete process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'];
      } else {
        process.env['QWEN_CODE_TRUSTED_FOLDERS_PATH'] = prev;
      }
      resetTrustedFoldersForTesting();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('real /cd into an untrusted folder relocates once the user accepts the trust prompt', () =>
    withUntrustedDir(async (targetDir) => {
      const relocateWorkingDirectory = vi.fn().mockResolvedValue({});
      const host = createFakeHost();
      Object.assign(host, createProcessingLinkedHost(true));
      setActionConfirmation(host, true);
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        realCdServices(relocateWorkingDirectory, folderTrustOn),
        [cdCommand],
      );

      await dispatcher.handle(`/cd ${targetDir}`);

      const realTargetDir = await fs.promises.realpath(targetDir);
      expect(host.actionConfirmations).toBe(1);
      expect(host.items.at(-1)).toMatchObject({
        type: 'info',
        text: `Moved to ${realTargetDir}.`,
      });
      expect(relocateWorkingDirectory).toHaveBeenCalledWith(
        realTargetDir,
        realTargetDir,
      );
    }));

  it('real /cd is refused when a stream starts while the trust prompt is open', () =>
    withUntrustedDir(async (targetDir) => {
      const relocateWorkingDirectory = vi.fn().mockResolvedValue({});
      const host = createFakeHost();
      const linkedHost = createProcessingLinkedHost(true);
      Object.assign(host, linkedHost);
      let prompts = 0;
      host.presentActionConfirmation = async () => {
        prompts += 1;
        linkedHost.setStreaming(true);
        return true;
      };
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        realCdServices(relocateWorkingDirectory, folderTrustOn),
        [cdCommand],
      );

      await dispatcher.handle(`/cd ${targetDir}`);

      expect(prompts).toBe(1);
      expect(relocateWorkingDirectory).not.toHaveBeenCalled();
      expect(host.items.at(-1)).toMatchObject({
        type: 'error',
        text: 'Cannot change directory while a response or tool call is in progress.',
      });
    }));

  // Asks for confirmation on the first pass, then reports what the
  // confirmed re-run sees.
  const confirmingProbe = (
    confirmation: 'confirm_action' | 'confirm_shell_commands',
  ) => {
    let firstRun = true;
    return stub({
      name: 'probe',
      action: (context): SlashCommandActionReturn => {
        if (firstRun) {
          firstRun = false;
          return confirmation === 'confirm_action'
            ? {
                type: 'confirm_action',
                prompt: 'Proceed?',
                originalInvocation: { raw: '/probe' },
              }
            : {
                type: 'confirm_shell_commands',
                commandsToConfirm: ['ls'],
                originalInvocation: { raw: '/probe' },
              };
        }
        return {
          type: 'message',
          messageType: 'info',
          content: `isIdle=${context.ui.isIdleRef.current}`,
        };
      },
    });
  };

  it.each([
    ['confirm_action', true],
    ['confirm_action', false],
    ['confirm_shell_commands', true],
    ['confirm_shell_commands', false],
  ] as const)(
    'the re-run after an accepted %s sees the pre-dispatch idle state (%s)',
    async (confirmation, initiallyIdle) => {
      const host = createFakeHost();
      Object.assign(host, createProcessingLinkedHost(initiallyIdle));
      setActionConfirmation(host, true);
      setShellResolution(host, {
        outcome: ToolConfirmationOutcome.ProceedOnce,
        approvedCommands: ['ls'],
      });
      const dispatcher = new OpenTuiSlashDispatcher(host, services, [
        confirmingProbe(confirmation),
      ]);

      await dispatcher.handle('/probe');

      expect(host.items.at(-1)).toMatchObject({
        type: 'info',
        text: `isIdle=${initiallyIdle}`,
      });
    },
  );

  it('renders a goal mutation card when the host was idle before dispatch', async () => {
    const snapshot = { v: 2, goal: { objective: 'x' }, activity: 'idle' };
    const pauseCommand = stub({
      name: 'goal',
      action: () =>
        ({
          type: 'goal_control',
          operation: { kind: 'pause' },
          response: { snapshot },
          cause: 'pause',
        }) as never,
    });

    const { host } = await dispatch(
      '/goal pause',
      [pauseCommand],
      createProcessingLinkedHost(true),
    );

    expect(host.items.at(-1)).toMatchObject({
      type: 'goal_state',
      snapshot,
      cause: 'pause',
    });
  });

  it('defers the goal mutation card when a turn starts streaming during the action', async () => {
    const snapshot = { v: 2, goal: { objective: 'x' }, activity: 'idle' };
    const linkedHost = createProcessingLinkedHost(true);
    const pauseCommand = stub({
      name: 'goal',
      action: () => {
        linkedHost.setStreaming(true);
        return {
          type: 'goal_control',
          operation: { kind: 'pause' },
          response: { snapshot },
          cause: 'pause',
        } as never;
      },
    });

    const { host } = await dispatch('/goal pause', [pauseCommand], linkedHost);

    expect(linkedHost.isStreaming()).toBe(true);
    expect(host.items.some((item) => item.type === 'goal_state')).toBe(false);
  });
});

describe('durable slash recall admission', () => {
  it('load_history applies client history and replaces the canonical replay batch', async () => {
    const setHistory = vi.fn();
    const config = {
      getSessionId: () => 'original',
      getLlmClient: () => ({ setHistory }),
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
    expect(host.calls).toEqual(
      expect.arrayContaining(['clearItems', 'loadHistory', 'resetTranscript']),
    );
    expect(host.items.at(-1)).toMatchObject({ type: 'info', text: 'restored' });
  });

  it.each(['session', 'same-session-history'] as const)(
    'does not publish delayed load_history over %s',
    async (change) => {
      let release!: () => void;
      let sessionId = 'original';
      const setHistory = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const config = {
        getSessionId: () => sessionId,
        getLlmClient: () => ({ setHistory }),
      } as unknown as Config;
      const host = createFakeHost();
      const dispatcher = new OpenTuiSlashDispatcher(
        host,
        { ...services, config },
        [
          stub({
            name: 'restore',
            action: () => ({
              type: 'load_history',
              history: [{ type: 'info', text: 'old' }],
              clientHistory: [],
            }),
          }),
        ],
      );
      const pending = dispatcher.handle('/restore');
      await vi.waitFor(() => expect(setHistory).toHaveBeenCalledOnce());
      if (change === 'session') sessionId = 'new';
      host.loadHistory([{ id: 900, type: 'user', text: 'successor' }]);
      host.calls.length = 0;
      release();
      expect(await pending).toEqual({ kind: 'handled' });
      expect(host.items).toEqual([
        { id: 900, type: 'user', text: 'successor' },
      ]);
      expect(host.calls).not.toContain('clearItems');
      expect(host.calls).not.toContain('resetTranscript');
    },
  );

  it.each(['/quit', '/exit', 'exit', 'quit', ':q', ':q!', ':wq', ':wq!'])(
    'keeps the latest real prompt after bare quit token %s',
    async (token) => {
      const { Logger, MessageSenderType } = await import(
        '@qwen-code/qwen-code-core/core/logger.js'
      );
      const { Storage } = await import(
        '@qwen-code/qwen-code-core/config/storage.js'
      );
      const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'quit-recall-'));
      try {
        const storage = new Storage(
          path.join(owned, 'project'),
          path.join(owned, 'runtime'),
        );
        const logger = new Logger('before-quit', storage);
        await logger.initialize();
        await logger.logMessage(MessageSenderType.USER, 'latest real prompt');
        const gateway = new OpenTuiSlashGateway();
        gateway.attach(
          new OpenTuiSlashDispatcher(
            createFakeHost(),
            { ...services, logger },
            [quitCommand],
          ),
        );
        expect(
          await gateway.dispatch(normalizeQuitSubmission(token)),
        ).toMatchObject({
          kind: 'dispatched',
          outcome: { kind: 'quit' },
        });
        const cold = new Logger('after-quit', storage);
        await cold.initialize();
        expect(await cold.getPreviousUserMessages()).toEqual([
          'latest real prompt',
        ]);
      } finally {
        fs.rmSync(owned, { recursive: true, force: true });
      }
    },
  );

  it.each([
    '/quit extra',
    '/exit --help',
    '/ quit',
    '/help',
    '/clear',
    '/reset',
    '/new',
  ])('preserves exact trimmed durable recall for %s', async (query) => {
    const { Logger, MessageSenderType } = await import(
      '@qwen-code/qwen-code-core/core/logger.js'
    );
    const { Storage } = await import(
      '@qwen-code/qwen-code-core/config/storage.js'
    );
    const owned = fs.mkdtempSync(path.join(os.tmpdir(), 'slash-recall-'));
    try {
      const storage = new Storage(
        path.join(owned, 'project'),
        path.join(owned, 'runtime'),
      );
      const logger = new Logger('before-command', storage);
      await logger.initialize();
      await logger.logMessage(MessageSenderType.USER, 'latest real prompt');
      const dispatcher = new OpenTuiSlashDispatcher(
        createFakeHost(),
        { ...services, logger },
        [
          helpCommand,
          quitCommand,
          ...['clear', 'reset', 'new'].map((name) =>
            stub({
              name,
              action: () => ({
                type: 'message',
                messageType: 'info',
                content: 'control',
              }),
            }),
          ),
        ],
      );
      await dispatcher.handle(`  ${query}  `);
      const cold = new Logger('after-command', storage);
      await cold.initialize();
      expect((await cold.getPreviousUserMessages()).sort()).toEqual(
        [query, 'latest real prompt'].sort(),
      );
    } finally {
      fs.rmSync(owned, { recursive: true, force: true });
    }
  });
});
