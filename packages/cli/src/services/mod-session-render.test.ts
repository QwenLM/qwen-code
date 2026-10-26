/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModRenderHost } from '@qwen-code/qwen-code-core/mods/runtime.js';
import {
  ENGINE_NODE,
  type ModRenderElement,
  type ModRenderInput,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import type { ModToolCall } from '@qwen-code/qwen-code-core/mods/tool-events.js';
import { ModSession, type ModTerminalHost } from './mod-session.js';

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

const input = ({
  columns = 80,
  rows = 24,
  maxRows = 8,
  isWorking = false,
}: {
  columns?: number;
  rows?: number;
  maxRows?: number;
  isWorking?: boolean;
} = {}): ModRenderInput => ({
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  viewport: { columns, rows, isFullscreen: false },
  props: {
    hasSurvey: false,
    isWorking,
    maxRows,
    bodyColumns: columns - 5,
    scroll: { offset: 0, bodyRows: maxRows - 1 },
    view: {},
  },
});

const line = (text: string): ModRenderElement => ({
  type: 'Box',
  children: [{ type: 'Text', children: [text] }],
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Mod session band renders', () => {
  const sessions: ModSession[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.resetAllMocks();
  });

  function setup({ sites = ['AbovePrompt' as const] } = {}) {
    const sessionId = vi.fn(() => 'session-1');
    const extension = {
      id: 'id',
      name: 'token-weather',
      version: '0.1.0',
      path: '/mod',
      isActive: true,
    };
    const config = {
      getSessionId: sessionId,
      getTargetDir: () => '/workspace',
      getProjectRoot: () => '/workspace',
      getModel: () => 'model',
      getCliVersion: () => '1.2.3',
      getExtensions: () => [extension],
      isInteractive: () => true,
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
    };
    const order: string[] = [];
    const runtime = {
      hasToolHooks: false,
      renderHooks: ['token-weather'],
      turnHooks: { start: false, complete: [] as string[] },
      getCommands: () => [],
      runTool: vi.fn<ModToolCall>(async (call, next, signal) =>
        next(call, signal, async (_input, verdict) => verdict),
      ),
      render: vi.fn(async (request: ModRenderInput, _signal: AbortSignal) => {
        order.push(`render ${request.viewport?.columns}`);
        return { tree: line(`${request.viewport?.columns}`), notes: [] };
      }),
      end: vi.fn(async () => {
        order.push('end');
      }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mocks.load.mockResolvedValue({
      root: '/mod',
      entry: '/mod/entry.js',
      source: 'export function register() {}',
      dependencies: [],
    });
    mocks.dependencies.mockResolvedValue([]);
    mocks.create.mockResolvedValue(runtime);
    const host = {
      surface: 'terminal' as const,
      log: vi.fn(),
      presentation: () => ({ isFullscreen: false, columns: 80 }),
      sites: () => sites,
      draw: vi.fn<NonNullable<ModTerminalHost['draw']>>(),
    };
    const session = new ModSession(config as unknown as Config, host);
    sessions.push(session);
    const renderHost = () =>
      mocks.create.mock.lastCall![9] as ModRenderHost | undefined;
    return { config, runtime, host, session, order, renderHost, extension };
  }

  it('renders after session.start and draws the tree the chain settled on', async () => {
    const { session, runtime, host, renderHost } = setup();
    session.setRenderInput(input());
    expect(runtime.render).not.toHaveBeenCalled();
    await session.initialize(new AbortController().signal);
    expect(renderHost()?.sites).toEqual(['AbovePrompt']);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.render).toHaveBeenCalledOnce();
    expect(runtime.render.mock.calls[0][0]).toEqual(input());
    expect(host.draw).toHaveBeenCalledWith(line('80'), 'token-weather');
  });

  it('offers no site and renders nothing where the terminal draws none', async () => {
    const { session, runtime, renderHost } = setup({ sites: [] });
    await session.initialize(new AbortController().signal);
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(200);
    expect(renderHost()).toBeUndefined();
    expect(runtime.render).not.toHaveBeenCalled();
  });

  it('renders on a change of the input key, a resize once it settles, and not for height alone', async () => {
    const { session, runtime, order } = setup();
    await session.initialize(new AbortController().signal);
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(100);
    session.setRenderInput(input({ rows: 30 }));
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.render).toHaveBeenCalledOnce();
    session.setRenderInput(input({ isWorking: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.render).toHaveBeenCalledTimes(2);
    for (const columns of [90, 100, 110]) {
      session.setRenderInput(input({ columns, isWorking: true }));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(runtime.render).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    session.setRenderInput(input({ columns: 110, maxRows: 10 }));
    await vi.advanceTimersByTimeAsync(149);
    expect(order).toEqual(['render 80', 'render 80', 'render 110']);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.render).toHaveBeenCalledTimes(4);
    expect(runtime.render.mock.calls[3][0].props.maxRows).toBe(10);
  });

  it('folds requests into one waiting render and never cancels a running one', async () => {
    const { session, runtime, order, renderHost } = setup();
    await session.initialize(new AbortController().signal);
    const release = deferred();
    runtime.render.mockImplementationOnce(async (request, signal) => {
      order.push(`render ${request.viewport?.columns}`);
      await release.promise;
      expect(signal.aborted).toBe(false);
      return { tree: line('slow'), notes: [] };
    });
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) renderHost()!.invalidate('token-weather');
    session.setRenderInput(input({ isWorking: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.render).toHaveBeenCalledOnce();
    release.resolve();
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.render).toHaveBeenCalledTimes(2);
    expect(runtime.render.mock.calls[1][0].props.isWorking).toBe(true);
  });

  it('waits behind a tool call and reads the latest input when it runs', async () => {
    const { session, runtime, order, renderHost } = setup();
    runtime.hasToolHooks = true;
    await session.initialize(new AbortController().signal);
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(100);
    const tool = deferred();
    const call = session.toolCall(() => {})!(
      { tool: 'write_file' },
      async () => {
        order.push('tool');
        await tool.promise;
        return { result: {} };
      },
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(0);
    renderHost()!.invalidate('token-weather');
    session.setRenderInput(input({ isWorking: true }));
    renderHost()!.invalidate('token-weather');
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual(['render 80', 'tool']);
    tool.resolve();
    await call;
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['render 80', 'tool', 'render 80']);
    expect(runtime.render.mock.calls[1][0].props.isWorking).toBe(true);
  });

  it('keeps to the live rate, and to the steady rate after a slow render', async () => {
    const { session, runtime, renderHost } = setup();
    await session.initialize(new AbortController().signal);
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(0);
    renderHost()!.invalidate('token-weather');
    await vi.advanceTimersByTimeAsync(33);
    expect(runtime.render).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.render).toHaveBeenCalledTimes(2);
    runtime.render.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { tree: line('slow'), notes: [] };
    });
    await vi.advanceTimersByTimeAsync(40);
    renderHost()!.invalidate('token-weather');
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.render).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(50);
    renderHost()!.invalidate('token-weather');
    await vi.advanceTimersByTimeAsync(49);
    expect(runtime.render).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.render).toHaveBeenCalledTimes(4);
  });

  it('renders again once a session switch has ended the old session', async () => {
    const { session, config, runtime, order } = setup();
    await session.initialize(new AbortController().signal);
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(100);
    config.getSessionId.mockReturnValue('session-2');
    await session.syncSession('clear');
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['render 80', 'end', 'render 80']);
    expect(runtime.render).toHaveBeenCalledTimes(2);
  });

  it('draws nothing once the worker fails, and renders nothing after close', async () => {
    const { session, runtime, host, renderHost } = setup();
    await session.initialize(new AbortController().signal);
    runtime.render.mockRejectedValueOnce(new Error('Mod worker exited (1).'));
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(100);
    expect(host.draw).toHaveBeenLastCalledWith(ENGINE_NODE, 'token-weather');
    session.setRenderInput(input({ columns: 100 }));
    await session.close();
    renderHost()!.invalidate('token-weather');
    await vi.advanceTimersByTimeAsync(500);
    expect(runtime.render).toHaveBeenCalledOnce();
  });

  it('leaves the queue to the hooks behind a render whose drawing throws', async () => {
    const { session, runtime, host, order, renderHost } = setup();
    runtime.hasToolHooks = true;
    await session.initialize(new AbortController().signal);
    runtime.render.mockRejectedValueOnce(new Error('Mod worker exited (1).'));
    host.draw.mockImplementationOnce(() => {
      throw new Error('listener failed');
    });
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(100);
    await session.toolCall(() => {})!(
      { tool: 'write_file' },
      async () => {
        order.push('tool');
        return { result: {} };
      },
      new AbortController().signal,
    );
    renderHost()!.invalidate('token-weather');
    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual(['tool', 'render 80']);
    expect(host.draw).toHaveBeenLastCalledWith(line('80'), 'token-weather');
  });

  it('clears the band once its plugin is disabled', async () => {
    const { session, runtime, host, renderHost, extension } = setup();
    await session.initialize(new AbortController().signal);
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(100);
    extension.isActive = false;
    renderHost()!.invalidate('token-weather');
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.render).toHaveBeenCalledOnce();
    expect(host.draw).toHaveBeenLastCalledWith(ENGINE_NODE, 'token-weather');
  });

  it('names the hooks when more than one plugin draws', async () => {
    const { session, runtime, host } = setup();
    runtime.renderHooks = ['token-weather', 'other'];
    await session.initialize(new AbortController().signal);
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(0);
    expect(host.draw).toHaveBeenCalledWith(line('80'), 'hooks');
  });
});
