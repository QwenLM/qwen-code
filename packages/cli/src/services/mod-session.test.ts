/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import { convertClaudePluginPackage } from '@qwen-code/qwen-code-core/extension/claude-converter.js';
import { OutputFormat } from '@qwen-code/qwen-code-core/output/types.js';
import {
  MOD_END_TIMEOUT_MS,
  MOD_MAX_BYTES,
  type ModCommand,
  type ModLog,
  type ModPromptSubmit,
  type ModPromptSubmitted,
  type ModSessionFacts,
  type ModTurnComplete,
  type ModTurnStart,
} from '@qwen-code/qwen-code-core/mods/types.js';
import {
  EVENT_API_RESPONSE,
  uiTelemetryService,
  type UiEvent,
} from '@qwen-code/qwen-code-core/telemetry/uiTelemetry.js';
import { setGenAiUsageProvenance } from '@qwen-code/qwen-code-core/telemetry/gen-ai-usage.js';
import { validateResult } from '@qwen-code/qwen-code-core/mods/dispatch.js';
import {
  LlmEventType,
  type ServerLlmStreamEvent,
} from '@qwen-code/qwen-code-core/core/turn.js';
import type { GenerateContentResponseUsageMetadata } from '@google/genai';
import {
  getRuntimeContentGenerator,
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from '@qwen-code/qwen-code-core/agents/runtime/agent-context.js';
import type { LoadedSettings } from '../config/settings.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import { ModSession, type ModTerminalHost } from './mod-session.js';
import { CommandService } from '../services/CommandService.js';
import { CommandKind, type CommandContext } from '../ui/commands/types.js';
import { registerCleanup, runExitCleanup } from '../utils/cleanup.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  dependencies: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/mods/discovery.js', () => ({
  loadModSource: mocks.load,
  loadModDependencies: mocks.dependencies,
}));
vi.mock('@qwen-code/qwen-code-core/mods/runtime.js', () => ({
  ModRuntime: { createGroup: mocks.create },
}));

describe('Mod session ownership', () => {
  const sessions: ModSession[] = [];
  const tempDirs: string[] = [];
  const setup = (
    overrides: Record<string, unknown> = {},
    terminal?: ModTerminalHost,
  ) => {
    const extension = {
      id: 'id',
      name: 'hello-mod',
      version: '1.0.0',
      path: '/mod',
      isActive: true,
    };
    const config = {
      getSessionId: vi.fn(() => 'session-1'),
      getTargetDir: () => '/workspace',
      getCliVersion: () => '1.2.3',
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
      getChatRecordingService: () => undefined,
      getContentGeneratorConfig: () => undefined,
      getResumedSessionData: () => undefined,
      ...overrides,
    };
    const adapter = { emitSystemMessage: vi.fn() };
    const runtime = {
      hasToolHooks: false,
      runTool: vi.fn<ModToolCall>(async (input, next, signal) =>
        next(input, signal, async (_input, verdict) => verdict),
      ),
      getCommands: vi.fn<() => ModCommand[]>(() => [
        { name: 'hello', description: 'Hello' },
      ]),
      runCommand: vi.fn().mockResolvedValue('answer'),
      end: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      turnHooks: { start: false, complete: [] as string[] },
      promptHooks: [] as string[],
      submitPrompt:
        vi.fn<
          (
            input: ModPromptSubmit,
            signal: AbortSignal,
          ) => Promise<ModPromptSubmitted>
        >(),
      startTurn:
        vi.fn<(input: ModTurnStart, signal: AbortSignal) => Promise<void>>(),
      completeTurn:
        vi.fn<
          (input: ModTurnComplete, signal: AbortSignal) => Promise<string>
        >(),
    };
    mocks.load.mockResolvedValue({
      root: '/mod',
      entry: '/mod/entry.js',
      source: 'export function register() {}',
      dependencies: [],
    });
    mocks.dependencies.mockResolvedValue([]);
    mocks.create.mockImplementation(
      async (_plugins, _cwd, log: (entry: ModLog, plugin: string) => void) => {
        log({ to: 'transcript', text: 'startup log' }, 'hello-mod');
        return runtime;
      },
    );
    const session = new ModSession(
      config as unknown as Config,
      terminal ?? adapter,
    );
    sessions.push(session);
    return { config, adapter, runtime, session, extension };
  };
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    uiTelemetryService.setLastPromptTokenCount(0);
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

  it('exposes tool middleware only for a loaded tool hook and charges every repeated next', async () => {
    const { session, runtime } = setup();
    const signal = new AbortController().signal;
    const repeat = vi.fn();
    expect(session.toolCall(repeat)).toBeUndefined();
    await session.initialize(signal);
    expect(session.toolCall(repeat)).toBeUndefined();
    runtime.hasToolHooks = true;
    runtime.runTool.mockImplementation(async (e, next, active) => {
      await next(e, active, async (_e, v) => v);
      return next(e, active, async (_e, v) => v);
    });
    const next = vi.fn().mockResolvedValue({ result: {} });
    await session.toolCall(repeat)!({ tool: 'write_file' }, next, signal);
    expect(next).toHaveBeenCalledTimes(2);
    expect(repeat).toHaveBeenCalledTimes(1);
  });

  it('serializes roots and refuses a queued call after group invalidation', async () => {
    const { session, runtime, extension } = setup();
    const signal = new AbortController().signal;
    await session.initialize(signal);
    runtime.hasToolHooks = true;
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = vi.fn(async () => {
      await pending;
      return { result: {} };
    });
    const middleware = session.toolCall(() => {})!;
    const first = middleware({ tool: 'write_file' }, next, signal);
    const second = middleware({ tool: 'write_file' }, next, signal);
    const rejected = second.catch((error: unknown) => error);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    extension.isActive = false;
    release();
    await first;
    expect(await rejected).toEqual(
      expect.objectContaining({
        message: expect.stringMatching(/chain changed/),
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('revokes queued tools before configuration changes and reopens only on session commit', async () => {
    const { session, runtime, config } = setup();
    await session.initialize(new AbortController().signal);
    runtime.hasToolHooks = true;
    const old = session.captureToolSignal();
    session.invalidateTools();
    expect(old.aborted).toBe(true);
    expect(session.captureToolSignal().aborted).toBe(true);
    const next = vi.fn(async () => ({ result: {} }));
    await expect(
      session.toolCall(() => {})!(
        { tool: 'write_file' },
        next,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
    // Reinitializing the same session must still create a new generation.
    await session.syncSession('resume');
    expect(session.captureToolSignal()).not.toBe(old);
    expect(session.captureToolSignal().aborted).toBe(false);
    config.getSessionId.mockReturnValue('session-2');
    await expect(
      session.toolCall(() => {})!(
        { tool: 'write_file' },
        next,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
    await session.syncSession('resume');
    await session.toolCall(() => {})!(
      { tool: 'write_file' },
      next,
      new AbortController().signal,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('cancels and settles tool work before ending a session', async () => {
    const { session, runtime } = setup();
    const signal = new AbortController().signal;
    await session.initialize(signal);
    runtime.hasToolHooks = true;
    let settled = false;
    const next = vi.fn(async (_e, active: AbortSignal) => {
      await new Promise<void>((resolve) =>
        active.addEventListener('abort', () => resolve(), { once: true }),
      );
      settled = true;
      return { result: {} };
    });
    const running = session.toolCall(() => {})!(
      { tool: 'write_file' },
      next,
      signal,
    );
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    runtime.end.mockImplementation(async () => {
      expect(settled).toBe(true);
    });
    await session.close();
    await running;
    expect(settled).toBe(true);
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
    expect(mocks.create.mock.calls[0][10]).toBe(true);
    expect(await commands[0].action!({} as CommandContext, 'hello')).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'answer',
    });
    expect(runtime.getCommands).toHaveBeenCalledWith('id');
    expect(runtime.runCommand).toHaveBeenCalledWith(
      'hello',
      'hello',
      expect.any(AbortSignal),
      undefined,
    );
    expect(commands[0].modelInvocable).toBe(false);
  });

  it('uses terminal presentation and invocation cancellation without retaining a loader signal', async () => {
    const log = vi.fn();
    const presentation = { isFullscreen: true, columns: 112 };
    const { session, runtime } = setup(
      { isInteractive: () => true },
      {
        surface: 'terminal',
        log,
        presentation: () => presentation,
      },
    );
    const loader = new AbortController();
    const [command] = await session.loadCommands(loader.signal);
    loader.abort();
    const invocation = new AbortController();
    runtime.runCommand.mockImplementation(
      async (_name, _args, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        signal.throwIfAborted();
      },
    );
    const running = command.action!(
      { abortSignal: invocation.signal } as CommandContext,
      'test',
    );
    const rejected = Promise.resolve(running).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.runCommand).toHaveBeenCalledOnce());
    invocation.abort();
    expect(await rejected).toBeInstanceOf(Error);
    expect(command.supportedModes).toEqual(['interactive']);
    expect(runtime.runCommand).toHaveBeenCalledWith(
      'hello',
      'test',
      expect.any(AbortSignal),
      presentation,
    );
    expect(mocks.create.mock.calls[0][5]).toBe('terminal');
    // The terminals raise no prompt.submit yet.
    expect(mocks.create.mock.calls[0][10]).toBe(false);
  });

  it.each([false, true])(
    'preserves headless metadata and sanitizes terminal metadata: terminal=%s',
    async (terminal) => {
      const { session, runtime, extension } = setup(
        { isInteractive: () => terminal },
        terminal
          ? {
              surface: 'terminal',
              log: vi.fn(),
              presentation: () => ({ isFullscreen: false, columns: 80 }),
            }
          : undefined,
      );
      const link = '\u001b]8;;https://invalid.example/mod-description\u0007';
      const description = `${link}Description\u001b]8;;\u0007\nline\u202e`;
      const argumentHint = '\u001b[31m<argument>\u001b[0m\u0007\tvalue\u2066';
      extension.name = 'hello\nmod\u202e';
      runtime.getCommands.mockReturnValue([
        { name: 'hello', description, argumentHint },
      ]);
      const [command] = await session.loadCommands(
        new AbortController().signal,
      );
      expect(command.description).toBe(
        terminal ? 'Description line' : description,
      );
      expect(command.argumentHint).toBe(
        terminal ? '<argument> value' : argumentHint,
      );
      expect(command.extensionName).toBe(
        terminal ? 'hello mod' : extension.name,
      );
    },
  );

  it('waits for cancellation to settle before dispatching the next command', async () => {
    const { session, runtime } = setup();
    const [command] = await session.loadCommands(new AbortController().signal);
    let settle!: () => void;
    runtime.runCommand.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      return 'late result';
    });
    const invocation = new AbortController();
    const first = command.action!(
      { abortSignal: invocation.signal } as CommandContext,
      'first',
    );
    const rejected = Promise.resolve(first).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.runCommand).toHaveBeenCalledOnce());
    invocation.abort();
    const second = command.action!({} as CommandContext, 'second');
    await Promise.resolve();
    expect(runtime.runCommand).toHaveBeenCalledOnce();
    settle();
    expect(await rejected).toBeInstanceOf(Error);
    await expect(second).resolves.toMatchObject({ content: 'answer' });
    expect(runtime.runCommand).toHaveBeenCalledTimes(2);
  });

  it('ends the old session after cancelling work, preserves the runtime, and ignores same-id switches', async () => {
    const { session, runtime, config } = setup();
    const [command] = await session.loadCommands(new AbortController().signal);
    const order: string[] = [];
    runtime.runCommand.mockImplementationOnce(
      async (_name, _args, signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        order.push('cancelled');
        return 'late';
      },
    );
    runtime.end.mockImplementation(async () => {
      order.push('end');
    });
    const running = command.action!({} as CommandContext, '');
    const rejected = Promise.resolve(running).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.runCommand).toHaveBeenCalledOnce());
    config.getSessionId.mockReturnValue('session-2');
    await session.syncSession('resume');
    expect(await rejected).toBeInstanceOf(Error);
    await session.syncSession('resume');
    expect(order).toEqual(['cancelled', 'end']);
    expect(runtime.end).toHaveBeenCalledWith(
      'session-1',
      'resume',
      expect.any(AbortSignal),
    );
    await expect(
      command.action!({} as CommandContext, 'new'),
    ).resolves.toMatchObject({ content: 'answer' });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it('reports the facts $.session answers and keeps them for the ending session', async () => {
    const recorder = vi.fn<() => unknown>(() => ({
      getUserTurnCount: () => 2,
    }));
    const resumed = vi.fn<() => unknown>(() => ({
      conversation: {
        sessionId: 'session-1',
        startTime: '2026-10-20T08:00:00.000Z',
      },
    }));
    const { session, runtime, config } = setup({
      getProjectRoot: () => '/project',
      getModel: () => 'qwen-max',
      getChatRecordingService: recorder,
      getContentGeneratorConfig: () => ({ contextWindowSize: 1_000 }),
      getResumedSessionData: resumed,
    });
    await session.loadCommands(new AbortController().signal);
    const facts = mocks.create.mock.calls[0][7] as () => ModSessionFacts;
    uiTelemetryService.setLastPromptTokenCount(304);
    expect(facts()).toEqual({
      id: 'session-1',
      cwd: '/workspace',
      root: '/project',
      model: 'qwen-max',
      turns: 2,
      usage: {
        startedAt: Date.parse('2026-10-20T08:00:00.000Z'),
        context: { tokens: 304, window: 1_000, percent: 30 },
        rateLimits: [],
      },
    });

    // The last response can arrive after the last dispatch: only the
    // telemetry listener sees it before the config moves on.
    uiTelemetryService.setLastPromptTokenCount(612);
    // The config moves to the next session before the old one ends.
    config.getSessionId.mockReturnValue('session-2');
    recorder.mockReturnValue({ getUserTurnCount: () => 0 });
    resumed.mockReturnValue(undefined);
    uiTelemetryService.setLastPromptTokenCount(0);
    let ending: ModSessionFacts | undefined;
    runtime.end.mockImplementation(async () => {
      ending = facts();
    });
    const switched = Date.now();
    await session.syncSession('clear');
    expect(ending).toMatchObject({
      id: 'session-1',
      turns: 2,
      usage: {
        startedAt: Date.parse('2026-10-20T08:00:00.000Z'),
        context: { tokens: 612, window: 1_000, percent: 61 },
      },
    });
    const next = facts();
    expect(next).toMatchObject({
      id: 'session-2',
      turns: 0,
      usage: { context: { tokens: 0, window: 1_000, percent: 0 } },
    });
    expect(next.usage.startedAt).toBeGreaterThanOrEqual(switched);
    expect(next.usage.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it('keeps the facts of a resumed session that ends before anything reads it', async () => {
    const recorder = vi.fn<() => unknown>(() => ({
      getUserTurnCount: () => 2,
    }));
    const resumed = vi.fn<() => unknown>(() => undefined);
    const { session, runtime, config } = setup({
      getProjectRoot: () => '/project',
      getModel: () => 'qwen-max',
      getChatRecordingService: recorder,
      getContentGeneratorConfig: () => ({ contextWindowSize: 1_000 }),
      getResumedSessionData: resumed,
    });
    await session.loadCommands(new AbortController().signal);
    const facts = mocks.create.mock.calls[0][7] as () => ModSessionFacts;

    // /resume replays the resumed session's figures before the Mod adopts it.
    config.getSessionId.mockReturnValue('session-2');
    recorder.mockReturnValue({ getUserTurnCount: () => 5 });
    resumed.mockReturnValue({
      conversation: {
        sessionId: 'session-2',
        startTime: '2026-10-21T09:00:00.000Z',
      },
    });
    uiTelemetryService.setLastPromptTokenCount(812);
    await session.syncSession('resume');

    // /clear switches the config again with no dispatch or API response.
    config.getSessionId.mockReturnValue('session-3');
    recorder.mockReturnValue({ getUserTurnCount: () => 0 });
    resumed.mockReturnValue(undefined);
    uiTelemetryService.setLastPromptTokenCount(0);
    let ending: ModSessionFacts | undefined;
    runtime.end.mockImplementation(async () => {
      ending = facts();
    });
    await session.syncSession('clear');
    expect(ending).toMatchObject({
      id: 'session-2',
      turns: 5,
      usage: {
        startedAt: Date.parse('2026-10-21T09:00:00.000Z'),
        context: { tokens: 812, window: 1_000, percent: 81 },
      },
    });
  });

  it('reads the main session through a subagent model frame', async () => {
    // The real Config resolves these through the current agent frame.
    const { session, runtime, config } = setup({
      getProjectRoot: () => '/workspace',
      getModel: () =>
        getRuntimeContentGenerator()?.contentGeneratorConfig.model ??
        'qwen-max',
      getChatRecordingService: () => ({ getUserTurnCount: () => 2 }),
      getContentGeneratorConfig: () =>
        getRuntimeContentGenerator()?.contentGeneratorConfig ?? {
          contextWindowSize: 1_000,
        },
      getResumedSessionData: () => undefined,
    });
    await session.loadCommands(new AbortController().signal);
    const facts = mocks.create.mock.calls[0][7] as () => ModSessionFacts;
    const subagent = {
      contentGenerator: {},
      contentGeneratorConfig: { model: 'qwen-turbo', contextWindowSize: 8_000 },
    } as unknown as RuntimeContentGeneratorView;
    const main = { tokens: 304, window: 1_000, percent: 30 };
    uiTelemetryService.setLastPromptTokenCount(304);
    // A subagent's API response emits the update from inside its frame.
    await runWithRuntimeContentGenerator(subagent, async () => {
      uiTelemetryService.setLastPromptTokenCount(304);
      expect(facts()).toMatchObject({
        model: 'qwen-max',
        usage: { context: main },
      });
    });
    expect(facts().usage.context).toEqual(main);

    await runWithRuntimeContentGenerator(subagent, async () => {
      uiTelemetryService.setLastPromptTokenCount(304);
    });
    let ending: ModSessionFacts | undefined;
    runtime.end.mockImplementation(async () => {
      ending = facts();
    });
    config.getSessionId.mockReturnValue('session-2');
    await session.syncSession('clear');
    expect(ending?.usage.context).toEqual(main);
  });

  it('rounds the context percent and caps it at 100', async () => {
    const { session } = setup({
      getProjectRoot: () => '/workspace',
      getModel: () => 'qwen-max',
      getChatRecordingService: () => undefined,
      getContentGeneratorConfig: () => ({ contextWindowSize: 1_000 }),
      getResumedSessionData: () => undefined,
    });
    await session.loadCommands(new AbortController().signal);
    const facts = mocks.create.mock.calls[0][7] as () => ModSessionFacts;
    uiTelemetryService.setLastPromptTokenCount(306);
    expect(facts().usage.context.percent).toBe(31);
    // After a switch to a smaller model the last prompt can exceed its window.
    uiTelemetryService.setLastPromptTokenCount(1_200);
    expect(facts().usage.context.percent).toBe(100);
  });

  const content = (value: string): ServerLlmStreamEvent => ({
    type: LlmEventType.Content,
    value,
  });
  const finished = (
    usageMetadata?: GenerateContentResponseUsageMetadata,
  ): ServerLlmStreamEvent => ({
    type: LlmEventType.Finished,
    value: { reason: undefined, usageMetadata },
  });
  const apiResponse = (changes: Record<string, unknown> = {}) =>
    ({
      'event.name': EVENT_API_RESPONSE,
      'event.timestamp': '2026-10-24T00:00:00.000Z',
      response_id: 'response',
      model: 'qwen-max',
      duration_ms: 1,
      input_token_count: 0,
      output_token_count: 0,
      cached_content_token_count: 0,
      thoughts_token_count: 0,
      total_token_count: 0,
      prompt_id: 'prompt-1',
      ...changes,
    }) as unknown as UiEvent;
  const turnSignal = new AbortController().signal;
  // A host that cancels the turn it is asked to.
  const abortHost = () => true;
  const loadTurns = async (
    complete = ['hello-mod'],
    overrides: Record<string, unknown> = {},
  ) => {
    const loaded = setup({ getModel: () => 'qwen-max', ...overrides });
    loaded.runtime.turnHooks = { start: true, complete };
    loaded.runtime.startTurn.mockResolvedValue(undefined);
    loaded.runtime.completeTurn.mockImplementation(
      async (input) => input.answer,
    );
    await loaded.session.initialize(new AbortController().signal);
    const abortTurn = mocks.create.mock.calls[0][8] as (turnId: string) => void;
    const ended = () =>
      loaded.runtime.completeTurn.mock.calls.at(-1)?.[0] as ModTurnComplete;
    return { ...loaded, abortTurn, ended };
  };

  const loadPrompts = async () => {
    const loaded = setup();
    loaded.runtime.promptHooks = ['hello-mod'];
    await loaded.session.initialize(new AbortController().signal);
    return loaded;
  };

  it('passes a prompt through when no hook hears prompt.submit', async () => {
    const { session, runtime } = setup();
    await session.initialize(new AbortController().signal);
    expect(await session.submitPrompt('hi', turnSignal)).toEqual({
      text: 'hi',
    });
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
  });

  it('enters the prompt and context the hooks passed on', async () => {
    const { session, runtime } = await loadPrompts();
    runtime.submitPrompt.mockResolvedValue({ text: 'HI', context: ['note'] });
    expect(await session.submitPrompt('hi', turnSignal)).toEqual({
      text: 'HI',
      context: ['note'],
    });
    expect(runtime.submitPrompt).toHaveBeenCalledWith(
      { text: 'hi', wait: false, origin: { kind: 'sdk' } },
      expect.any(AbortSignal),
    );
  });

  it('says why a prompt was dropped, in one line of 4,096 characters', async () => {
    const { session, runtime } = await loadPrompts();
    runtime.submitPrompt.mockResolvedValueOnce({
      drop: 'it holds\na secret\u001b[31m',
      byHook: true,
    });
    expect(await session.submitPrompt('hi', turnSignal)).toEqual({
      drop: 'Prompt dropped by a hook: it holds a secret',
    });
    runtime.submitPrompt.mockResolvedValueOnce({
      drop: 'x'.repeat(5000),
      byHook: true,
    });
    expect(await session.submitPrompt('hi', turnSignal)).toEqual({
      drop: `Prompt dropped by a hook: ${'x'.repeat(4096)}…`,
    });
    runtime.submitPrompt.mockResolvedValueOnce({
      drop: 'a hook answered without passing the prompt on',
      byHook: false,
    });
    expect(await session.submitPrompt('hi', turnSignal)).toEqual({
      drop: 'Prompt not submitted: a hook answered without passing the prompt on',
    });
  });

  it('lets a prompt through when the hooks fail, but not when it is cancelled', async () => {
    const { session, runtime } = await loadPrompts();
    runtime.submitPrompt.mockRejectedValueOnce(new Error('worker failed'));
    expect(await session.submitPrompt('hi', turnSignal)).toEqual({
      text: 'hi',
    });
    const cancel = new AbortController();
    runtime.submitPrompt.mockImplementationOnce(async (_input, signal) => {
      cancel.abort();
      signal.throwIfAborted();
      return { text: 'unreached' };
    });
    await expect(session.submitPrompt('hi', cancel.signal)).rejects.toThrow();
  });

  it('runs no hook on a prompt too long for a Mod payload, and says so', async () => {
    const { session, runtime, adapter } = await loadPrompts();
    const long = 'x'.repeat(MOD_MAX_BYTES);
    expect(await session.submitPrompt(long, turnSignal)).toEqual({
      text: long,
    });
    expect(runtime.submitPrompt).not.toHaveBeenCalled();
    expect(adapter.emitSystemMessage).toHaveBeenLastCalledWith('ui_log', {
      plugin: 'hello-mod',
      text: 'prompt.submit hook skipped: the prompt is too long for a Mod payload',
    });
  });

  it('starts no turn when no hook hears the turn events', async () => {
    const { session, runtime } = setup();
    await session.initialize(new AbortController().signal);
    expect(session.startTurn('hi', turnSignal, abortHost)).toBeUndefined();
    runtime.turnHooks = { start: false, complete: ['hello-mod'] };
    const turn = session.startTurn('hi', turnSignal, abortHost);
    expect(turn).toBeDefined();
    // A turn.start would have queued ahead of the turn's end.
    await turn!.complete();
    expect(runtime.completeTurn).toHaveBeenCalledOnce();
    expect(runtime.startTurn).not.toHaveBeenCalled();
  });

  it('runs turn.start beside the turn and its end after the turn tools', async () => {
    const { session, runtime, ended } = await loadTurns();
    runtime.hasToolHooks = true;
    let release: () => void = () => {};
    runtime.startTurn.mockImplementation(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const order: string[] = [];
    runtime.runTool.mockImplementation(async () => {
      order.push('tool');
      return { result: {} };
    });
    runtime.completeTurn.mockImplementation(async (input) => {
      order.push('complete');
      return input.answer;
    });
    const turn = session.startTurn('Fix it', turnSignal, abortHost)!;
    // The model request does not wait for the hooks.
    expect(runtime.startTurn).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(runtime.startTurn).toHaveBeenCalledWith(
        { text: 'Fix it', turnId: turn.id },
        expect.any(AbortSignal),
      ),
    );
    const tool = session.toolCall(() => {})!(
      { tool: 'read_file' },
      vi.fn(),
      new AbortController().signal,
    );
    turn.saw(content('Do'));
    turn.saw(content('ne. '));
    turn.saw(finished());
    const done = turn.complete();
    expect(order).toEqual([]);
    release();
    await Promise.all([tool, done]);
    expect(order).toEqual(['tool', 'complete']);
    expect(ended()).toEqual({
      answer: 'Done.',
      durationMs: expect.any(Number),
      isAborted: false,
      turnId: turn.id,
      reason: 'answer',
    });
    // The end is reported once, and later events change nothing.
    turn.saw(content('later'));
    expect(turn.complete('error')).toBe(done);
    expect(runtime.completeTurn).toHaveBeenCalledOnce();
  });

  it('answers with the last response the turn streamed', async () => {
    const { session, ended } = await loadTurns();
    const retried = session.startTurn('', turnSignal, abortHost)!;
    retried.saw(content('Checking.'));
    retried.saw(finished());
    retried.saw(content('Half'));
    // A fresh attempt replaces what the failed one streamed.
    retried.saw({ type: LlmEventType.Retry });
    retried.saw(content('Done.'));
    retried.saw(finished());
    await retried.complete();
    expect(ended().answer).toBe('Done.');

    const fellBack = session.startTurn('', turnSignal, abortHost)!;
    fellBack.saw(content('Overloaded'));
    fellBack.saw({
      type: LlmEventType.ModelFallback,
      fromModel: 'qwen-max',
      toModel: 'qwen-plus',
      fallbackIndex: 1,
    });
    fellBack.saw(content('Done on the fallback.'));
    await fellBack.complete('aborted');
    expect(ended().answer).toBe('Done on the fallback.');

    const continued = session.startTurn('', turnSignal, abortHost)!;
    continued.saw(content('Part one, '));
    continued.saw({ type: LlmEventType.Retry, isContinuation: true });
    continued.saw(content('part two.'));
    await continued.complete('aborted');
    expect(ended()).toMatchObject({
      answer: 'Part one, part two.',
      isAborted: true,
      reason: 'aborted',
    });

    // MAX_TOKENS finished the first part before the model went on.
    const recovered = session.startTurn('', turnSignal, abortHost)!;
    recovered.saw(content('Part one, '));
    recovered.saw(finished());
    recovered.saw({ type: LlmEventType.Retry, isContinuation: true });
    recovered.saw(content('part two.'));
    recovered.saw(finished());
    await recovered.complete();
    expect(ended().answer).toBe('Part one, part two.');

    // Cancelled while its tools ran: the last finished response stands.
    const cancelled = session.startTurn('', turnSignal, abortHost)!;
    cancelled.saw({
      type: LlmEventType.Thought,
      value: { subject: 'x', description: 'thinking' },
    });
    cancelled.saw(content('Reading the file.'));
    cancelled.saw(finished());
    await cancelled.complete('aborted');
    expect(ended().answer).toBe('Reading the file.');
  });

  it('tells an error from an answer and an abort', async () => {
    const { session, ended } = await loadTurns();
    for (const event of [
      { type: LlmEventType.Error, value: { error: { message: 'boom' } } },
      { type: LlmEventType.LoopDetected },
      { type: LlmEventType.MaxSessionTurns },
      {
        type: LlmEventType.SessionTokenLimitExceeded,
        value: { currentTokens: 2, limit: 1, message: 'limit' },
      },
    ] as ServerLlmStreamEvent[]) {
      const turn = session.startTurn('', turnSignal, abortHost)!;
      turn.saw(event);
      await turn.complete();
      expect(ended()).toMatchObject({ reason: 'error', isAborted: false });
    }
    const thrown = session.startTurn('', turnSignal, abortHost)!;
    await thrown.complete('error');
    expect(ended().reason).toBe('error');
    const failedThenCancelled = session.startTurn('', turnSignal, abortHost)!;
    failedThenCancelled.saw({
      type: LlmEventType.LoopDetected,
    } as ServerLlmStreamEvent);
    await failedThenCancelled.complete('aborted');
    expect(ended().reason).toBe('aborted');
  });

  it('sums the API counts of the turn responses and names the last model', async () => {
    const { session, ended } = await loadTurns(['hello-mod'], {
      getContentGeneratorConfig: () => ({ authType: 'gemini-api-key' }),
    });
    uiTelemetryService.addEvent(apiResponse({ model: 'before' }), 'session-1');
    const turn = session.startTurn('', turnSignal, abortHost)!;
    turn.saw(
      finished({
        promptTokenCount: 100,
        cachedContentTokenCount: 60,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 5,
      }),
    );
    // A fallback: the model that answered last names the turn.
    uiTelemetryService.addEvent(
      apiResponse({ model: 'qwen-max' }),
      'session-1',
    );
    uiTelemetryService.addEvent(
      apiResponse({ model: 'qwen-plus' }),
      'session-1',
    );
    uiTelemetryService.addEvent(
      apiResponse({ model: 'reviewer-model', subagent_name: 'reviewer' }),
      'session-1',
    );
    uiTelemetryService.addEvent(
      apiResponse({
        model: 'suggestion-model',
        prompt_id: 'prompt_suggestion',
      }),
      'session-1',
    );
    // An Anthropic response reports its cache writes apart.
    const written = {
      promptTokenCount: 50,
      cachedContentTokenCount: 20,
      candidatesTokenCount: 3,
    };
    setGenAiUsageProvenance(written, { cacheCreationInputTokens: 25 });
    turn.saw(finished(written));
    turn.saw(finished(undefined));
    await turn.complete();
    expect(ended().usage).toEqual({
      input_tokens: 45,
      output_tokens: 18,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 25,
      model: 'qwen-plus',
    });

    const quiet = session.startTurn('', turnSignal, abortHost)!;
    await quiet.complete('aborted');
    expect(ended()).not.toHaveProperty('usage');
  });

  it.each(['openai', 'openai-responses', 'qwen-oauth'])(
    'counts reasoning once where the provider includes it in the output (%s)',
    async (authType) => {
      const { session, ended } = await loadTurns(['hello-mod'], {
        getContentGeneratorConfig: () => ({ authType }),
      });
      const turn = session.startTurn('', turnSignal, abortHost)!;
      turn.saw(
        finished({
          promptTokenCount: 10,
          candidatesTokenCount: 8,
          thoughtsTokenCount: 6,
        }),
      );
      await turn.complete();
      expect(ended().usage).toMatchObject({
        input_tokens: 10,
        output_tokens: 8,
        model: 'qwen-max',
      });
    },
  );

  it('takes a count that is not one as the Mods can carry it', async () => {
    const { session, ended } = await loadTurns();
    const turn = session.startTurn('', turnSignal, abortHost)!;
    turn.saw(
      finished({
        promptTokenCount: NaN,
        cachedContentTokenCount: -3,
        candidatesTokenCount: 7.6,
        thoughtsTokenCount: Infinity,
        totalTokenCount: '9' as unknown as number,
      }),
    );
    await turn.complete();
    const usage = ended().usage!;
    expect(usage).toEqual({
      input_tokens: 0,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      model: expect.any(String),
    });
    // The engine hands the usage back, and its own check must pass it.
    expect(() =>
      validateResult('turn.complete', { text: '', usage }),
    ).not.toThrow();
  });

  it('names the model of the turn’s own prompt, not a concurrent one', async () => {
    const { session, ended } = await loadTurns();
    const turn = session.startTurn('', turnSignal, abortHost, 'prompt-1')!;
    uiTelemetryService.addEvent(
      apiResponse({ model: 'qwen-plus', prompt_id: 'prompt-1' }),
      'session-1',
    );
    // A /btw side question answers under its own prompt id.
    uiTelemetryService.addEvent(
      apiResponse({ model: 'btw-model', prompt_id: 'session-1########9' }),
      'session-1',
    );
    turn.saw(finished({ promptTokenCount: 1, candidatesTokenCount: 1 }));
    await turn.complete();
    expect(ended().usage?.model).toBe('qwen-plus');
  });

  it('lets a consistent total decide whether reasoning is in the output', async () => {
    const { session, ended } = await loadTurns(['hello-mod'], {
      getContentGeneratorConfig: () => ({ authType: 'gemini-api-key' }),
    });
    const turn = session.startTurn('', turnSignal, abortHost)!;
    // The total shows the reasoning inside the output, whatever the auth.
    turn.saw(
      finished({
        promptTokenCount: 10,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 6,
        totalTokenCount: 18,
      }),
    );
    // And here beside it.
    turn.saw(
      finished({
        promptTokenCount: 10,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 6,
        totalTokenCount: 24,
      }),
    );
    await turn.complete();
    expect(ended().usage).toMatchObject({ output_tokens: 8 + 14 });
  });

  it('ends a running turn.start with its turn, but not turn.complete', async () => {
    const { session, runtime } = await loadTurns();
    const host = new AbortController();
    const turn = session.startTurn('Fix it', host.signal, abortHost)!;
    await vi.waitFor(() => expect(runtime.startTurn).toHaveBeenCalledOnce());
    const started = runtime.startTurn.mock.calls[0][1];
    expect(started.aborted).toBe(false);
    host.abort();
    expect(started.aborted).toBe(true);
    await turn.complete('aborted');
    expect(runtime.completeTurn.mock.calls[0][1].aborted).toBe(false);
  });

  it('keeps the head and tail of a prompt or answer too long for a Mod payload', async () => {
    const { session, runtime, adapter, ended } = await loadTurns(['long-mod']);
    const long = 'a'.repeat(200_000) + 'z'.repeat(200_000);
    const turn = session.startTurn(long, turnSignal, abortHost)!;
    turn.saw(content(long));
    turn.saw(finished());
    await turn.complete();
    const started = runtime.startTurn.mock.calls[0][0];
    expect(started).toEqual({
      text: expect.stringMatching(
        /^a+\n\[\.\.\. truncated for Mods \.\.\.\]\nz+$/,
      ),
      turnId: turn.id,
      isTextTruncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(started.text))).toBeLessThanOrEqual(
      131_072,
    );
    expect(ended()).toMatchObject({
      answer: started.text,
      isAnswerTruncated: true,
    });
    // The hooks returned the answer they heard, so no note goes beneath it.
    expect(
      adapter.emitSystemMessage.mock.calls.filter(
        ([, data]) => data.plugin === 'long-mod',
      ),
    ).toEqual([]);
  });

  it('shows a different turn.complete text beneath the answer', async () => {
    const { session, runtime, adapter } = await loadTurns([
      'hello-mod',
      'other-mod',
    ]);
    for (const text of [
      'Done.',
      '  ',
      'TL;DR',
      'x'.repeat(5000),
      `${'x'.repeat(4095)}\u{1F600}tail`,
    ]) {
      runtime.completeTurn.mockResolvedValueOnce(text);
      const turn = session.startTurn('', turnSignal, abortHost)!;
      turn.saw(content('Done.'));
      turn.saw(finished());
      await turn.complete();
    }
    expect(
      adapter.emitSystemMessage.mock.calls.filter(
        ([, data]) => data.plugin === 'hello-mod+other-mod',
      ),
    ).toEqual([
      ['ui_log', { plugin: 'hello-mod+other-mod', text: 'TL;DR' }],
      [
        'ui_log',
        { plugin: 'hello-mod+other-mod', text: `${'x'.repeat(4096)}…` },
      ],
      [
        'ui_log',
        {
          plugin: 'hello-mod+other-mod',
          text: `${'x'.repeat(4095)}\u{1F600}…`,
        },
      ],
    ]);
  });

  it('keeps a turn.complete text to its own 4,096 in a terminal', async () => {
    const log = vi.fn();
    const { session, runtime } = setup(
      { isInteractive: () => true },
      {
        surface: 'terminal',
        log,
        presentation: () => ({ isFullscreen: false, columns: 80 }),
      },
    );
    runtime.turnHooks = { start: false, complete: ['hello-mod'] };
    await session.initialize(new AbortController().signal);
    runtime.completeTurn.mockResolvedValueOnce('x'.repeat(3000));
    await session.startTurn('', turnSignal, abortHost)!.complete();
    // Unlike a $.ui.log line, which a terminal cuts at 2,000.
    expect(log).toHaveBeenLastCalledWith(
      {
        text: 'x'.repeat(3000),
        to: 'transcript',
        plugin: 'hello-mod',
        sessionId: 'session-1',
      },
      'hello-mod',
      'session-1',
    );
  });

  it('writes a text-mode note beneath the answer', async () => {
    const order: string[] = [];
    // Each write answers its callback, as a drained stream does.
    const spyWrite = (stream: NodeJS.WriteStream, name: string) => {
      const spy = vi.spyOn(stream, 'write').mockImplementation(((
        chunk: unknown,
        encoding?: unknown,
        callback?: unknown,
      ) => {
        order.push(String(chunk).includes('TL;DR') ? 'note' : name);
        const done = typeof encoding === 'function' ? encoding : callback;
        if (typeof done === 'function') done();
        return true;
      }) as typeof stream.write);
      onTestFinished(() => spy.mockRestore());
      return spy;
    };
    const stderr = spyWrite(process.stderr, 'stderr');
    spyWrite(process.stdout, 'stdout');
    const { session, runtime } = await loadTurns(['hello-mod'], {
      getOutputFormat: () => OutputFormat.TEXT,
    });
    runtime.completeTurn.mockResolvedValueOnce('TL;DR\u001b[31m');
    await session.startTurn('', turnSignal, abortHost)!.complete();
    const notes = () =>
      stderr.mock.calls.filter(([text]) => String(text).includes('TL;DR'));
    // The answer is written when the run ends; the note waits for it.
    expect(notes()).toEqual([]);
    await session.close();
    expect(notes()).toEqual([]);
    order.length = 0;
    await session.flushOutput();
    expect(notes()).toEqual([['[Mod hello-mod] TL;DR\n']]);
    // stdout, which holds the answer, drains before the note is written.
    expect(order.slice(0, 2)).toEqual(['stdout', 'note']);
  });

  it('writes the note of a turn an exit ended', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((
      _chunk: unknown,
      encoding?: unknown,
      callback?: unknown,
    ) => {
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') done();
      return true;
    }) as typeof process.stderr.write);
    onTestFinished(() => stderr.mockRestore());
    const { session, runtime } = await loadTurns(['hello-mod'], {
      getOutputFormat: () => OutputFormat.TEXT,
    });
    runtime.completeTurn.mockResolvedValueOnce('TL;DR');
    session.startTurn('', turnSignal, abortHost)!.saw(content('Halfway'));
    await runExitCleanup();
    expect(
      stderr.mock.calls.filter(([text]) => String(text).includes('TL;DR')),
    ).toEqual([['[Mod hello-mod] TL;DR\n']]);
  });

  it('ends the turn a close cuts short before session.end', async () => {
    const { session, runtime, ended } = await loadTurns();
    const order: string[] = [];
    runtime.completeTurn.mockImplementation(async (input, signal) => {
      order.push(`complete ${input.reason} ${signal.aborted}`);
      return input.answer;
    });
    runtime.end.mockImplementation(async () => {
      order.push('end');
    });
    const turn = session.startTurn('Fix it', turnSignal, abortHost)!;
    turn.saw(content('Halfway'));
    const closed = session.close();
    // The host's own end arrives while the close runs.
    void turn.complete();
    await closed;
    expect(order).toEqual(['complete aborted false', 'end']);
    expect(ended()).toMatchObject({
      answer: 'Halfway',
      isAborted: true,
      turnId: turn.id,
    });
    // A host that ends it afterwards adds no second end.
    await turn.complete();
    expect(order).toEqual(['complete aborted false', 'end']);
  });

  it('lets an end that is running finish when the session closes', async () => {
    const { session, runtime, adapter } = await loadTurns();
    const order: string[] = [];
    let release: () => void = () => {};
    runtime.completeTurn.mockImplementation(async (input, signal) => {
      order.push('complete');
      await new Promise<void>((resolve) => (release = resolve));
      order.push(`finished ${signal.aborted}`);
      return 'Summary';
    });
    runtime.end.mockImplementation(async () => {
      order.push('end');
    });
    const turn = session.startTurn('Fix it', turnSignal, abortHost)!;
    turn.saw(content('Done.'));
    turn.saw(finished());
    void turn.complete();
    await vi.waitFor(() => expect(order).toEqual(['complete']));
    const closed = session.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await closed;
    expect(order).toEqual(['complete', 'finished false', 'end']);
    expect(adapter.emitSystemMessage).toHaveBeenCalledWith('ui_log', {
      plugin: 'hello-mod',
      text: 'Summary',
    });
  });

  it('runs every end the close finds queued, in order', async () => {
    const { session, runtime } = await loadTurns();
    const order: string[] = [];
    // A turn.start that holds the queue until the close cancels it.
    runtime.startTurn.mockImplementation(
      (_input, signal) =>
        new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    );
    runtime.completeTurn.mockImplementation(async (input) => {
      order.push(`complete ${input.answer} ${input.reason}`);
      return input.answer;
    });
    runtime.end.mockImplementation(async () => {
      order.push('end');
    });
    const first = session.startTurn('First', turnSignal, abortHost)!;
    first.saw(content('One'));
    first.saw(finished());
    void first.complete();
    // In a terminal the next prompt starts before the last turn's end runs.
    const second = session.startTurn('Second', turnSignal, abortHost)!;
    second.saw(content('Two'));
    await session.close();
    expect(order).toEqual([
      'complete One answer',
      'complete Two aborted',
      'end',
    ]);
  });

  it('cuts the ends short at their budget, then runs session.end', async () => {
    const { session, runtime } = await loadTurns();
    let cancelled: boolean | undefined;
    runtime.completeTurn.mockImplementation(
      (_input, signal) =>
        new Promise<string>((_, reject) =>
          signal.addEventListener('abort', () => {
            cancelled = true;
            reject(signal.reason);
          }),
        ),
    );
    session.startTurn('Fix it', turnSignal, abortHost);
    const started = Date.now();
    await session.close();
    expect(cancelled).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      MOD_END_TIMEOUT_MS - 50,
    );
    expect(runtime.end).toHaveBeenCalledOnce();
  });

  it('runs no end again at close once it ran', async () => {
    const { session, runtime } = await loadTurns();
    await session.startTurn('Fix it', turnSignal, abortHost)!.complete();
    await session.close();
    expect(runtime.completeTurn).toHaveBeenCalledOnce();
  });

  it('runs an end the close overtook, with its own reason', async () => {
    const { session, runtime, ended } = await loadTurns();
    const turn = session.startTurn('Fix it', turnSignal, abortHost)!;
    turn.saw(content('Done.'));
    turn.saw(finished());
    void turn.complete();
    await session.close();
    expect(runtime.completeTurn).toHaveBeenCalledOnce();
    expect(ended()).toMatchObject({ answer: 'Done.', reason: 'answer' });
  });

  it('ends only the running turn from $.turn.abort', async () => {
    const { session, abortTurn, ended } = await loadTurns();
    expect(() => abortTurn('turn-0')).toThrow(
      '$.turn.abort: no turn is running (asked for turn-0)',
    );
    const abort = vi.fn(() => true);
    const turn = session.startTurn('', turnSignal, abort)!;
    expect(() => abortTurn('turn-0')).toThrow(
      `$.turn.abort: turn-0 is not the running turn (${turn.id})`,
    );
    abortTurn(turn.id);
    expect(abort).toHaveBeenCalledOnce();
    expect(() => abortTurn(turn.id)).toThrow(
      `$.turn.abort: ${turn.id} is already ending`,
    );
    // The host ends the turn without knowing who asked: still an abort.
    await turn.complete();
    expect(ended()).toMatchObject({ reason: 'aborted', isAborted: true });
    expect(() => abortTurn(turn.id)).toThrow('no turn is running');
    expect(abort).toHaveBeenCalledOnce();
  });

  it('rejects $.turn.abort when the host finds nothing to cancel', async () => {
    const { session, abortTurn, ended } = await loadTurns();
    // The stream already went idle, but the turn has not completed yet.
    const turn = session.startTurn('', turnSignal, () => false)!;
    turn.saw({ type: LlmEventType.Content, value: 'Done.' });
    expect(() => abortTurn(turn.id)).toThrow(
      `$.turn.abort: ${turn.id} is already ending`,
    );
    await turn.complete();
    expect(ended()).toMatchObject({ reason: 'answer', isAborted: false });
  });

  it('lets $.turn.abort try again after the host failed to cancel', async () => {
    const { session, abortTurn, ended } = await loadTurns();
    const abort = vi
      .fn<() => boolean>()
      .mockImplementationOnce(() => {
        throw new Error('cancel failed');
      })
      .mockReturnValue(true);
    const turn = session.startTurn('', turnSignal, abort)!;
    expect(() => abortTurn(turn.id)).toThrow('cancel failed');
    abortTurn(turn.id);
    expect(abort).toHaveBeenCalledTimes(2);
    await turn.complete();
    expect(ended()).toMatchObject({ reason: 'aborted' });

    // One the host never cancelled ends as what it streamed.
    const failing = session.startTurn('', turnSignal, () => {
      throw new Error('cancel failed');
    })!;
    expect(() => abortTurn(failing.id)).toThrow('cancel failed');
    await failing.complete();
    expect(ended()).toMatchObject({ reason: 'answer', isAborted: false });
  });

  it('keeps the queue running after a failed turn hook and drops a turn of an ended session', async () => {
    const { session, runtime, config } = await loadTurns();
    runtime.startTurn.mockRejectedValueOnce(new Error('hook failed'));
    const failed = session.startTurn('', turnSignal, abortHost)!;
    await failed.complete('error');
    expect(runtime.completeTurn).toHaveBeenCalledOnce();

    const old = session.startTurn('', turnSignal, abortHost)!;
    config.getSessionId.mockReturnValue('session-2');
    await session.syncSession('clear');
    await old.complete();
    expect(runtime.startTurn).toHaveBeenCalledTimes(2);
    expect(runtime.completeTurn).toHaveBeenCalledOnce();
  });

  it('stops listening to telemetry once closed', async () => {
    const before = uiTelemetryService.listenerCount('update');
    const { session } = setup();
    expect(uiTelemetryService.listenerCount('update')).toBe(before + 1);
    await session.close();
    expect(uiTelemetryService.listenerCount('update')).toBe(before);
  });

  it('answers no turns without chat recording and no percent without a window', async () => {
    const { session } = setup({
      getProjectRoot: () => '/workspace',
      getModel: () => 'qwen-max',
      getChatRecordingService: () => undefined,
      getContentGeneratorConfig: () => ({}),
      getResumedSessionData: () => undefined,
    });
    await session.loadCommands(new AbortController().signal);
    const facts = mocks.create.mock.calls[0][7] as () => ModSessionFacts;
    uiTelemetryService.setLastPromptTokenCount(12);
    expect(facts()).toMatchObject({
      turns: 0,
      usage: { context: { tokens: 12, window: 0 } },
    });
    expect(facts().usage.context).not.toHaveProperty('percent');
  });

  it('sanitizes terminal output, keeps debug logs private and discards cancelled output', async () => {
    const log = vi.fn();
    const { session, runtime } = setup(
      { isInteractive: () => true },
      {
        surface: 'terminal',
        log,
        presentation: () => ({ isFullscreen: false, columns: 80 }),
      },
    );
    const [command] = await session.loadCommands(new AbortController().signal);
    session.flushLogs();
    log.mockClear();
    const emit = mocks.create.mock.calls[0][2] as (
      entry: ModLog,
      plugin: string,
    ) => void;
    emit({ to: 'debug', text: 'private' }, 'hello-mod');
    emit(
      { to: 'transcript', text: '\u001b[31m' + 'x'.repeat(2500) },
      'hello-mod',
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      {
        to: 'transcript',
        text: 'x'.repeat(2000),
        plugin: 'hello-mod',
        sessionId: 'session-1',
      },
      'hello-mod',
      'session-1',
    );
    log.mockClear();
    emit(
      { to: 'transcript', text: `${'x'.repeat(1999)}\u{1F600}tail` },
      'hello-mod',
    );
    expect(log.mock.calls[0][0].text).toBe(`${'x'.repeat(1999)}\u{1F600}`);
    log.mockClear();
    emit(
      {
        to: 'transcript',
        text: '\u001b[31mline one\u001b[0m\nline two\tvalue\u0007\u202e\u2066',
      },
      'hello-mod',
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: 'line one\nline two\tvalue' }),
      'hello-mod',
      'session-1',
    );
    runtime.runCommand.mockResolvedValueOnce(
      '\u001b[31msafe\u001b[0m\nline two\tvalue\u0007\u007f\u202e',
    );
    await expect(
      command.action!({} as CommandContext, ''),
    ).resolves.toMatchObject({ content: 'safe\nline two\tvalue' });
    log.mockClear();
    const invocation = new AbortController();
    runtime.runCommand.mockImplementationOnce(async () => {
      invocation.abort();
      emit({ to: 'transcript', text: 'late' }, 'hello-mod');
      return 'late result';
    });
    await expect(
      command.action!({ abortSignal: invocation.signal } as CommandContext, ''),
    ).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it('uses operator scopes and validates options before starting any runtime', async () => {
    const { config, adapter } = setup();
    mocks.load.mockResolvedValue({
      root: '/mod',
      entry: '/mod/entry.ts',
      source: 'export function register() {}',
      dependencies: [],
      userConfig: {
        value: {
          type: 'string',
          title: 'Value',
          description: 'Value',
          required: true,
        },
      },
    });
    const settings = {
      merged: {
        experimental: { mods: true },
        pluginConfigs: { 'hello-mod': { options: { value: 'workspace' } } },
      },
      systemDefaults: { settings: {} },
      user: {
        settings: {
          pluginConfigs: { 'hello-mod@inline': { options: { value: 'user' } } },
        },
      },
      system: {
        settings: {
          pluginConfigs: { 'hello-mod': { options: { value: 'system' } } },
        },
      },
    } as unknown as LoadedSettings;
    const session = ModSession.create(
      config as unknown as Config,
      settings,
      adapter as unknown as JsonOutputAdapterInterface,
    )!;
    sessions.push(session);
    await session.initialize(new AbortController().signal);
    expect(mocks.create.mock.calls[0][0][0].options).toEqual({
      value: 'system',
    });
  });

  it.each([
    [undefined, undefined, 'native'],
    ['claude', undefined, 'claude'],
    ['claude', 'native', 'native'],
  ] as const)(
    'selects dialect from operator settings, not workspace or plugin origin (%s, %s)',
    async (user, system, expected) => {
      const { config, adapter, extension } = setup();
      Object.assign(extension, { originSource: 'claude' });
      const settings = {
        merged: {
          experimental: { mods: true },
          pluginConfigs: { 'hello-mod': { toolDialect: 'claude' } },
        },
        systemDefaults: { settings: {} },
        user: {
          settings: {
            pluginConfigs: { 'hello-mod@inline': { toolDialect: user } },
          },
        },
        system: {
          settings: { pluginConfigs: { 'hello-mod': { toolDialect: system } } },
        },
      } as unknown as LoadedSettings;
      const session = ModSession.create(
        config as unknown as Config,
        settings,
        adapter as unknown as JsonOutputAdapterInterface,
      )!;
      sessions.push(session);
      await session.initialize(new AbortController().signal);
      expect(mocks.create.mock.calls[0][0][0]).toMatchObject({
        toolDialect: expected,
        options: {},
      });
    },
  );

  it.each([
    [undefined, undefined, 'skip'],
    ['reject', undefined, 'reject'],
    ['reject', 'skip', 'skip'],
  ] as const)(
    'selects the unsupported-event policy from operator settings (%s, %s)',
    async (user, system, expected) => {
      const { config, adapter } = setup();
      const settings = {
        merged: {
          experimental: { mods: true },
          pluginConfigs: { 'hello-mod': { unsupportedEvents: 'reject' } },
        },
        systemDefaults: { settings: {} },
        user: {
          settings: {
            pluginConfigs: { 'hello-mod': { unsupportedEvents: user } },
          },
        },
        system: {
          settings: {
            pluginConfigs: { 'hello-mod': { unsupportedEvents: system } },
          },
        },
      } as unknown as LoadedSettings;
      const session = ModSession.create(
        config as unknown as Config,
        settings,
        adapter as unknown as JsonOutputAdapterInterface,
      )!;
      sessions.push(session);
      await session.initialize(new AbortController().signal);
      expect(mocks.create.mock.calls[0][0][0]).toMatchObject({
        unsupportedEvents: expected,
      });
      expect(mocks.create.mock.calls[0][6]).toBe('1.2.3');
    },
  );

  it('rejects an invalid unsupported-event policy before any worker starts', async () => {
    const { config, adapter } = setup();
    const session = new ModSession(
      config as unknown as Config,
      adapter as unknown as JsonOutputAdapterInterface,
      [{ 'hello-mod': { unsupportedEvents: 'warn' } }],
    );
    sessions.push(session);
    await expect(
      session.initialize(new AbortController().signal),
    ).rejects.toThrow('Mod hello-mod: Invalid Mod unsupportedEvents');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid dialect on a later plugin before any worker starts without userConfig', async () => {
    const extensions = [
      { id: 'a', name: 'a', path: '/a', version: '1.0.0', isActive: true },
      { id: 'b', name: 'b', path: '/b', version: '1.0.0', isActive: true },
    ];
    const { config, adapter } = setup({ getExtensions: () => extensions });
    const session = new ModSession(
      config as unknown as Config,
      adapter as unknown as JsonOutputAdapterInterface,
      [{ b: { toolDialect: 'unsupported' } }],
    );
    sessions.push(session);
    await expect(
      session.initialize(new AbortController().signal),
    ).rejects.toThrow('Mod b: Invalid Mod toolDialect');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(['missing', 'cycle', 'options'])(
    'starts no workers when a later plugin has invalid %s',
    async (kind) => {
      const extensions = [
        { id: 'a', name: 'a', path: '/a', version: '1.0.0', isActive: true },
        { id: 'b', name: 'b', path: '/b', version: '1.0.0', isActive: true },
      ];
      const { session } = setup({ getExtensions: () => extensions });
      mocks.load.mockImplementation(async (path: string) => ({
        root: path,
        entry: path + '/entry.js',
        source: '',
        dependencies:
          kind === 'cycle'
            ? [{ name: path === '/a' ? 'b' : 'a' }]
            : kind === 'missing' && path === '/b'
              ? [{ name: 'absent' }]
              : [],
        userConfig:
          kind === 'options' && path === '/b'
            ? {
                needed: {
                  type: 'string',
                  title: '',
                  description: '',
                  required: true,
                },
              }
            : undefined,
      }));
      await expect(
        session.initialize(new AbortController().signal),
      ).rejects.toThrow(
        kind === 'cycle'
          ? /cycle/
          : kind === 'missing'
            ? /installed, enabled/
            : /required/,
      );
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it('orders Mod consumers before providers and accepts an ordinary extension dependency', async () => {
    const extensions = ['base', 'ordinary', 'consumer'].map((name) => ({
      id: name + '-id',
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session } = setup({ getExtensions: () => extensions });
    mocks.load.mockImplementation(async (path: string) =>
      path === '/ordinary'
        ? undefined
        : {
            root: path,
            entry: path + '/entry.js',
            source: '',
            dependencies:
              path === '/consumer'
                ? [{ name: 'base' }, { name: 'ordinary' }]
                : [],
          },
    );
    await session.initialize(new AbortController().signal);
    expect(
      mocks.create.mock.calls[0][0].map(
        (plugin: { source: { root: string } }) => plugin.source.root,
      ),
    ).toEqual(['/consumer', '/base']);
  });

  it('checks transitive ordinary dependencies but ignores unrelated declarations', async () => {
    const extensions = ['consumer', 'ordinary', 'unrelated'].map((name) => ({
      id: name,
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session } = setup({ getExtensions: () => extensions });
    mocks.load.mockImplementation(async (path: string) =>
      path !== '/consumer'
        ? undefined
        : {
            root: path,
            entry: path + '/entry.js',
            source: '',
            dependencies: [{ name: 'ordinary' }],
          },
    );
    mocks.dependencies.mockResolvedValue([{ name: 'missing' }]);
    await expect(
      session.initialize(new AbortController().signal),
    ).rejects.toThrow(/ordinary.*missing.*installed/);
    expect(mocks.dependencies).toHaveBeenCalledExactlyOnceWith('/ordinary');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('does not turn an ordinary provider into a Mod ordering node', async () => {
    const extensions = ['base', 'ordinary', 'consumer'].map((name) => ({
      id: name,
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session } = setup({ getExtensions: () => extensions });
    mocks.load.mockImplementation(async (path: string) =>
      path === '/ordinary'
        ? undefined
        : {
            root: path,
            entry: path + '/entry.js',
            source: '',
            dependencies: path === '/consumer' ? [{ name: 'ordinary' }] : [],
          },
    );
    mocks.dependencies.mockResolvedValue([{ name: 'base' }]);
    await session.initialize(new AbortController().signal);
    expect(
      mocks.create.mock.calls[0][0].map(
        (plugin: { source: { root: string } }) => plugin.source.root,
      ),
    ).toEqual(['/base', '/consumer']);
  });

  describe.each(['direct', 'ordinary'] as const)(
    'converted marketplace %s dependencies',
    (via) => {
      it.each(['missing', 'incompatible', 'satisfied', 'invalid'])(
        'validates %s dependencies before starting a worker',
        async (state) => {
          const root = await fs.mkdtemp(
            path.join(os.tmpdir(), 'mod-marketplace-'),
          );
          tempDirs.push(root);
          const names = [
            'consumer',
            ...(via === 'ordinary' ? ['ordinary'] : []),
          ];
          if (state !== 'missing') names.push('base');
          const entries = [];
          for (const name of names) {
            const version =
              name === 'base' && state === 'incompatible' ? '1.0.0' : '2.0.0';
            const declaresDependency =
              name === (via === 'direct' ? 'consumer' : 'ordinary');
            entries.push({
              name,
              version,
              source: `./${name}`,
              ...(declaresDependency
                ? {
                    dependencies:
                      state === 'invalid'
                        ? false
                        : [{ name: 'base', version: '^2.0.0' }],
                  }
                : {}),
            });
            await fs.mkdir(path.join(root, name, '.claude-plugin'), {
              recursive: true,
            });
            await fs.writeFile(
              path.join(root, name, '.claude-plugin/plugin.json'),
              JSON.stringify({
                name,
                version,
                ...(name === 'consumer' && via === 'ordinary'
                  ? { dependencies: ['ordinary'] }
                  : {}),
              }),
            );
          }
          await fs.mkdir(path.join(root, '.claude-plugin'));
          await fs.writeFile(
            path.join(root, '.claude-plugin/marketplace.json'),
            JSON.stringify({
              name: 'fixture',
              owner: { name: 'Fixture' },
              plugins: entries,
            }),
          );
          await fs.mkdir(path.join(root, 'consumer/hooks'));
          await fs.writeFile(
            path.join(root, 'consumer/hooks/hooks.json'),
            JSON.stringify({ modules: ['./entry.js'] }),
          );
          await fs.writeFile(
            path.join(root, 'consumer/hooks/entry.js'),
            'export function register() {}',
          );
          const extensions = await Promise.all(
            names.map(async (name) => {
              const { convertedDir, config } = await convertClaudePluginPackage(
                root,
                name,
              );
              tempDirs.push(convertedDir);
              return {
                ...config,
                id: name,
                path: convertedDir,
                isActive: true,
                installMetadata: { marketplaceConfig: { name: 'fixture' } },
              };
            }),
          );
          const { session } = setup({ getExtensions: () => extensions });
          const discovery = await vi.importActual<
            typeof import('@qwen-code/qwen-code-core/mods/discovery.js')
          >('@qwen-code/qwen-code-core/mods/discovery.js');
          mocks.load.mockImplementation(discovery.loadModSource);
          mocks.dependencies.mockImplementation(discovery.loadModDependencies);

          const initialization = session.initialize(
            new AbortController().signal,
          );
          if (state === 'satisfied') {
            await initialization;
            expect(mocks.create).toHaveBeenCalledTimes(1);
            expect(
              (await session.loadCommands(new AbortController().signal)).map(
                ({ name }) => name,
              ),
            ).toEqual(['hello']);
          } else {
            await expect(initialization).rejects.toThrow(
              state === 'missing'
                ? /dependency base.*installed, enabled/
                : state === 'incompatible'
                  ? /dependency base.*incompatible installed version/
                  : /Invalid Mod dependencies declaration/,
            );
            expect(mocks.create).not.toHaveBeenCalled();
          }
        },
      );
    },
  );

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

  it('invalidates the whole chain when another participating plugin is disabled', async () => {
    const extensions = ['wrapper', 'provider'].map((name) => ({
      id: name,
      name,
      path: '/' + name,
      version: '1.0.0',
      isActive: true,
    }));
    const { session, runtime } = setup({ getExtensions: () => extensions });
    const commands = await session.loadCommands(new AbortController().signal);
    extensions[0].isActive = false;
    await expect(commands[1].action!({} as CommandContext, '')).rejects.toThrow(
      /chain changed/,
    );
    expect(runtime.runCommand).not.toHaveBeenCalled();
    await session.close();
    expect(runtime.end).not.toHaveBeenCalled();
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
