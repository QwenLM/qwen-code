/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type {
  ModRenderHost,
  ModRuntime,
} from '@qwen-code/qwen-code-core/mods/runtime.js';
import {
  ENGINE_NODE,
  type ModAssistantMessageInput,
  type ModBandInput,
  type ModRenderElement,
  type ModRenderSite,
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
} = {}): ModBandInput => ({
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

const replyRow: ModAssistantMessageInput = {
  surface: 'terminal',
  component: 'AssistantMessage',
  requestId: '1',
  props: { text: 'Original', isFirstOfReply: true },
};

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Mod session renders', () => {
  const sessions: ModSession[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.resetAllMocks();
  });

  function setup({
    sites = ['AbovePrompt'],
  }: { sites?: readonly ModRenderSite[] } = {}) {
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
      renderHooksFor(site: ModRenderSite): readonly string[] {
        return sites.includes(site) ? this.renderHooks : [];
      },
      turnHooks: { start: false, complete: [] as string[] },
      getCommands: () => [],
      runTool: vi.fn<ModToolCall>(async (call, next, signal) =>
        next(call, signal, async (_input, verdict) => verdict),
      ),
      render: vi.fn<ModRuntime['render']>(async (request) => {
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

  it.each(['clear', 'resume'] as const)(
    'cancels a pending render and suppresses its result on %s',
    async (reason) => {
      const { session, config, runtime, host } = setup();
      await session.initialize(new AbortController().signal);
      runtime.render.mockImplementationOnce(async (_input, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { tree: line('old-session'), notes: [] };
      });
      session.setRenderInput(input());
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.render).toHaveBeenCalledOnce();
      const renderSignal = runtime.render.mock.calls[0][1];
      config.getSessionId.mockReturnValue('session-2');
      await session.syncSession(reason);
      expect(renderSignal.aborted).toBe(true);
      expect(host.draw).not.toHaveBeenCalledWith(
        line('old-session'),
        'token-weather',
      );
      await vi.advanceTimersByTimeAsync(1000);
      expect(host.draw).toHaveBeenLastCalledWith(line('80'), 'token-weather');
    },
  );

  it('renders again when a session switch is rolled back', async () => {
    const { session, runtime, host } = setup();
    await session.initialize(new AbortController().signal);
    runtime.render.mockImplementationOnce(async (_input, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { tree: line('cancelled'), notes: [] };
    });
    session.setRenderInput(input());
    await vi.advanceTimersByTimeAsync(0);
    session.invalidateTools();
    await session.restoreTools();
    await vi.advanceTimersByTimeAsync(1000);
    expect(host.draw).not.toHaveBeenCalledWith(
      line('cancelled'),
      'token-weather',
    );
    expect(host.draw).toHaveBeenLastCalledWith(line('80'), 'token-weather');
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
    expect(runtime.render.mock.calls[3][0]).toMatchObject({
      props: { maxRows: 10 },
    });
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
    expect(runtime.render.mock.calls[1][0]).toMatchObject({
      props: { isWorking: true },
    });
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
    expect(runtime.render.mock.calls[1][0]).toMatchObject({
      props: { isWorking: true },
    });
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

  it.each(['clear', 'resume'] as const)(
    'only renders rows from the adopted transcript after %s',
    async (reason) => {
      const { config, runtime, session } = setup({
        sites: ['AssistantMessage'],
      });
      await session.initialize(new AbortController().signal);
      runtime.render.mockResolvedValue({
        tree: ENGINE_NODE,
        notes: [],
        props: { ...replyRow.props, text: 'Rewritten' },
      });
      const release = session.watchRow('session-1', replyRow, () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.render).toHaveBeenCalledOnce();

      config.getSessionId.mockReturnValue('session-2');
      await session.syncSession(reason);
      expect(session.watchRow('session-1', replyRow, () => {})).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.render).toHaveBeenCalledOnce();

      const adoptedRow = {
        ...replyRow,
        props: { ...replyRow.props, text: 'Adopted' },
      };
      session.watchRow('session-2', adoptedRow, () => {});
      release?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.render).toHaveBeenCalledTimes(2);
      expect(runtime.render.mock.lastCall?.[0]).toEqual(adoptedRow);
      expect(session.rowProps('session-1', adoptedRow)).toBeUndefined();
      expect(session.rowProps('session-2', replyRow)).toBeUndefined();
      expect(session.rowProps('session-2', adoptedRow)).toEqual({
        ...replyRow.props,
        text: 'Rewritten',
      });
    },
  );

  it('tells a transcript that switched first when the Mods adopt its session', async () => {
    const { config, runtime, session } = setup({ sites: ['AssistantMessage'] });
    await session.initialize(new AbortController().signal);
    runtime.render.mockResolvedValue({
      tree: ENGINE_NODE,
      notes: [],
      props: { ...replyRow.props, text: 'Rewritten' },
    });
    const adopted = vi.fn();
    session.subscribeSession(adopted);
    // The transcript already belongs to the new session; the Mods do not yet.
    config.getSessionId.mockReturnValue('session-2');
    expect(session.rowSession).toBe('session-1');
    expect(session.watchRow('session-2', replyRow, () => {})).toBeUndefined();

    await session.syncSession('resume');
    expect(adopted).toHaveBeenCalledOnce();
    expect(session.rowSession).toBe('session-2');
    // Asked again, the row renders for the adopted session.
    session.watchRow('session-2', replyRow, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.render).toHaveBeenCalledOnce();
    expect(session.rowProps('session-2', replyRow)).toEqual({
      ...replyRow.props,
      text: 'Rewritten',
    });
  });

  it('aborts a stalled row on its wall-clock deadline and releases the next tool', async () => {
    const { runtime, session } = setup({ sites: ['AssistantMessage'] });
    runtime.hasToolHooks = true;
    await session.initialize(new AbortController().signal);
    const deadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValueOnce(deadline.signal);
    runtime.render.mockImplementationOnce(async (_request, signal) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      signal.throwIfAborted();
      return { tree: ENGINE_NODE, notes: [] };
    });
    try {
      session.watchRow('session-1', replyRow, () => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(timeout).toHaveBeenCalledWith(30_000);
      const tool = session.toolCall(() => {})!(
        { tool: 'write_file' },
        async () => ({ result: {} }),
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.runTool).not.toHaveBeenCalled();
      deadline.abort();
      await tool;
      expect(runtime.runTool).toHaveBeenCalledOnce();
      expect(session.rowProps('session-1', replyRow)).toBeUndefined();
    } finally {
      timeout.mockRestore();
    }
  });
});
