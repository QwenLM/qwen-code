/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import type { ModLog } from '@qwen-code/qwen-code-core/mods/types.js';
import type { LoadedSettings } from '../config/settings.js';
import type { JsonOutputAdapterInterface } from './io/BaseJsonOutputAdapter.js';
import { ModSession } from './mod-session.js';
import { CommandService } from '../services/CommandService.js';
import { CommandKind, type CommandContext } from '../ui/commands/types.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';

const mocks = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn() }));
vi.mock('@qwen-code/qwen-code-core/mods/discovery.js', () => ({
  loadModSource: mocks.load,
}));
vi.mock('@qwen-code/qwen-code-core/mods/runtime.js', () => ({
  ModRuntime: { create: mocks.create },
}));

describe('headless Mod session ownership', () => {
  const sessions: ModSession[] = [];
  const setup = (overrides: Record<string, unknown> = {}) => {
    const extension = {
      id: 'id',
      name: 'hello-mod',
      path: '/mod',
      isActive: true,
    };
    const config = {
      getSessionId: vi.fn(() => 'session-1'),
      getTargetDir: () => '/workspace',
      getOutputFormat: () => OutputFormat.JSON,
      getExtensions: () => [extension],
      isInteractive: () => false,
      getExperimentalZedIntegration: () => false,
      isTrustedFolder: () => true,
      getDisableAllHooks: () => false,
      getBareMode: () => false,
      isSafeMode: () => false,
      getExecutionEnvironment: () => undefined,
      getExecutionEnvironmentFactory: () => undefined,
      getHookSystem: () => undefined,
      getSandbox: () => undefined,
      isSessionAgentSession: () => false,
      ...overrides,
    };
    const adapter = { emitSystemMessage: vi.fn() };
    const runtime = {
      getCommands: () => [{ name: 'hello', description: 'Hello' }],
      runCommand: vi.fn().mockResolvedValue('answer'),
      end: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mocks.load.mockResolvedValue('export function register() {}');
    mocks.create.mockImplementation(
      async (_source, _cwd, log: (entry: ModLog) => void) => {
        log({ to: 'transcript', text: 'startup log' });
        return runtime;
      },
    );
    const session = new ModSession(
      config as unknown as Config,
      adapter as unknown as JsonOutputAdapterInterface,
    );
    sessions.push(session);
    return { config, adapter, runtime, session, extension };
  };
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.resetAllMocks();
  });

  it('is opt-in without reading or executing extensions by default', () => {
    expect(
      ModSession.create(
        {} as Config,
        { merged: {} } as LoadedSettings,
        {} as JsonOutputAdapterInterface,
      ),
    ).toBeUndefined();
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it.each([
    ['isInteractive', true],
    ['getExperimentalZedIntegration', true],
    ['isTrustedFolder', false],
    ['getDisableAllHooks', true],
    ['getBareMode', true],
    ['isSafeMode', true],
    ['getExecutionEnvironment', {}],
    ['getExecutionEnvironmentFactory', () => {}],
    ['getHookSystem', { isManaged: () => true }],
    ['getSandbox', {}],
    ['isSessionAgentSession', true],
  ])('does not read modules behind %s admission', async (name, value) => {
    const { session } = setup({ [name]: () => value });
    await session.initialize(new AbortController().signal);
    expect(await session.loadCommands(new AbortController().signal)).toEqual(
      [],
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('initializes once, buffers logs behind init, and uses the command signal', async () => {
    const { session, adapter, runtime } = setup();
    const signal = new AbortController().signal;
    await session.initialize(signal);
    expect(adapter.emitSystemMessage).not.toHaveBeenCalled();
    session.flushLogs();
    expect(adapter.emitSystemMessage).toHaveBeenCalledWith('ui_log', {
      plugin: 'hello-mod',
      text: 'startup log',
    });
    const commands = await session.loadCommands(signal);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(await commands[0].action!({} as CommandContext, 'hello')).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'answer',
    });
    expect(runtime.runCommand).toHaveBeenCalledWith('hello', 'hello', signal);
    expect(commands[0].modelInvocable).toBe(false);
  });

  it('keeps Agent Plugins v1 hooks ignored', async () => {
    const { session } = setup({
      getExtensions: () => [{ isActive: true, format: 'agent-plugins-v1' }],
    });
    await session.initialize(new AbortController().signal);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not skip the next registered exit cleanup', async () => {
    const { session, runtime } = setup();
    await session.initialize(new AbortController().signal);
    const following = vi.fn();
    const last = vi.fn();
    registerCleanup(following);
    registerCleanup(last);
    await runExitCleanup();
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(following).toHaveBeenCalledOnce();
    expect(last).toHaveBeenCalledOnce();
  });

  it('retains the same runtime across session changes and closes once', async () => {
    const { session, runtime, config } = setup();
    await session.initialize(new AbortController().signal);
    config.getSessionId.mockReturnValue('session-2');
    await session.syncSession('clear');
    await session.initialize(new AbortController().signal);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(runtime.end).toHaveBeenNthCalledWith(
      1,
      'session-1',
      'clear',
      expect.any(AbortSignal),
    );
    await Promise.all([session.close(), session.close()]);
    expect(runtime.end).toHaveBeenNthCalledWith(
      2,
      'session-2',
      'other',
      expect.any(AbortSignal),
    );
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('checks activation again at the actual command invocation', async () => {
    const { session, runtime, extension } = setup();
    const [command] = await session.loadCommands(new AbortController().signal);
    extension.isActive = false;
    await expect(command.action!({} as CommandContext, '')).rejects.toThrow(
      /disabled/,
    );
    expect(runtime.runCommand).not.toHaveBeenCalled();
    expect(runtime.dispose).toHaveBeenCalled();
  });

  it('keeps real CommandService namespacing and denylist behavior', async () => {
    const { session } = setup();
    const builtin = {
      loadCommands: async () => [
        { name: 'hello', description: 'builtin', kind: CommandKind.BUILT_IN },
      ],
    };
    const service = await CommandService.create(
      [builtin, session],
      new AbortController().signal,
    );
    expect(service.getCommands().map((command) => command.name)).toEqual([
      'hello',
      'hello-mod.hello',
    ]);
    const filtered = await CommandService.create(
      [builtin, session],
      new AbortController().signal,
      new Set(['hello-mod.hello']),
    );
    expect(filtered.getCommands().map((command) => command.name)).toEqual([
      'hello',
    ]);
  });
});
