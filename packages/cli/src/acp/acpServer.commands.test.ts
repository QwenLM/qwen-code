/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as acp from '@agentclientprotocol/sdk';
import { ThreadManager } from '../thread-manager/threadManager.js';
import type { CliArgs } from '../config/config.js';
import { AcpServer } from './acpServer.js';
import {
  refreshAcpSessionState,
  type AcpSessionState,
} from './acpSessionHost.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  AuthType,
  beginResumeRead,
  resolveSameRepoTranscriptSession,
  TranscriptStore,
  ModelTransportManager,
  ResourceService,
  type Config,
  type QoderAccountRegion,
  type QwenSubscriptionSession,
  type ResumeTranscriptResult,
} from '@qwen-code/core';
import { SettingScope, type LoadedSettings } from '../config/settings.js';
import { SettingsService } from '@qwen-code/resource';
import { createTestPermissionManager } from '../test-utils/permissionManager.js';
import { ThreadSession } from '../thread-manager/thread-session/threadSession.js';
import { SessionQueryRunner } from '../thread-manager/thread-session/query/sessionQueryRunner.js';

vi.mock(
  '../thread-manager/thread-session/host/sessionPermissionChannel.js',
  () => ({ installThreadPermissionHandling: vi.fn() }),
);

const mocks = vi.hoisted(() => ({ notify: vi.fn(), replay: vi.fn() }));
vi.mock('../core/startupLifecycle.js', () => ({
  runAfterAuthAttemptStartup: vi.fn(),
}));
vi.mock('./acpSupport.js', () => ({
  createDefaultAcpModelAdapter: vi.fn(() => ({})),
  disableAskUserQuestionWithoutElicitation: vi.fn(),
  toLoadedSessionState: (value: unknown) => value,
}));
vi.mock('@qwen-code/core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveSameRepoTranscriptSession: vi.fn(async () => ({
    sessionPath: '/workspace/session.jsonl',
    sessionInfo: { id: 'source', originalCwd: '/workspace' },
  })),
}));
vi.mock('./acpSessionHost.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAcpSessionHost: (params: { sessionId: string }) => {
    const { sessionId } = params;
    const state = {
      ...params,
      sessionId,
      disposed: false,
      callContext: {},
      host: {
        events: { emit: vi.fn() },
        requests: {},
        sendAvailableCommands: () => mocks.notify(sessionId),
        replayHistory: () => mocks.replay(),
        dispose: async () => {
          state.disposed = true;
        },
      },
    };
    return { state };
  },
  refreshAcpSessionState: vi.fn(),
  getAcpSessionResponse: ({ sessionId }: { sessionId: string }) => ({
    sessionId,
  }),
}));
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  vi.useFakeTimers();
  mocks.notify.mockReset();
  mocks.replay.mockReset();
  const checkpoint = vi.fn(async () => {});
  const runner = vi.fn(async () => ({}));
  const afterResponse = vi.fn(async () => {});
  const session = {
    requireConfig: () => ({}),
    getQueryRunner: runner,
    peekQueryRunner: () => ({ getMessages: () => [] }),
    persistSessionCheckpoint: checkpoint,
  };
  const manager = {
    provideHost: vi.fn(),
    subscribe: vi.fn(),
    open: vi.fn(async () => {}),
    initialize: vi.fn(async () => ({ afterResponseSent: afterResponse })),
    get: () => undefined,
    requireSession: () => session,
    close: vi.fn(async () => {}),
  };
  const server = new AcpServer({
    argv: {} as CliArgs,
    manager: manager as unknown as ThreadManager,
    managerReady: Promise.resolve(),
    connection: {} as acp.AgentSideConnection,
  });
  return { server, manager, checkpoint, runner, afterResponse };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function readAcpCandidate(oversizedHistoricalFile = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'resume-acp-'));
  const filePath = path.join(root, 'source.jsonl');
  const store = new TranscriptStore();
  const writer = await store.acquireSessionWriter({
    filePath,
    sessionId: 'source',
    cwd: root,
    entrypoint: 'cli',
  });
  await writer.recordActiveLeaf(null, { explicit: true, durable: true });
  await writer.close();
  const attempt = await beginResumeRead({});
  const readCandidate = (await store
    .repository()
    .readForResume(filePath, {
      sessionId: 'source',
      attempt,
    })) as ResumeTranscriptResult;
  const candidate = oversizedHistoricalFile ? {
    ...readCandidate,
    snapshot: { ...readCandidate.snapshot, size: 64 * 1024 ** 2 + 1 },
  } : readCandidate;
  vi.mocked(resolveSameRepoTranscriptSession).mockResolvedValueOnce({
    sessionPath: filePath,
    messages: candidate.messages,
    fileHistorySnapshots: candidate.fileHistorySnapshots,
    sessionInfo: { id: 'source', originalCwd: root },
    resumeCandidate: candidate,
    resumeAttempt: attempt,
  } as Awaited<ReturnType<typeof resolveSameRepoTranscriptSession>>);
  return {
    root,
    filePath,
    store,
    candidate,
    attempt,
    cleanup: async () => {
      attempt.finish();
      await store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe('ACP 普通恢复候选接线', () => {
  it('admits a historical fork candidate above the former 64 MiB ceiling and releases admission', async () => {
    const f = fixture();
    const candidate = await readAcpCandidate(true);
    try {
      await expect(f.server.unstable_forkSession({
        sessionId: 'source', cwd: candidate.root, mcpServers: [],
      })).resolves.toHaveProperty('sessionId');
      expect(f.manager.open).toHaveBeenCalled();
      expect(() => candidate.attempt.check()).toThrow();
      const next = await beginResumeRead();
      next.finish();
    } finally {
      await candidate.cleanup();
    }
  });

  it('真实 ACP → Manager → ThreadSession → Writer 只消费一次正文，open 归还租约后以新 attempt 接管', async () => {
    const f = await readAcpCandidate();
    const resources = new ResourceService();
    const settings = new SettingsService();
    const manager = new ThreadManager({
      permissionManager: createTestPermissionManager(),
      resourceService: resources,
      settingsService: settings,
      modelProviderFactory: () => [],
      modelTransportManager: new ModelTransportManager([]),
    });
    const server = new AcpServer({
      argv: {} as CliArgs,
      manager,
      managerReady: Promise.resolve(),
      connection: {} as acp.AgentSideConnection,
    });
    try {
      await manager.initializeRuntime({ signal: new AbortController().signal });
      const overrides: Record<string, unknown> = {
        getSessionId: () => 'source',
        getWorkingDir: () => f.root,
        getProjectRoot: () => f.root,
        getSessionArtifactProjectRoot: () => f.root,
        getWorkspaceContext: () => ({ getDirectories: () => [f.root] }),
        getTranscriptStore: () => f.store,
        getSessionPersistence: () => true,
        getOutputFormat: () => 'text',
        dispose: async () => {},
        getModel: () => 'm-1',
        getSkillManager: () => ({
          clearInvokedSkillsForAgent: vi.fn(),
          activateSkill: vi.fn(),
        }),
        // 运行配置经 ModelProviderManager 读写，录制路径要能解析出目录项。
        getModelProviderManager: () => ({
          stop: async () => {},
          getModel: async (key: string) => ({ key, enabled: true }),
          getModelConfig: () => undefined,
        }),
      };
      const config = new Proxy(overrides, {
        get(target, key) {
          if (!(key in target)) Reflect.set(target, key, vi.fn());
          return Reflect.get(target, key);
        },
      }) as unknown as Config;
      vi.spyOn(
        ThreadSession.prototype as unknown as { start(): Promise<void> },
        'start',
      ).mockImplementation(async function (this: ThreadSession) {
        Object.assign(this, { config, settings: {} });
      });
      vi.spyOn(
        SessionQueryRunner.prototype as unknown as {
          openSessionStateStore(): unknown;
        },
        'openSessionStateStore',
      ).mockReturnValue({});
      vi.spyOn(manager, 'initialize').mockResolvedValue({ afterResponseSent: async () => {} } as never);
      const read = vi.spyOn(f.store.repository(), 'readForResume');
      const acquire = vi.spyOn(f.store, 'acquireSessionWriter');
      await server.resumeSession({
        sessionId: 'source',
        cwd: f.root,
        mcpServers: [],
      });
      expect(read).not.toHaveBeenCalled();
      const handed = acquire.mock.calls[0][0].coldResume?.attempt;
      expect(handed).toBeDefined();
      expect(handed).not.toBe(f.attempt);
      // open 阶段读完即归还名额；接管用独立 attempt，装配完成后同样释放。
      expect(() => f.attempt.check()).toThrow();
      expect(() => handed?.check()).toThrow();
      expect(
        manager.requireSession('source').peekQueryRunner()?.getMessages(),
      ).toEqual(f.candidate.messages);
    } finally {
      await manager.shutdown();
      await resources.dispose();
      await settings.dispose();
      await f.cleanup();
    }
  });

  it.each(['directories', 'runner'] as const)(
    '%s 失败由 ACP 幂等释放真实候选',
    async (kind) => {
      const host = fixture();
      vi.useRealTimers();
      const f = await readAcpCandidate();
      try {
        if (kind === 'runner')
          host.runner.mockRejectedValueOnce(new Error('runner failed'));
        const response = host.server.resumeSession({
          sessionId: 'source',
          cwd: f.root,
          mcpServers: [],
          ...(kind === 'directories'
            ? { additionalDirectories: ['relative'] }
            : {}),
        });
        const rejected = response.catch((error: unknown) => error);
        expect(await rejected).toBeInstanceOf(Error);
        expect(() => f.attempt.check()).toThrow();
        const next = await beginResumeRead({});
        next.finish();
      } finally {
        await f.cleanup();
      }
    },
  );

});

describe('ACP blocked prompt command hook', () => {
  class BlockingAcpServer extends AcpServer {
    protected override findBlockedPromptCommand(
      prompt: readonly acp.ContentBlock[],
    ): string | null {
      return prompt.length === 1 &&
        prompt[0].type === 'text' &&
        prompt[0].text.trim().startsWith('/plan')
        ? 'plan'
        : null;
    }
  }

  it('returns Unknown command before submitting a turn', async () => {
    const sendDirectText = vi.fn(async () => ({
      stopReason: 'end_turn' as const,
    }));
    const submitMessage = vi.fn();
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: () => ({ requireConfig: () => ({}) }),
      submitMessage,
    } as unknown as ThreadManager;
    const server = new BlockingAcpServer({
      argv: {} as CliArgs,
      manager,
      managerReady: Promise.resolve(),
      connection: {} as acp.AgentSideConnection,
    });
    const state = {
      sessionId: 'session-1',
      host: { sendDirectText },
      active: false,
    } as unknown as AcpSessionState;
    (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions.set('session-1', state);

    const response = await server.prompt({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: '/plan' }],
    });

    expect(sendDirectText).toHaveBeenCalledWith('Unknown command: /plan');
    expect(response).toEqual({ stopReason: 'end_turn' });
    expect(submitMessage).not.toHaveBeenCalled();
  });
});

describe('ACP prompt identity', () => {
  it('uses the client-provided messageId as the user message uuid', async () => {
    const submitMessage = vi.fn(async (..._args: unknown[]) => {});
    let resolvePrompt!: (response: acp.PromptResponse) => void;
    const beginPrompt = vi.fn(() => ({
      promise: new Promise<acp.PromptResponse>((resolve) => {
        resolvePrompt = resolve;
      }),
      fail: vi.fn(),
    }));
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: () => ({ requireConfig: () => ({}) }),
      submitMessage,
    } as unknown as ThreadManager;
    const server = new AcpServer({
      argv: {} as CliArgs,
      manager,
      managerReady: Promise.resolve(),
      connection: {
        sessionUpdate: vi.fn(async () => ({})),
      } as unknown as acp.AgentSideConnection,
    });
    const state = {
      sessionId: 'session-1',
      host: { beginPrompt },
      callContext: {},
      abortController: new AbortController(),
      active: false,
    } as unknown as AcpSessionState;
    (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions.set('session-1', state);

    void server.prompt({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hi' }],
      messageId: 'client-message-1',
    });

    await vi.waitFor(() => expect(submitMessage).toHaveBeenCalledOnce());
    expect(beginPrompt).toHaveBeenCalledWith('client-message-1', 'hi');
    expect(submitMessage.mock.calls[0]![2]).toMatchObject({
      uuid: 'client-message-1',
    });
    resolvePrompt({ stopReason: 'end_turn' });
  });
});

describe('ACP initial command notification ordering', () => {
  it('waits for the checkpoint and sends commands after the new-session response', async () => {
    const f = fixture();
    const gate = deferred();
    f.checkpoint.mockImplementation(() => gate.promise);
    const response = f.server.newSession({ cwd: '/workspace', mcpServers: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.checkpoint).toHaveBeenCalledOnce();
    expect(f.afterResponse).toHaveBeenCalledOnce();
    expect(mocks.notify).not.toHaveBeenCalled();
    gate.resolve();
    const { sessionId } = await response;
    expect(mocks.notify).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith(sessionId);
  });
  it('does not advertise a session whose checkpoint fails', async () => {
    const f = fixture();
    const gate = deferred();
    f.checkpoint.mockImplementation(() => gate.promise);
    const response = f.server.newSession({ cwd: '/workspace', mcpServers: [] });
    const rejected = response.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.notify).not.toHaveBeenCalled();
    gate.reject(new Error('checkpoint failed'));
    expect(await rejected).toMatchObject({ message: 'checkpoint failed' });
    await vi.runAllTimersAsync();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('waits for history replay before advertising a loaded session', async () => {
    const f = fixture();
    const gate = deferred();
    mocks.replay.mockImplementation(() => gate.promise);
    const response = f.server.loadSession({
      sessionId: 'source',
      cwd: '/workspace',
      mcpServers: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.replay).toHaveBeenCalledOnce();
    expect(mocks.notify).not.toHaveBeenCalled();
    gate.resolve();
    await response;
    expect(mocks.notify).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(mocks.notify).toHaveBeenCalledExactlyOnceWith('source');
  });
  it.each(['resume', 'fork'] as const)(
    'waits for runner preparation on %s',
    async (method) => {
      const f = fixture();
      const gate = deferred();
      f.runner.mockImplementation(async () => {
        await gate.promise;
        return {};
      });
      const request = {
        sessionId: 'source',
        cwd: '/workspace',
        mcpServers: [],
      };
      const response =
        method === 'resume'
          ? f.server.resumeSession(request)
          : f.server.unstable_forkSession(request);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.runner).toHaveBeenCalledOnce();
      expect(mocks.notify).not.toHaveBeenCalled();
      gate.resolve();
      await response;
      expect(mocks.notify).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(mocks.notify).toHaveBeenCalledOnce();
    },
  );
  it('does not publish the queued command list after the session closes', async () => {
    const f = fixture();
    const { sessionId } = await f.server.newSession({
      cwd: '/workspace',
      mcpServers: [],
    });
    await f.server.closeSession({ sessionId });
    await vi.runAllTimersAsync();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe('ACP authentication and provider readiness', () => {
  class TestAuthAcpServer extends AcpServer {
    constructor(
      params: ConstructorParameters<typeof AcpServer>[0],
      private readonly subscriptionSession: QwenSubscriptionSession,
      readonly openedUrls: string[] = [],
      private readonly options: {
        readonly qoderDeviceLogin?: (region: QoderAccountRegion) => {
          readonly authUrl: string;
          readonly completion: Promise<unknown>;
        };
      } = {},
    ) {
      super(params);
    }

    protected override createSubscriptionSession(): QwenSubscriptionSession {
      return this.subscriptionSession;
    }

    protected override startQoderDeviceLogin(region: QoderAccountRegion) {
      if (this.options.qoderDeviceLogin) {
        return this.options.qoderDeviceLogin(region);
      }
      return super.startQoderDeviceLogin(region);
    }

    protected override async openBrowser(url: string): Promise<void> {
      this.openedUrls.push(url);
    }
  }

  it('advertises qwen-subscription and qoder-oauth options in initialize authMethods', async () => {
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as ThreadManager;
    const server = new AcpServer({
      argv: {} as CliArgs,
      manager,
      managerReady: Promise.resolve(),
      connection: {} as acp.AgentSideConnection,
    });
    const response = await server.initialize({ protocolVersion: 1 });
    expect(response.authMethods).toEqual([
      expect.objectContaining({
        id: AuthType.QWEN_SUBSCRIPTION,
      }),
      expect.objectContaining({
        id: `${AuthType.QODER_OAUTH}:global`,
      }),
      expect.objectContaining({
        id: `${AuthType.QODER_OAUTH}:cn`,
      }),
    ]);
  });

  it('rejects prompt with authRequired and authMethods when no session ModelProvider is available', async () => {
    const submitMessage = vi.fn(async (..._args: unknown[]) => {});
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: () => ({
        requireConfig: () => ({
          hasModelProviderManager: () => false,
        }),
      }),
      submitMessage,
    } as unknown as ThreadManager;
    const session = {
      isSignedIn: vi.fn(() => false),
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        connection: {
          sessionUpdate: vi.fn(async () => ({})),
        } as unknown as acp.AgentSideConnection,
      },
      session,
    );
    const state = {
      sessionId: 'session-1',
      host: { beginPrompt: vi.fn() },
      callContext: {},
      abortController: new AbortController(),
      active: false,
    } as unknown as AcpSessionState;
    (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions.set('session-1', state);

    await expect(
      server.prompt({
        sessionId: 'session-1',
        prompt: [{ type: 'text', text: 'hello' }],
      }),
    ).rejects.toMatchObject({
      code: -32000,
      data: {
        authMethods: [
          expect.objectContaining({ id: AuthType.QWEN_SUBSCRIPTION }),
          expect.objectContaining({ id: `${AuthType.QODER_OAUTH}:global` }),
          expect.objectContaining({ id: `${AuthType.QODER_OAUTH}:cn` }),
        ],
      },
    });
    expect(submitMessage).not.toHaveBeenCalled();
  });

  it('authenticates qwen-subscription, notifies client, persists setting, and attaches provider to active sessions', async () => {
    const extNotification = vi.fn(async () => {});
    const setValue = vi.fn(() => true);
    const registerAccountProvider = vi.fn(async () => {});
    const config = {
      getModelProviderManager: () => ({ registerAccountProvider }),
      getSettingsService: () => new SettingsService(),
      getModelTransportManager: () => ({ resolve: vi.fn(() => ({})) }),
    };
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: () => ({ requireConfig: () => config }),
    } as unknown as ThreadManager;
    const signIn = vi.fn(async (onDevice: (device: { user_code: string }) => void) => {
      onDevice({ user_code: 'ABCD-1234' });
      return { email: 'user@example.com', member_type: 'pro' };
    });
    const getModels = vi.fn(async () => ({
      models: ['qwen4.0-max-preview'],
      cached: false,
    }));
    const session = {
      signIn,
      getModels,
      isSignedIn: () => true,
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        settings: { setValue } as unknown as LoadedSettings,
        connection: {
          extNotification,
        } as unknown as acp.AgentSideConnection,
      },
      session,
    );
    const state = {
      sessionId: 'session-1',
      host: { beginPrompt: vi.fn() },
      callContext: {},
      abortController: new AbortController(),
      active: false,
    } as unknown as AcpSessionState;
    (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions.set('session-1', state);

    await Promise.all([
      server.authenticate({ methodId: AuthType.QWEN_SUBSCRIPTION }),
      server.authenticate({ methodId: AuthType.QWEN_SUBSCRIPTION }),
    ]);

    expect(signIn).toHaveBeenCalledOnce();
    expect(extNotification).toHaveBeenCalledWith(
      'authenticate/update',
      expect.objectContaining({
        _meta: expect.objectContaining({
          authUri: expect.stringContaining('user_code=ABCD-1234'),
        }),
      }),
    );
    expect(server.openedUrls).toHaveLength(1);
    expect(server.openedUrls[0]).toContain('user_code=ABCD-1234');
    expect(getModels).toHaveBeenCalledOnce();
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.QWEN_SUBSCRIPTION,
    );
    expect(registerAccountProvider).toHaveBeenCalledOnce();
  });

  it('rejects authenticate with authRequired when the account does not have an active paid subscription', async () => {
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as ThreadManager;
    const session = {
      signIn: vi.fn(async () => ({ email: 'free@example.com', member_type: 'free' })),
      getModels: vi.fn(),
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        connection: {} as acp.AgentSideConnection,
      },
      session,
    );

    await expect(
      server.authenticate({ methodId: AuthType.QWEN_SUBSCRIPTION }),
    ).rejects.toMatchObject({
      code: -32000,
    });
    expect(session.getModels).not.toHaveBeenCalled();
  });

  it('rejects newSession with authRequired and skips checkpoint when no session ModelProvider is available', async () => {
    const persistSessionCheckpoint = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      open: vi.fn(async () => {}),
      initialize: vi.fn(async () => ({ afterResponseSent: async () => {} })),
      close,
      requireSession: () => ({
        requireConfig: () => ({
          hasModelProviderManager: () => false,
        }),
        getQueryRunner: vi.fn(async () => ({})),
        persistSessionCheckpoint,
      }),
    } as unknown as ThreadManager;
    const session = {
      isSignedIn: vi.fn(() => false),
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        connection: {} as acp.AgentSideConnection,
      },
      session,
    );

    await expect(
      server.newSession({ cwd: '/workspace', mcpServers: [] }),
    ).rejects.toMatchObject({
      code: -32000,
      data: {
        authMethods: [
          expect.objectContaining({ id: AuthType.QWEN_SUBSCRIPTION }),
          expect.objectContaining({ id: `${AuthType.QODER_OAUTH}:global` }),
          expect.objectContaining({ id: `${AuthType.QODER_OAUTH}:cn` }),
        ],
      },
    });
    expect(persistSessionCheckpoint).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects newSession with authRequired when registered providers have an empty model catalog', async () => {
    const persistSessionCheckpoint = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      open: vi.fn(async () => {}),
      initialize: vi.fn(async () => ({ afterResponseSent: async () => {} })),
      close,
      requireSession: () => ({
        requireConfig: () => ({
          hasModelProviderManager: () => true,
          getModelProviderManager: () => ({
            listModels: vi.fn(async () => []),
          }),
        }),
        getQueryRunner: vi.fn(async () => ({})),
        persistSessionCheckpoint,
      }),
    } as unknown as ThreadManager;
    const session = {
      isSignedIn: vi.fn(() => false),
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        connection: {} as acp.AgentSideConnection,
      },
      session,
    );

    await expect(
      server.newSession({ cwd: '/workspace', mcpServers: [] }),
    ).rejects.toMatchObject({
      code: -32000,
      data: {
        authMethods: [
          expect.objectContaining({ id: AuthType.QWEN_SUBSCRIPTION }),
          expect.objectContaining({ id: `${AuthType.QODER_OAUTH}:global` }),
          expect.objectContaining({ id: `${AuthType.QODER_OAUTH}:cn` }),
        ],
      },
    });
    expect(persistSessionCheckpoint).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('authenticates qoder-oauth:cn, notifies client, persists region/type, and attaches provider', async () => {
    const extNotification = vi.fn(async () => {});
    const setValue = vi.fn(() => true);
    const registerAccountProvider = vi.fn(async () => {});
    const listModels = vi.fn(async () => [{ key: 'auto', source: 'qoder' }]);
    const config = {
      getModelProviderManager: () => ({ registerAccountProvider, listModels }),
      getSettingsService: () => new SettingsService(),
      getModelTransportManager: () => ({ resolve: vi.fn(() => ({})) }),
    };
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: () => ({ requireConfig: () => config }),
    } as unknown as ThreadManager;
    const qoderDeviceLogin = vi.fn((region: QoderAccountRegion) => ({
      authUrl: `https://qoder.${region === 'cn' ? 'cn' : 'com'}/oauth/authorize`,
      completion: Promise.resolve(),
    }));
    const session = {
      isSignedIn: () => false,
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        settings: { setValue } as unknown as LoadedSettings,
        connection: {
          extNotification,
        } as unknown as acp.AgentSideConnection,
      },
      session,
      [],
      { qoderDeviceLogin },
    );
    const state = {
      sessionId: 'session-1',
      host: { beginPrompt: vi.fn() },
      callContext: {},
      abortController: new AbortController(),
      active: false,
    } as unknown as AcpSessionState;
    (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions.set('session-1', state);

    await server.authenticate({ methodId: `${AuthType.QODER_OAUTH}:cn` });

    expect(qoderDeviceLogin).toHaveBeenCalledWith('cn');
    expect(extNotification).toHaveBeenCalledWith('authenticate/update', {
      _meta: { authUri: 'https://qoder.cn/oauth/authorize' },
    });
    expect(server.openedUrls).toEqual(['https://qoder.cn/oauth/authorize']);
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.qoderRegion',
      'cn',
    );
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.QODER_OAUTH,
    );
    expect(registerAccountProvider).toHaveBeenCalledOnce();
    expect(listModels).toHaveBeenCalledWith({ skipCache: true });
  });

  it('preserves modelsChanged across model sync and sends config_option_update after authenticate', async () => {
    const sessionUpdate = vi.fn(async () => ({}));
    const setModel = vi.fn(async () => true);
    const registerAccountProvider = vi.fn(async () => {});
    const config = {
      getModel: () => 'auto',
      setModel,
      getModelProviderManager: () => ({ registerAccountProvider }),
      getSettingsService: () => new SettingsService(),
      getModelTransportManager: () => ({ resolve: vi.fn(() => ({})) }),
    };
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: () => ({ requireConfig: () => config }),
    } as unknown as ThreadManager;
    const session = {
      signIn: vi.fn(async () => ({ email: 'u@example.com', member_type: 'pro' })),
      getModels: vi.fn(async () => ({ models: ['qwen4-max'], cached: false })),
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        connection: { sessionUpdate } as unknown as acp.AgentSideConnection,
      },
      session,
    );
    const updatedOptions = [{ type: 'select', id: 'model', name: 'Model', currentValue: 'qwen-subscription/qwen4-max', options: [] }];
    const state = {
      sessionId: 'session-1',
      host: { beginPrompt: vi.fn() },
      callContext: {},
      abortController: new AbortController(),
      active: true,
      disposed: false,
      updateChain: Promise.resolve(),
      models: {
        availableModels: [{ modelId: 'qwen-subscription/qwen4-max', name: 'Qwen4-Max' }],
        currentModelId: 'qwen-subscription/qwen4-max',
      },
      configOptions: updatedOptions,
    } as unknown as AcpSessionState;
    (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions.set('session-1', state);

    vi.mocked(refreshAcpSessionState)
      .mockResolvedValueOnce({ modeChanged: false, modelsChanged: true })
      .mockResolvedValueOnce({ modeChanged: false, modelsChanged: false });

    await server.authenticate({ methodId: AuthType.QWEN_SUBSCRIPTION });

    expect(setModel).toHaveBeenCalledWith('qwen-subscription/qwen4-max', true);
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: updatedOptions,
      },
    });
  });

  it('isolates per-session provider attachment failures during authenticate', async () => {
    const failingRegister = vi.fn(async () => {
      throw new Error('provider start failed');
    });
    const succeedingRegister = vi.fn(async () => {});
    const configs = new Map<string, unknown>([
      [
        'session-bad',
        {
          getModelProviderManager: () => ({
            registerAccountProvider: failingRegister,
          }),
          getSettingsService: () => new SettingsService(),
          getModelTransportManager: () => ({ resolve: vi.fn(() => ({})) }),
        },
      ],
      [
        'session-good',
        {
          getModelProviderManager: () => ({
            registerAccountProvider: succeedingRegister,
          }),
          getSettingsService: () => new SettingsService(),
          getModelTransportManager: () => ({ resolve: vi.fn(() => ({})) }),
        },
      ],
    ]);
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: (id: string) => ({ requireConfig: () => configs.get(id) }),
    } as unknown as ThreadManager;
    const session = {
      signIn: vi.fn(async () => ({ email: 'u@example.com', member_type: 'pro' })),
      getModels: vi.fn(async () => ({ models: ['qwen4-max'], cached: false })),
    } as unknown as QwenSubscriptionSession;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        connection: {} as acp.AgentSideConnection,
      },
      session,
    );
    const sessions = (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions;
    sessions.set('session-bad', { sessionId: 'session-bad' } as AcpSessionState);
    sessions.set('session-good', { sessionId: 'session-good' } as AcpSessionState);

    await expect(
      server.authenticate({ methodId: AuthType.QWEN_SUBSCRIPTION }),
    ).resolves.toBeUndefined();
    expect(failingRegister).toHaveBeenCalledOnce();
    expect(succeedingRegister).toHaveBeenCalledOnce();
  });

  it('skips redundant refreshAcpSessionState on prompt when session models are already aligned', async () => {
    vi.mocked(refreshAcpSessionState).mockClear();
    const submitMessage = vi.fn(async (..._args: unknown[]) => {});
    const beginPrompt = vi.fn(() => ({
      promise: Promise.resolve({ stopReason: 'end_turn' as const }),
      fail: vi.fn(),
    }));
    const config = {
      hasModelProviderManager: () => true,
      getModel: () => 'qwen-subscription/qwen4-max',
      getModelProviderManager: () => ({
        listModels: vi.fn(async () => [{ key: 'qwen-subscription/qwen4-max' }]),
      }),
    };
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
      requireSession: () => ({ requireConfig: () => config }),
      submitMessage,
    } as unknown as ThreadManager;
    const server = new TestAuthAcpServer(
      {
        argv: {} as CliArgs,
        manager,
        managerReady: Promise.resolve(),
        connection: {} as acp.AgentSideConnection,
      },
      { isSignedIn: () => true } as unknown as QwenSubscriptionSession,
    );
    const state = {
      sessionId: 'session-1',
      host: { beginPrompt },
      callContext: {},
      abortController: new AbortController(),
      active: false,
      models: {
        availableModels: [{ modelId: 'qwen-subscription/qwen4-max', name: 'Qwen4-Max' }],
        currentModelId: 'qwen-subscription/qwen4-max',
      },
    } as unknown as AcpSessionState;
    (
      server as unknown as { sessions: Map<string, AcpSessionState> }
    ).sessions.set('session-1', state);

    await server.prompt({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(refreshAcpSessionState).not.toHaveBeenCalled();
    expect(submitMessage).toHaveBeenCalledOnce();
  });

  it('rejects unknown auth methods with invalid params', async () => {
    const manager = {
      provideHost: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as ThreadManager;
    const server = new AcpServer({
      argv: {} as CliArgs,
      manager,
      managerReady: Promise.resolve(),
      connection: {} as acp.AgentSideConnection,
    });

    await expect(
      server.authenticate({ methodId: 'unknown-method' }),
    ).rejects.toMatchObject({
      code: -32602,
    });
  });
});
