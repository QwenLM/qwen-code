/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ThreadManager` 的契约。
 *
 * 被保护的不变量：
 * 1. **Manager 对会话零知识。** 会话由注入的工厂造，出站与反向请求由注入的 host 收。
 *    本文件不 mock 任何 SDK / Config / 模型目录，因此这些用例能跑起来本身就是
 *    「Manager 没有协议依赖」的证据。磁盘那三个操作直接落到 `@qwen-code/core/sessions` 的
 *    进程级 sessionManager，本文件用 `vi.mock` 打桩它。
 * 2. **工厂返回即视为已启动**，中间不存在「造好但没启动」的窗口。
 * 3. **三个生命周期不变量**（见 threadManager.ts 文件头）：终止恰好上报一次；装配期间
 *    的终止不丢、且不抢在 `sessionOpened` 前面；同一 id 同时只有一个在世会话。
 * 4. **能力路由只做一件事**：按 id 找到会话并转调同名方法，参数原样传、返回值原样回。
 *    未知会话的错误语义集中在 `requireSession` 一处。
 * 5. **observer 异常不影响主流程。**
 *
 * 不测的：45 个能力方法各自的语义——那是 `ThreadSession` 的职责，各有自己的用例。
 * 这里只抽查几个代表，证明路由形状对了。
 */

import { createCliSettingsService } from '../config/createCliSettingsService.js';
import { createTestPermissionManager } from '../test-utils/permissionManager.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@qwen-code/core/sessions';
import { SettingsService } from '@qwen-code/resource';
import {
  ModelTransportManager,
  CustomProviderManager,
  ResourceService,
  Storage,
  beginResumeRead,
  TranscriptRepository,
} from '@qwen-code/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

afterEach(() => vi.restoreAllMocks());

/**
 * 磁盘仓库的桩。`ThreadManager` 直接 import `@qwen-code/core/sessions` 的进程级
 * `sessionManager`，所以打桩点是这个模块而不是某个注入端口。
 */
const sessionManagerStub = vi.hoisted(() => ({
  list: vi.fn(),
  listAll: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@qwen-code/core/sessions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionManager: sessionManagerStub,
}));
/**
 * 会话类打桩。`ThreadManager` 现在自己调 `ThreadSession.create`，所以打桩点在这个模块。
 * 刻意**不**用 `importOriginal`：真模块拖着整条 cli 装配链（loadCliConfig、全量工具、
 * UI 模块），引回来就丢掉「本文件不碰 Config / SDK 也能跑」这个性质了——那个性质正是
 * 「Manager 没有协议依赖」的机械证据。
 */
const threadSessionStub = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('./thread-session/threadSession.js', () => ({
  ThreadSession: { create: threadSessionStub.create },
}));

/**
 * fork 的执行由 Manager 负责，但本文件不落真实磁盘：replace 掉 helper 的副作用，
 * `toThreadResumeData` 保留真实实现，断言 Manager 交给 Session 的恢复数据形状。
 */
const forkStub = vi.hoisted(() => ({
  create: vi.fn(),
  rollback: vi.fn(),
}));

vi.mock('./open/createForkTranscript.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createForkTranscript: forkStub.create,
    rollbackForkTranscript: forkStub.rollback,
  };
});

/** open 请求里的 cliArgs 是产品数据，本文件只关心它被原样转交，不关心内容。 */
const STUB_CLI_ARGS = { _: [], $0: 'qwen' } as never;

import {
  ThreadManager,
  type ThreadManagerEvent,
} from './threadManager.js';
import type {
  ThreadCallContext,
  ThreadEvent,
  ThreadHost,
  ThreadTerminationReason,
} from './thread-session/contract/hostContext.js';
import type { ThreadSession } from './thread-session/threadSession.js';
import type { ThreadUserMessage } from './thread-session/contract/threadSessionTypes.js';

interface StubSession {
  readonly sessionId: string;
  readonly termination: Promise<ThreadTerminationReason>;
  readonly events: ThreadEvent[];
  closeCount: number;
  retireCount: number;
  /** 测试用：让会话自行终止。 */
  terminate(reason: ThreadTerminationReason): Promise<void>;
  closeChannel(): Promise<{ transcriptFlushed: Promise<void> }>;
  retire(): Promise<void>;
  close(): Promise<void>;
  releaseResumeLease(): void;
  /** 路由抽查用的能力桩。 */
  setGoal: ReturnType<typeof vi.fn>;
  interrupt: ReturnType<typeof vi.fn>;
  submitMessage: ReturnType<typeof vi.fn>;
  applyDaemonProxy: ReturnType<typeof vi.fn>;
}

interface Harness {
  readonly manager: ThreadManager;
  readonly store: typeof sessionManagerStub;
  readonly factory: typeof threadSessionStub.create;
  readonly sessions: StubSession[];
  readonly events: ThreadManagerEvent[];
  readonly emitted: ThreadEvent[];
  readonly hosts: ThreadHost[];
  readonly hostRequests: Record<string, ReturnType<typeof vi.fn>>;
}

/** 每个 harness 重置一次：桩是模块级的，用例之间不能互相看到调用记录。 */
function resetSessionManagerStub(): void {
  sessionManagerStub.list
    .mockReset()
    .mockResolvedValue([] as readonly Session[]);
  sessionManagerStub.listAll
    .mockReset()
    .mockResolvedValue([] as readonly Session[]);
  sessionManagerStub.rename
    .mockReset()
    .mockImplementation(
      async (_dir: string, id: string, title: string) =>
        ({ id, title }) as unknown as Session,
    );
  sessionManagerStub.delete.mockReset().mockResolvedValue(true);
}

function newStubSession(sessionId: string, sink: ThreadEvent[]): StubSession {
  let resolveTermination!: (reason: ThreadTerminationReason) => void;
  const termination = new Promise<ThreadTerminationReason>((resolve) => {
    resolveTermination = resolve;
  });
  const session: StubSession = {
    sessionId,
    termination,
    events: sink,
    closeCount: 0,
    retireCount: 0,
    async terminate(reason) {
      resolveTermination(reason);
      // 多等一个微任务：让 Manager 挂在 termination 上的处理跑完，断言不用自己数 tick。
      await Promise.resolve();
    },
    async closeChannel() {
      session.closeCount += 1;
      return { transcriptFlushed: Promise.resolve() };
    },
    async retire() {
      session.retireCount += 1;
    },
    async close() {
      await session.closeChannel();
      await session.retire();
    },
    releaseResumeLease: vi.fn(),
    setGoal: vi.fn(async () => ({ ok: true })),
    interrupt: vi.fn(async () => {}),
    submitMessage: vi.fn(async () => ({
      commandUuid: 'u-1',
      disposition: 'queued' as const,
    })),
    applyDaemonProxy: vi.fn(),
  };
  return session;
}

function makeHarness(
  injectedResourceService?: ResourceService,
  injectedSettingsService?: SettingsService,
  customProviderManager?: CustomProviderManager,
): Harness {
  resetSessionManagerStub();
  forkStub.create.mockReset();
  forkStub.rollback.mockReset();
  forkStub.rollback.mockResolvedValue(undefined);
  const store = sessionManagerStub;
  const sessions: StubSession[] = [];
  const emitted: ThreadEvent[] = [];
  const hosts: ThreadHost[] = [];
  const hostRequests = {
    canUseTool: vi.fn(),
    elicit: vi.fn(),
    runHookCallback: vi.fn(),
    getModelPolicy: vi.fn(),
    resolveSessionArtifacts: vi.fn(),
    sendMcpMessage: vi.fn(),
    shouldGenerateMemory: vi.fn(),
    shouldReviewSkillEvolution: vi.fn(),
  };
  threadSessionStub.create.mockReset();
  threadSessionStub.create.mockImplementation(
    async (params: { sessionId: string; cwd: string; host: ThreadHost }) => {
      const session = newStubSession(params.sessionId, emitted);
      sessions.push(session);
      return session as unknown as ThreadSession;
    },
  );
  const factory = threadSessionStub.create;
  const manager = new ThreadManager({
    permissionManager: createTestPermissionManager(),
    modelProviderFactory: () => [],
    modelTransportManager: new ModelTransportManager([]),
    ...(injectedResourceService
      ? { resourceService: injectedResourceService }
      : {}),
    settingsService: injectedSettingsService,
    customProviderManager,
    createHost: () => {
      const host = {
        events: {
          emit: (event: ThreadEvent) => {
            emitted.push(event);
          },
        },
        requests: hostRequests,
      } as unknown as ThreadHost;
      hosts.push(host);
      return host;
    },
  });
  const events: ThreadManagerEvent[] = [];
  manager.subscribe((event) => {
    events.push(event);
  });
  void manager.initializeRuntime({ signal: new AbortController().signal });
  return {
    manager,
    store,
    factory,
    sessions,
    events,
    emitted,
    hosts,
    hostRequests,
  };
}

const ctx = { signal: new AbortController().signal } as ThreadCallContext;

function open(h: Harness, sessionId = 'sess-1', cwd = '/proj'): Promise<string> {
  return h.manager.open({ sessionId, cwd, cliArgs: STUB_CLI_ARGS });
}

describe('open：装配即建会话', () => {
  it('CustomProviderManager 跨会话原样借用，ThreadManager 退出不回收共享服务', async () => {
    const settings = createCliSettingsService({ environmentPolicy: 'session' });
    const custom = new CustomProviderManager(settings);
    const h = makeHarness(undefined, settings, custom);
    try {
      await open(h, 'first', '/first');
      await open(h, 'second', '/second');
      expect(h.factory.mock.calls.map(([params]) => params.customProviderManager)).toEqual([custom, custom]);
      await h.manager.shutdown();
      expect(h.sessions.every((session) => session.retireCount === 1)).toBe(true);
      expect(Reflect.get(custom, 'settingsService')).toBe(settings);
      expect(Reflect.has(custom, 'config')).toBe(false);
      expect(await custom.check({ providerId: 'test', baseUrl: 'https://test.example', apiKey: '', model: 'test' })).toBeUndefined();
    } finally {
      await h.manager.shutdown();
      await settings.dispose();
    }
  });
  it('shares one settings service across sessions without owning its lifecycle', async () => {
    const settings = createCliSettingsService({ environmentPolicy: 'session' });
    const h = makeHarness(undefined, settings);
    try {
      await open(h, 'global-first');
      await open(h, 'global-second');
      expect(h.factory.mock.calls).toHaveLength(2);
      for (const [params] of h.factory.mock.calls) {
        expect(params.settingsService).toBe(settings);
      }
      await h.manager.shutdown();
    } finally {
      await h.manager.shutdown();
      await settings.dispose();
    }
  });

  it.each(['owned', 'bare', 'initialized'] as const)('初始化时固定用户文件源，不依赖会话来源过滤（注入=%s）', async (injected) => {
    const settings = injected !== 'owned' ? new SettingsService() : undefined;
    if (injected === 'initialized') settings!.initialize({ userConfigDir: Storage.getGlobalConfigDir() });
    const h = makeHarness(undefined, settings);
    try {
      await h.manager.open({
        sessionId: 'project-only-first',
        cwd: '/proj',
        cliArgs: { _: [], $0: 'qwen', settingSources: ['project'] } as never,
      });
      const service = h.factory.mock.calls[0]![0].settingsService as SettingsService;
      expect(service.peekUserSettingsSource()?.path).toBe(Storage.getGlobalSettingsPath());
      // Exercise the real resolver used by ThreadSession, not only its factory stub.
      const resolved = service.resolve({
        projectPath: '/proj',
        sources: [],
        flagSettings: { model: 'injected-model' },
      });
      expect(resolved.merged.model.name).toBe('injected-model');
      expect(resolved.merged.ui).toBeDefined();
      expect(() => service.resolve({
        projectPath: '/proj', sources: [], flagSettings: '/missing-settings-4456.json',
      })).toThrow('Please fix the configuration file(s) and try again.');
    } finally {
      await h.manager.shutdown();
      await settings?.dispose();
    }
  });

  it('rejects a command-policy service before creating a session', async () => {
    const service = createCliSettingsService();
    const h = makeHarness(undefined, service);
    try {
      await expect(h.manager.initializeRuntime({ signal: new AbortController().signal })).rejects.toThrow('CLI policy is incompatible');
      expect(h.factory).not.toHaveBeenCalled();
    } finally {
      await h.manager.shutdown();
      await service.dispose();
    }
  });

  it('初始化时保留宿主已绑定的用户根目录', async () => {
    const settings = new SettingsService();
    const source = settings.getUserSettingsSource(`${Storage.getGlobalSettingsPath()}.host`);
    const h = makeHarness(undefined, settings);
    try {
      await open(h);
      expect(settings.peekUserSettingsSource()).toBe(source);
      const resolved = settings.resolve({ projectPath: '/proj', sources: [] });
      expect(resolved.user.path).toBe(source.path);
      expect(resolved.merged.ui).toBeDefined();
    } finally {
      await h.manager.shutdown();
      await settings.dispose();
    }
  });

  it('把 sessionId / cwd / host / cliArgs 交给 ThreadSession.create', async () => {
    const h = makeHarness();
    await expect(open(h)).resolves.toBe('sess-1');

    expect(h.factory).toHaveBeenCalledTimes(1);
    const params = h.factory.mock.calls[0]![0];
    expect(params.sessionId).toBe('sess-1');
    expect(params.cwd).toBe('/proj');
    // host 是会话级通道：出站事件与八个反向请求都挂它，构造时给一次。
    expect(typeof params.host.events.emit).toBe('function');
    expect(params.host.requests).toBe(h.hostRequests);
    // cliArgs 原样转交：argv 怎么解析是宿主胶水的事，Manager 不解释它。
    expect(params.cliArgs).toBe(STUB_CLI_ARGS);
    expect(params.modelProviderFactory()).toEqual([]);
    // sourceTranscriptPath 没传就不该出现 resumeTranscriptPath——「缺字段」与
    // 「传 undefined」在会话装配上走的是不同分支。
    expect('resumeTranscriptPath' in params).toBe(false);
  });

  it('cwd 原样透传，不再回落到进程 cwd（daemon 已无 cwd 概念）', async () => {
    const h = makeHarness();
    // 传入一个刻意不同于 process.cwd() 的目录：Manager 必须原样交给会话，
    // 绝不能用进程目录兜底——那正是本次要消灭的 daemon 级 cwd 概念。
    const explicit = '/some/where/else';
    await h.manager.open({
      sessionId: 'sess-1',
      cwd: explicit,
      cliArgs: STUB_CLI_ARGS,
    });
    expect(h.factory.mock.calls[0]![0].cwd).toBe(explicit);
    expect(h.factory.mock.calls[0]![0].cwd).not.toBe(process.cwd());
  });

  it('host.events.emit 是会话的唯一出站口，Manager 不再另设 transport', async () => {
    const h = makeHarness();
    await open(h);

    h.hosts[0]!.events.emit({
      kind: 'notice',
      notice: { kind: 'goalCleared', goalId: 'goal-1' },
    });

    expect(h.emitted).toEqual([
      { kind: 'notice', notice: { kind: 'goalCleared', goalId: 'goal-1' } },
    ]);
  });

  it('重复 open 已存在的 id 回 SESSION_ALREADY_OPEN(active)，不再调工厂', async () => {
    const h = makeHarness();
    await open(h);
    await expect(open(h)).rejects.toMatchObject({
      name: 'ThreadSessionAlreadyOpenError',
      code: 'SESSION_ALREADY_OPEN',
      sessionId: 'sess-1',
      state: 'active',
    });

    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.sessions).toHaveLength(1);
  });

  it('先报 sessionStarted 再报 sessionOpened：启动完成才算打开', async () => {
    const h = makeHarness();
    await open(h);
    expect(h.events.map((event) => event.type)).toEqual([
      'sessionStarted',
      'sessionOpened',
    ]);
  });

  it('daemon 级代理同步到在世会话，并对之后打开的会话生效', async () => {
    const h = makeHarness();
    await open(h, 'sess-1');

    h.manager.setDaemonProxy('http://127.0.0.1:8080');
    expect(h.sessions[0]!.applyDaemonProxy).toHaveBeenCalledWith(
      'http://127.0.0.1:8080',
    );

    await open(h, 'sess-2');
    expect(h.sessions[1]!.applyDaemonProxy).toHaveBeenCalledWith(
      'http://127.0.0.1:8080',
    );

    h.manager.setDaemonProxy(undefined);
    expect(h.sessions[0]!.applyDaemonProxy).toHaveBeenLastCalledWith(undefined);

    await open(h, 'sess-3');
    expect(h.sessions[2]!.applyDaemonProxy).toHaveBeenCalledWith(undefined);
  });
});

describe('open：普通恢复候选的所有权', () => {
  it('候选绑定错误不承接；承接后的构造失败由 Manager 释放且不重新读取', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'resume-manager-'));
    const filePath = path.join(root, 'source.jsonl');
    const attempt = await beginResumeRead({});
    const h = makeHarness();
    try {
      await fs.writeFile(
        filePath,
        `${JSON.stringify({ type: 'active-leaf', sessionId: 'source', leafUuid: null, explicit: true, timestamp: '2026-10-27T00:00:00.000Z' })}\n`,
      );
      const candidate = await new TranscriptRepository().readForResume(
        filePath,
        { sessionId: 'source', attempt },
      );
      const read = vi.spyOn(TranscriptRepository.prototype, 'readForResume');
      const request = {
        sessionId: 'source',
        cwd: root,
        cliArgs: STUB_CLI_ARGS,
        resumeTranscriptPath: filePath,
        resumeCandidate: candidate!,
      };
      await expect(
        h.manager.open({ ...request, sessionId: 'wrong' }),
      ).rejects.toMatchObject({ reason: 'unsafe' });
      expect(h.factory).not.toHaveBeenCalled();
      expect(() => attempt.check()).not.toThrow();
      const failure = new Error('construction failed');
      h.factory.mockImplementationOnce(async (params) => {
        expect(params.resumeCandidate).toBe(candidate);
        expect(params.resumeData).toBeUndefined();
        expect(params.forked).toBe(false);
        throw failure;
      });
      await expect(h.manager.open(request)).rejects.toBe(failure);
      expect(read).not.toHaveBeenCalled();
      expect(() => attempt.check()).toThrow();
      expect(h.manager.isLive('source')).toBe(false);
    } finally {
      attempt.finish();
      await h.manager.shutdown();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('open：resume / fork 是 Manager 的会话创建能力', () => {
  function resumeArgs(sourceSessionId: string) {
    return { _: [], $0: 'qwen', resume: sourceSessionId } as never;
  }

  function forkRequest(overrides: Record<string, unknown> = {}) {
    return {
      sourceSessionId: 'source-1',
      sourceTranscriptPath: '/src/source-1.jsonl',
      ...overrides,
    };
  }

  function forkResult(targetSessionId: string) {
    return {
      sessionPath: `/fork/${targetSessionId}.jsonl`,
      projectRoot: '/proj',
      forkTranscriptEntries: [
        { type: 'custom-title', customTitle: 'Fork title' },
      ],
      resumeState: { filePath: `/fork/${targetSessionId}.jsonl` },
      messages: [{ uuid: 'm-1' }],
      fileHistorySnapshots: [],
      sourceSessionId: 'source-1',
      model: 'fork-model',
      reasoningEffort: 'high',
      contextWindow: 200_000,
      generation: { temperature: 0.2 },
      directories: ['/repo'],
      worktreeSession: {
        originalCwd: '/repo',
        worktreePath: '/wt',
        worktreeName: 'wt',
        sessionId: targetSessionId,
      },
    };
  }

  it('plain resume：resumeTranscriptPath 原样交给 Session，不执行 fork', async () => {
    const h = makeHarness();
    await h.manager.open({
      sessionId: 'sess-1',
      cwd: '/proj',
      cliArgs: resumeArgs('sess-1'),
      resumeTranscriptPath: '/src/sess-1.jsonl',
    });

    expect(forkStub.create).not.toHaveBeenCalled();
    const params = h.factory.mock.calls[0]![0];
    expect(params.resumeTranscriptPath).toBe('/src/sess-1.jsonl');
    expect(params.forked).toBe(false);
    expect('resumeData' in params).toBe(false);
  });

  it('precreated fork reuses writer state and mirror entries without recreating or reading it', async () => {
    const h = makeHarness();
    const resumeData = {
      ...forkResult('sess-2'),
      resumeState: {
        sessionId: 'sess-2',
        filePath: '/fork/sess-2.jsonl',
        runtimeTailUuid: 'm-1',
      },
    } as never;
    await h.manager.open({
      sessionId: 'sess-2',
      cwd: '/proj',
      cliArgs: resumeArgs('sess-2'),
      forked: true,
      resumeTranscriptPath: '/fork/sess-2.jsonl',
      resumeData,
    });
    expect(forkStub.create).not.toHaveBeenCalled();
    expect(h.factory.mock.calls[0]![0].resumeData).toBe(resumeData);
  });

  it.each([
    {
      sessionId: 'source-1',
      filePath: '/fork/sess-2.jsonl',
      runtimeTailUuid: 'm-1',
    },
    {
      sessionId: 'sess-2',
      filePath: '/fork/other.jsonl',
      runtimeTailUuid: 'm-1',
    },
    {
      sessionId: 'sess-2',
      filePath: '/fork/sess-2.jsonl',
      runtimeTailUuid: 'stale',
    },
  ])('rejects mismatched precreated fork state: %j', async (resumeState) => {
    const h = makeHarness();
    await expect(
      h.manager.open({
        sessionId: 'sess-2',
        cwd: '/proj',
        cliArgs: resumeArgs('sess-2'),
        forked: true,
        resumeTranscriptPath: '/fork/sess-2.jsonl',
        resumeData: { ...forkResult('sess-2'), resumeState } as never,
      }),
    ).rejects.toThrow('Fork resume data does not match');
    expect(h.factory).not.toHaveBeenCalled();
    expect(forkStub.create).not.toHaveBeenCalled();
  });

  it('fork：Manager 执行 createForkTranscript，并把目标路径与 resumeData 交给 Session', async () => {
    const h = makeHarness();
    forkStub.create.mockResolvedValue(forkResult('sess-2'));

    await h.manager.open({
      sessionId: 'sess-2',
      cwd: '/proj',
      cliArgs: resumeArgs('source-1'),
      fork: forkRequest({
        resumeSessionAt: 'u-cut',
        resumeDropsTurn: 'u-drop',
      }),
    });

    expect(forkStub.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: '/src/source-1.jsonl',
        sourceSessionId: 'source-1',
        targetSessionId: 'sess-2',
        cwd: '/proj',
        resumeSessionAt: 'u-cut',
        resumeDropsTurn: 'u-drop',
      }),
    );
    const params = h.factory.mock.calls[0]![0];
    expect(params.resumeTranscriptPath).toBe('/fork/sess-2.jsonl');
    expect(params.forked).toBe(true);
    expect(params.resumeData).toMatchObject({
      forkTranscriptEntries: [
        { type: 'custom-title', customTitle: 'Fork title' },
      ],
      resumeState: { filePath: '/fork/sess-2.jsonl' },
      messages: [{ uuid: 'm-1' }],
      fileHistorySnapshots: [],
      sourceSessionId: 'source-1',
      model: 'fork-model',
      reasoningEffort: 'high',
      contextWindow: 200_000,
      generation: { temperature: 0.2 },
      directories: ['/repo'],
      worktreeSession: {
        originalCwd: '/repo',
        worktreePath: '/wt',
        worktreeName: 'wt',
        sessionId: 'sess-2',
      },
    });
  });

  it('fork 意图里的源 project / worktree / target root 原样交给 helper', async () => {
    const h = makeHarness();
    forkStub.create.mockResolvedValue(forkResult('sess-2'));
    const worktree = {
      originalCwd: '/repo',
      worktreePath: '/wt',
      worktreeName: 'wt',
      sessionId: 'sess-2',
    };

    await h.manager.open({
      sessionId: 'sess-2',
      cwd: '/proj',
      cliArgs: resumeArgs('source-1'),
      fork: forkRequest({
        sourceProjectRoot: '/source-root',
        targetProjectRoot: '/artifact-root',
        targetCwd: '/wt',
        targetWorktreeSession: worktree,
        targetTitle: 'Branch title',
        strictFileHistoryRestore: true,
      }),
    });

    expect(forkStub.create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProjectRoot: '/source-root',
        targetProjectRoot: '/artifact-root',
        targetCwd: '/wt',
        targetWorktreeSession: worktree,
        targetTitle: 'Branch title',
        strictFileHistoryRestore: true,
      }),
    );
  });

  it('fork in-flight 时重复 open 立即回 opening，且 fork 只执行一次', async () => {
    const h = makeHarness();
    let resolveFork!: (value: unknown) => void;
    let markForkStarted!: () => void;
    const forkStarted = new Promise<void>((resolve) => {
      markForkStarted = resolve;
    });
    forkStub.create.mockImplementation(() => {
      markForkStarted();
      return new Promise((resolve) => {
        resolveFork = resolve;
      });
    });

    const first = h.manager.open({
      sessionId: 'sess-2',
      cwd: '/proj',
      cliArgs: resumeArgs('source-1'),
      fork: forkRequest(),
    });
    // 等第一次 open 真正进入 fork 的 await：此时 opening 表项已登记、fork 尚未完成。
    await forkStarted;

    await expect(
      h.manager.open({
        sessionId: 'sess-2',
        cwd: '/proj',
        cliArgs: resumeArgs('source-1'),
        fork: forkRequest(),
      }),
    ).rejects.toMatchObject({
      name: 'ThreadSessionAlreadyOpenError',
      code: 'SESSION_ALREADY_OPEN',
      state: 'opening',
    });
    expect(forkStub.create).toHaveBeenCalledTimes(1);

    resolveFork(forkResult('sess-2'));
    await expect(first).resolves.toBe('sess-2');
  });

  it('fork 成功但 Session 装配失败：回滚 fork 产物并抛原错误', async () => {
    const h = makeHarness();
    const fork = forkResult('sess-2');
    forkStub.create.mockResolvedValue(fork);
    const assemblyError = new Error('session assembly failed');
    h.factory.mockRejectedValueOnce(assemblyError);

    await expect(
      h.manager.open({
        sessionId: 'sess-2',
        cwd: '/proj',
        cliArgs: resumeArgs('source-1'),
        fork: forkRequest(),
      }),
    ).rejects.toBe(assemblyError);

    expect(forkStub.rollback).toHaveBeenCalledWith({
      fork,
      sessionId: 'sess-2',
      originalError: assemblyError,
    });
  });

  it('fork 缺少源路径 / 复用源 id 时直接失败，不执行 fork', async () => {
    const h = makeHarness();

    await expect(
      h.manager.open({
        sessionId: 'sess-2',
        cwd: '/proj',
        cliArgs: resumeArgs('source-1'),
        fork: forkRequest({ sourceTranscriptPath: undefined }),
      }),
    ).rejects.toThrow('missing its source transcript');

    await expect(
      h.manager.open({
        sessionId: 'source-1',
        cwd: '/proj',
        cliArgs: resumeArgs('source-1'),
        fork: forkRequest(),
      }),
    ).rejects.toThrow('must not reuse its source session id');

    expect(forkStub.create).not.toHaveBeenCalled();
  });

  it('resume 缺少源路径时失败，不静默降级成新会话', async () => {
    const h = makeHarness();

    await expect(
      h.manager.open({
        sessionId: 'sess-1',
        cwd: '/proj',
        cliArgs: resumeArgs('sess-1'),
      }),
    ).rejects.toThrow('missing its source transcript');

    expect(h.factory).not.toHaveBeenCalled();
  });
});

describe('open：会话 id 由 Manager 派生', () => {
  it('新会话 mint 新 id，并在装配时使用同一个 id', async () => {
    const h = makeHarness();

    const sessionId = await h.manager.open({
      cwd: '/proj',
      cliArgs: STUB_CLI_ARGS,
    });

    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.factory.mock.calls[0]![0].sessionId).toBe(sessionId);
  });

  it('plain resume 未声明 id 时续用 cliArgs.resume', async () => {
    const h = makeHarness();

    const sessionId = await h.manager.open({
      cwd: '/proj',
      cliArgs: { _: [], $0: 'qwen', resume: 'sess-1' } as never,
      resumeTranscriptPath: '/src/sess-1.jsonl',
    });

    expect(sessionId).toBe('sess-1');
  });

  it('fork 未声明 id 时 mint 新 id，且不以源 id 作为目标', async () => {
    const h = makeHarness();
    forkStub.create.mockResolvedValue({
      sessionPath: '/fork/generated.jsonl',
      projectRoot: '/proj',
      resumeState: {},
      messages: [],
      fileHistorySnapshots: [],
      sourceSessionId: 'source-1',
    });

    const sessionId = await h.manager.open({
      cwd: '/proj',
      cliArgs: { _: [], $0: 'qwen', resume: 'source-1' } as never,
      fork: {
        sourceSessionId: 'source-1',
        sourceTranscriptPath: '/src/source-1.jsonl',
      },
    });

    expect(sessionId).not.toBe('source-1');
    expect(forkStub.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetSessionId: sessionId }),
    );
  });
});

describe('能力路由', () => {
  it('按 sessionId 找到会话并原样转调，返回值原样回', async () => {
    const h = makeHarness();
    await open(h);
    const goal = { objective: '把四个提交做完' };

    await expect(
      h.manager.setGoal(ctx, 'sess-1', goal),
    ).resolves.toEqual({ ok: true });

    expect(h.sessions[0]!.setGoal).toHaveBeenCalledWith(ctx, goal);
  });

  it('带可选参数的能力也原样透传', async () => {
    const h = makeHarness();
    await open(h);

    await h.manager.interrupt(ctx, 'sess-1', { cancelQueued: true });

    expect(h.sessions[0]!.interrupt).toHaveBeenCalledWith(ctx, {
      cancelQueued: true,
    });
  });

  it('消息投递走同一条路由，不另设 send', async () => {
    const h = makeHarness();
    await open(h);
    // ThreadUserMessage 就是 core 的 InboundUserMessage：字段蛇形，uuid 是命令生命周期
    // 的归组身份，由宿主从帧上取好再传进来。
    const message: ThreadUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
      uuid: 'u-1',
    };

    await expect(
      h.manager.submitMessage(ctx, 'sess-1', message),
    ).resolves.toEqual({ commandUuid: 'u-1', disposition: 'queued' });

    expect(h.sessions[0]!.submitMessage).toHaveBeenCalledWith(ctx, message);
  });

  it('未知会话由 requireSession 一处抛错，不散成四十份', async () => {
    const h = makeHarness();
    expect(() => h.manager.requireSession('nope')).toThrow(
      'Unknown session: nope',
    );
    await expect(h.manager.setGoal(ctx, 'nope', { objective: 'x' })).rejects.toThrow(
      'Unknown session: nope',
    );
  });

  it('get 回 undefined 而不抛，供宿主判存在', () => {
    const h = makeHarness();
    expect(h.manager.get('nope')).toBeUndefined();
    expect(h.manager.isLive('nope')).toBe(false);
    expect(h.manager.getActiveSessionIds()).toEqual([]);
  });
});

describe('close / shutdown', () => {
  it('close 调会话的 close 并广播，重复关闭静默', async () => {
    const h = makeHarness();
    await open(h);

    await h.manager.close('sess-1');
    expect(h.sessions[0]!.closeCount).toBe(1);
    // sessionClosed 在后台 teardown 完成后才发；close 本身不等它。
    await h.manager.waitForRetiring('sess-1');
    expect(h.events.at(-1)).toEqual({
      type: 'sessionClosed',
      sessionId: 'sess-1',
      generation: 1,
    });

    await expect(h.manager.close('sess-1')).resolves.toBeUndefined();
    expect(h.sessions[0]!.closeCount).toBe(1);
  });

  it('shutdown 关掉所有活会话', async () => {
    const h = makeHarness();
    await open(h, 'sess-1');
    await open(h, 'sess-2');

    await h.manager.shutdown();

    expect(h.sessions.map((session) => session.closeCount)).toEqual([1, 1]);
    expect(h.manager.getActiveSessionIds()).toEqual([]);
  });

  it('单独 close 保留共享资源，shutdown 在所有会话收尾后只释放一次', async () => {
    const dispose = vi.spyOn(ResourceService.prototype, 'dispose');
    const h = makeHarness();
    await open(h, 'sess-1');
    const state = h.factory.mock.calls[0]![0]
      .resourceService as ResourceService;
    // 只绑定根，不启动文件扫描或 watcher。
    const user = state.getUserResource({ homeDir: '/home' });

    await h.manager.close('sess-1');
    expect(dispose).not.toHaveBeenCalled();
    expect(state.getUserResource()).toBe(user);
    await open(h, 'sess-2');
    expect(h.factory.mock.calls[1]![0].resourceService).toBe(state);
    h.sessions[1]!.closeChannel = vi.fn(async () => {
      expect(dispose).not.toHaveBeenCalled();
      return { transcriptFlushed: Promise.resolve() };
    });

    await h.manager.shutdown();
    await h.manager.shutdown();

    expect(h.sessions[1]!.closeChannel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => state.getUserResource()).toThrow(
      'ResourceService is disposed',
    );
  });

  it('注入的 resourceService 由 owner 回收：会话共用同一份，shutdown 不 dispose 它', async () => {
    const injected = new ResourceService();
    const dispose = vi.spyOn(injected, 'dispose');
    const h = makeHarness(injected);
    await open(h, 'sess-1');
    // 会话面拿到的是注入的那一份，而不是 Manager 自建的新实例。
    expect(h.factory.mock.calls[0]![0].resourceService).toBe(injected);

    await h.manager.shutdown();
    await h.manager.shutdown();

    // 回收归属在 owner（root Config / 进程入口），Manager 不得重复回收。
    expect(dispose).not.toHaveBeenCalled();
  });

  it('会话共用独立 SettingsService，close 不回收，shutdown 才释放自建实例', async () => {
    const h = makeHarness();
    await open(h, 'settings-1');
    const settings = h.factory.mock.calls[0]![0]
      .settingsService as SettingsService;
    const dispose = vi.spyOn(settings, 'dispose');
    await h.manager.close('settings-1');
    expect(dispose).not.toHaveBeenCalled();
    await open(h, 'settings-2');
    expect(h.factory.mock.calls[1]![0].settingsService).toBe(settings);
    h.sessions[1]!.closeChannel = vi.fn(async () => {
      expect(dispose).not.toHaveBeenCalled();
      return { transcriptFlushed: Promise.resolve() };
    });
    await h.manager.shutdown();
    await h.manager.shutdown();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('借用的 SettingsService 由宿主回收', async () => {
    const settings = new SettingsService();
    const dispose = vi.spyOn(settings, 'dispose');
    const h = makeHarness(undefined, settings);
    await open(h, 'settings-borrowed');
    expect(h.factory.mock.calls[0]![0].settingsService).toBe(settings);
    await h.manager.shutdown();
    expect(dispose).not.toHaveBeenCalled();
    await settings.dispose();
  });

  it('空 Manager 也回收资源，并发 shutdown 等待同一次 dispose 完成', async () => {
    const gate = deferred<void>();
    const dispose = vi
      .spyOn(ResourceService.prototype, 'dispose')
      .mockImplementation(() => gate.promise);
    const h = makeHarness();
    const first = h.manager.shutdown();
    const second = h.manager.shutdown();
    expect(second).toBe(first);
    const settled = vi.fn();
    void second.then(settled);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(settled).not.toHaveBeenCalled();
    await expect(open(h)).rejects.toThrow('ThreadManager is shut down');
    expect(h.factory).not.toHaveBeenCalled();

    gate.resolve();
    await Promise.all([first, second]);
    await expect(open(h)).rejects.toThrow('ThreadManager is shut down');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('shutdown 等待已在途且已从注册表退休的 close，再释放共享资源', async () => {
    const gate = deferred<void>();
    const dispose = vi.spyOn(ResourceService.prototype, 'dispose');
    const h = makeHarness();
    await open(h);
    const session = h.sessions[0]!;
    session.closeChannel = vi.fn(() =>
      gate.promise.then(() => ({ transcriptFlushed: Promise.resolve() })),
    );
    const firstClose = h.manager.close('sess-1');
    const secondClose = h.manager.close('sess-1');
    await vi.waitFor(() =>
      expect(session.closeChannel).toHaveBeenCalledOnce(),
    );
    await session.terminate({ kind: 'ended' });
    expect(h.manager.getActiveSessionIds()).toEqual([]);
    const shutdown = h.manager.shutdown();
    const settled = vi.fn();
    void Promise.all([secondClose, shutdown]).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    gate.resolve();
    await Promise.all([firstClose, secondClose, shutdown]);
    expect(session.closeChannel).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('信道关闭失败仍完成 teardown 与其他会话收尾，不向 close / shutdown 抛', async () => {
    const dispose = vi.spyOn(ResourceService.prototype, 'dispose');
    const h = makeHarness();
    await open(h, 'sess-1');
    await open(h, 'sess-2');
    h.sessions[0]!.closeChannel = vi.fn(async () => {
      throw new Error('close failed');
    });

    // close 语义是「尽力关信道」：失败只留日志，退休流程照走，调用方不收到异常。
    await expect(h.manager.shutdown()).resolves.toBeUndefined();
    await expect(h.manager.shutdown()).resolves.toBeUndefined();

    expect(h.manager.get('sess-1')).toBeUndefined();
    expect(h.manager.get('sess-2')).toBeUndefined();
    expect(h.sessions[1]!.closeCount).toBe(1);
    expect(h.sessions[0]!.retireCount).toBe(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('shutdown 等待在途信道关闭后释放资源，并传播共享资源错误', async () => {
    const resourceError = new Error('resource failed');
    const dispose = vi
      .spyOn(ResourceService.prototype, 'dispose')
      .mockRejectedValue(resourceError);
    const h = makeHarness();
    await open(h, 'sess-1');
    await open(h, 'sess-2');
    const gate = deferred<{ transcriptFlushed: Promise<void> }>();
    h.sessions[1]!.closeChannel = vi.fn(() => gate.promise);
    const shutdown = h.manager.shutdown();
    const rejected = shutdown.catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(h.sessions[1]!.closeChannel).toHaveBeenCalledOnce(),
    );
    expect(dispose).not.toHaveBeenCalled();
    gate.resolve({ transcriptFlushed: Promise.resolve() });
    expect(await rejected).toBe(resourceError);
    expect(dispose).toHaveBeenCalledOnce();
    expect(h.manager.get('sess-1')).toBeUndefined();
    expect(h.manager.get('sess-2')).toBeUndefined();
  });

  it('close 只关信道：retire 挂起时 close 已返回，teardown 在后台完成', async () => {
    const h = makeHarness();
    await open(h);
    const session = h.sessions[0]!;
    const retireGate = deferred<void>();
    session.retire = vi.fn(async () => {
      session.retireCount += 1;
      await retireGate.promise;
    });

    await h.manager.close('sess-1');
    // close 返回时 retire 已经起飞但还没排干。
    expect(session.closeCount).toBe(1);
    expect(session.retireCount).toBe(1);
    expect(h.manager.isLive('sess-1')).toBe(false);
    // 同 ID 可立即重开（transcriptFlushed 已 resolve），teardown 仍在后台。
    await open(h);
    expect(h.factory).toHaveBeenCalledTimes(2);

    retireGate.resolve();
    await h.manager.waitForRetiring('sess-1');
  });

  it('open 只等最近一代的 transcriptFlushed，不等 teardown', async () => {
    const h = makeHarness();
    await open(h);
    const first = h.sessions[0]!;
    const flushGate = deferred<void>();
    const retireGate = deferred<void>();
    first.closeChannel = vi.fn(async () => ({
      transcriptFlushed: flushGate.promise,
    }));
    first.retire = vi.fn(async () => {
      await retireGate.promise;
    });

    await h.manager.close('sess-1');
    // 旧 writer 的尾部还没落盘：新 open 必须卡在屏障上。
    const reopening = h.manager.open({
      sessionId: 'sess-1',
      cwd: '/workspace/project-a',
      cliArgs: STUB_CLI_ARGS,
    });
    await Promise.resolve();
    expect(h.factory).toHaveBeenCalledTimes(1);

    flushGate.resolve();
    await expect(reopening).resolves.toBe('sess-1');
    expect(h.factory).toHaveBeenCalledTimes(2);
    // teardown 仍未完成也不影响新会话。
    expect(h.manager.isLive('sess-1')).toBe(true);

    retireGate.resolve();
    await h.manager.waitForRetiring('sess-1');
  });

  it('共享资源回收失败向所有 shutdown 调用者传播，且不重复执行', async () => {
    const dispose = vi
      .spyOn(ResourceService.prototype, 'dispose')
      .mockRejectedValue(new Error('dispose failed'));
    const h = makeHarness();
    await expect(h.manager.shutdown()).rejects.toThrow('dispose failed');
    await expect(h.manager.shutdown()).rejects.toThrow('dispose failed');
    expect(dispose).toHaveBeenCalledOnce();
    await expect(open(h)).rejects.toThrow('ThreadManager is shut down');
  });
});

describe('会话自行终止', () => {
  it('广播中立原因，不合成任何上游形状', async () => {
    const h = makeHarness();
    await open(h);
    const error = new Error('engine exploded');

    await h.sessions[0]!.terminate({ kind: 'runtime_error', error });

    expect(h.events.at(-1)).toEqual({
      type: 'sessionTerminated',
      sessionId: 'sess-1',
      termination: { kind: 'runtime_error', error },
    });
    expect(h.manager.isLive('sess-1')).toBe(false);
  });

  it('正常收尾也是同一个事件，只是原因不同', async () => {
    const h = makeHarness();
    await open(h);

    await h.sessions[0]!.terminate({ kind: 'ended' });

    expect(h.events.at(-1)).toMatchObject({
      type: 'sessionTerminated',
      termination: { kind: 'ended' },
    });
  });

  it('终止之后再 close 不重复上报', async () => {
    const h = makeHarness();
    await open(h);
    await h.sessions[0]!.terminate({ kind: 'ended' });
    const after = h.events.length;

    // 迟到的 close（上游可能并发发 end_session 与 delete_session）必须静默：
    // 会话已摘表，再报一次 sessionClosed 会让上游看到两个终态。
    await expect(h.manager.close('sess-1')).resolves.toBeUndefined();
    expect(h.events.slice(after)).toEqual([]);
  });
});

describe('磁盘会话仓库', () => {
  it('list / rename 落到 sessionManager', async () => {
    const h = makeHarness();
    await expect(h.manager.listSessions('/proj')).resolves.toEqual([]);
    expect(h.store.list).toHaveBeenCalledWith('/proj');
    // 传了 projectDir 就走定向列举，不得触碰全量扫盘。
    expect(h.store.listAll).not.toHaveBeenCalled();

    await expect(
      h.manager.renameSession('/proj', 'sess-1', 'Title'),
    ).resolves.toMatchObject({ id: 'sess-1', title: 'Title' });
    expect(h.store.rename).toHaveBeenCalledWith('/proj', 'sess-1', 'Title');
    expect(h.events.at(-1)).toEqual({
      type: 'sessionRenamed',
      sessionId: 'sess-1',
      title: 'Title',
    });
  });

  it('listSessions 缺省 projectDir 时全量扫盘（listAll），不回落进程目录', async () => {
    const h = makeHarness();
    // daemon 已无 cwd 概念：不传目录 == 不过滤 == 列出所有目录的会话，
    // 而不是 list(process.cwd())。这是本次改动的核心正向断言——把缺省分支
    // 改回 list(process.cwd()) 会让本用例变红。
    await expect(h.manager.listSessions()).resolves.toEqual([]);
    expect(h.store.listAll).toHaveBeenCalledTimes(1);
    expect(h.store.list).not.toHaveBeenCalled();
  });

  it('deleteSession 先关活会话再删记录，然后广播结果', async () => {
    const h = makeHarness();
    await open(h);

    await expect(h.manager.deleteSession('/proj', 'sess-1')).resolves.toBe(true);

    expect(h.sessions[0]!.closeCount).toBe(1);
    expect(h.store.delete).toHaveBeenCalledWith('/proj', 'sess-1');
    expect(h.events.at(-1)).toEqual({
      type: 'sessionDeleted',
      sessionId: 'sess-1',
      deleted: true,
    });
  });

  it('删一个没开着的会话不去调 close', async () => {
    const h = makeHarness();
    await expect(h.manager.deleteSession('/proj', 'nope')).resolves.toBe(true);
    expect(h.store.delete).toHaveBeenCalledWith('/proj', 'nope');
  });
});

// ===========================================================================
// 并发生命周期
// ===========================================================================

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeManagerWith(
  createSession: (sessionId: string) => Promise<ThreadSession>,
) {
  const events: ThreadManagerEvent[] = [];
  resetSessionManagerStub();
  threadSessionStub.create.mockReset();
  threadSessionStub.create.mockImplementation(
    async (params: { sessionId: string }) => createSession(params.sessionId),
  );
  const manager = new ThreadManager({
    permissionManager: createTestPermissionManager(),
    modelProviderFactory: () => [],
    modelTransportManager: new ModelTransportManager([]),
    createHost: () =>
      ({
        events: { emit: () => {} },
        requests: {},
      }) as unknown as ThreadHost,
  });
  await manager.initializeRuntime({ signal: new AbortController().signal });
  manager.subscribe((event) => {
    events.push(event);
  });
  return { manager, events };
}

describe('并发生命周期', () => {
  it('shutdown 等待在途 open 落地并关闭会话，再回收共享资源', async () => {
    const gate = deferred<StubSession>();
    const dispose = vi.spyOn(ResourceService.prototype, 'dispose');
    const { manager } = await makeManagerWith(
      () => gate.promise as unknown as Promise<ThreadSession>,
    );
    const opening = manager.open({ sessionId: 'sess-1', cwd: '/proj', cliArgs: STUB_CLI_ARGS });
    const shutdown = manager.shutdown();
    const settled = vi.fn();
    void shutdown.then(settled);
    await Promise.resolve();
    expect(dispose).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    const session = newStubSession('sess-1', []);
    gate.resolve(session);

    await opening;
    await shutdown;
    expect(session.closeCount).toBe(1);
    expect(manager.getActiveSessionIds()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('在途 open 失败后 shutdown 仍回收共享资源', async () => {
    const gate = deferred<StubSession>();
    const dispose = vi.spyOn(ResourceService.prototype, 'dispose');
    const { manager } = await makeManagerWith(
      () => gate.promise as unknown as Promise<ThreadSession>,
    );
    const opening = manager.open({ sessionId: 'sess-1', cwd: '/proj', cliArgs: STUB_CLI_ARGS });
    const failedOpen = opening.catch((error: unknown) => error);
    const shutdown = manager.shutdown();
    gate.reject(new Error('assembly failed'));

    expect(await failedOpen).toEqual(new Error('assembly failed'));
    await shutdown;
    expect(manager.isLive('sess-1')).toBe(false);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('装配在途时并发 open 同一个 id 回 SESSION_ALREADY_OPEN(opening)，只装配一次', async () => {
    const gate = deferred<StubSession>();
    let calls = 0;
    const { manager } = await makeManagerWith(() => {
      calls += 1;
      return gate.promise as unknown as Promise<ThreadSession>;
    });

    const first = manager.open({ sessionId: 'sess-1', cwd: '/proj', cliArgs: STUB_CLI_ARGS });
    const second = manager.open({
      sessionId: 'sess-1',
      cwd: '/proj',
      cliArgs: STUB_CLI_ARGS,
    });
    const secondError = second.catch((error: unknown) => error);

    // 第二个请求不能再复用在途装配：第一次装配后来失败时，它已经拿到过 success，
    // 等于 daemon 回了一个实际不存在的会话。
    await vi.waitFor(() => expect(calls).toBe(1));
    // 装配中就算活着：宿主拿 isLive 判 ready / inactive，在途会话不该被当成已死。
    // 但它还没启动完，因此不进 getActiveSessionIds（那个只报已落地的）。
    expect(manager.isLive('sess-1')).toBe(true);
    expect(manager.getActiveSessionIds()).toEqual([]);
    await expect(secondError).resolves.toMatchObject({
      name: 'ThreadSessionAlreadyOpenError',
      code: 'SESSION_ALREADY_OPEN',
      state: 'opening',
    });

    const sink: ThreadEvent[] = [];
    const session = newStubSession('sess-1', sink);
    gate.resolve(session);
    await expect(first).resolves.toBe('sess-1');
    expect(calls).toBe(1);
    expect(manager.get('sess-1')).toBeDefined();
  });

  it('装配期间的 close 等在途 open 落地后再收尾，不留收不掉的孤儿', async () => {
    const gate = deferred<StubSession>();
    const { manager, events } = await makeManagerWith(
      () => gate.promise as unknown as Promise<ThreadSession>,
    );

    const opening = manager.open({ sessionId: 'sess-1', cwd: '/proj', cliArgs: STUB_CLI_ARGS });
    const closing = manager.close('sess-1');
    const session = newStubSession('sess-1', []);
    gate.resolve(session);

    await opening;
    await closing;

    // close 早于装配完成到达：如果它此刻直接返回，会话会入表却再也没人收。
    expect(session.closeCount).toBe(1);
    expect(manager.isLive('sess-1')).toBe(false);
    // 顺序也必须是 opened 在 closed 之前：上游按这两个事件维护会话列表。
    expect(events.map((event) => event.type)).toEqual([
      'sessionStarted',
      'sessionOpened',
      'sessionClosed',
    ]);
  });

  it('装配失败时 open 抛错、不留表项、不报 opened，且同 id 可重试', async () => {
    const gates: Array<ReturnType<typeof deferred<StubSession>>> = [];
    const { manager, events } = await makeManagerWith(() => {
      const gate = deferred<StubSession>();
      gates.push(gate);
      return gate.promise as unknown as Promise<ThreadSession>;
    });

    const opening = manager.open({
      sessionId: 'sess-1',
      cwd: '/proj',
      cliArgs: STUB_CLI_ARGS,
    });
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.reject(new Error('assembly failed'));

    await expect(opening).rejects.toThrow('assembly failed');
    expect(manager.isLive('sess-1')).toBe(false);
    expect(events).toEqual([]);

    // 在途记账必须已清掉，否则同 id 永远开不出来。
    const retry = manager.open({
      sessionId: 'sess-1',
      cwd: '/proj',
      cliArgs: STUB_CLI_ARGS,
    });
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    const session = newStubSession('sess-1', []);
    gates[1]!.resolve(session);
    await expect(retry).resolves.toBe('sess-1');
  });
});

describe('装配期间就终止的会话', () => {
  /**
   * 会话可能在工厂 await 期间就自行结束。终止是 promise 而不是回调，所以 Manager 只要
   * 在入表之后 attach 就够——已 resolve 的 promise 事后 attach 照样触发，不需要缓冲。
   */
  it('仍然上报 sessionTerminated，且排在 sessionOpened 之后', async () => {
    const session = newStubSession('sess-1', []);
    await session.terminate({ kind: 'ended' });
    const { manager, events } = await makeManagerWith(
      async () => session as unknown as ThreadSession,
    );

    await expect(manager.open({ sessionId: 'sess-1', cwd: '/proj', cliArgs: STUB_CLI_ARGS })).resolves.toBe('sess-1');
    await Promise.resolve();

    // 顺序是硬的：attach 若紧跟入表，sessionTerminated 会抢在 sessionOpened 前面，
    // 上游按这两个事件维护会话列表，反了等于先删一个还没加进来的会话。
    expect(events.map((event) => event.type)).toEqual([
      'sessionStarted',
      'sessionOpened',
      'sessionTerminated',
    ]);
    expect(manager.isLive('sess-1')).toBe(false);
    expect(manager.getActiveSessionIds()).toEqual([]);
  });
});

describe('observer 隔离', () => {
  it('退订之后不再收到事件', async () => {
    const h = makeHarness();
    const seen: ThreadManagerEvent[] = [];
    const unsubscribe = h.manager.subscribe((event) => {
      seen.push(event);
    });

    await h.manager.renameSession('/proj', 'sess-1', 'Title');
    expect(seen).toHaveLength(1);

    unsubscribe();
    await h.manager.renameSession('/proj', 'sess-1', 'Again');
    expect(seen).toHaveLength(1);
  });

  it('一个 observer 抛错不影响其它 observer 与主流程', async () => {
    const h = makeHarness();
    const seen: ThreadManagerEvent[] = [];
    h.manager.subscribe(() => {
      throw new Error('observer blew up');
    });
    h.manager.subscribe((event) => {
      seen.push(event);
    });

    const session = await h.manager.renameSession('/proj', 'sess-1', 'Title');
    expect(session).toMatchObject({ id: 'sess-1', title: 'Title' });
    expect(seen).toHaveLength(1);
  });

  it('返回 Promise 的 observer 被拒绝时不影响主流程', async () => {
    const h = makeHarness();
    h.manager.subscribe(async () => {
      throw new Error('async observer blew up');
    });
    await expect(
      h.manager.renameSession('/proj', 'sess-1', 'Title'),
    ).resolves.toBeDefined();
  });
});

describe('close 等待 transcript flush', () => {
  it('close 在 transcriptFlushed 落定后才回包', async () => {
    const h = makeHarness();
    await open(h);

    let resolveFlushed!: () => void;
    const transcriptFlushed = new Promise<void>((resolve) => {
      resolveFlushed = resolve;
    });
    h.sessions[0]!.closeChannel = vi.fn(async () => ({ transcriptFlushed }));

    let closed = false;
    const closing = h.manager.close('sess-1').then(() => {
      closed = true;
    });
    // flush 未落定时 close 不回包（退几个微任务让内部链路跑到位）。
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(closed).toBe(false);

    resolveFlushed();
    await closing;
    expect(closed).toBe(true);
  });

  it('flush 挂死时有界超时，close 仍回包且重开屏障保留原 promise', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      await open(h);

      const transcriptFlushed = new Promise<void>(() => {});
      h.sessions[0]!.closeChannel = vi.fn(async () => ({ transcriptFlushed }));

      const closing = h.manager.close('sess-1');
      const guarded = Promise.race([
        closing.then(() => 'closed' as const),
        vi.advanceTimersByTimeAsync(5_000).then(() => 'hung' as const),
      ]);
      await expect(guarded).resolves.toBe('closed');

      // 屏障仍持有未落盘的原 promise：同 ID 重开要等它（这里只验证 retiring 仍登记）。
      await h.manager.waitForRetiring('sess-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
