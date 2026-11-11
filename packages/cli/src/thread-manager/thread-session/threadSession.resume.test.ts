/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';import { createTestPermissionManager } from '../../test-utils/permissionManager.js';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  beginResumeRead,
  ModelTransportManager,
  ResourceService,
  TranscriptStore,
  type Message,
  type Model,
  type ModelConfig,
  type ResumeTranscriptResult,
  type Config,
} from '@qwen-code/core';
import { SessionQueryRunner } from './query/sessionQueryRunner.js';

// 仅隔离权限通道和 sidecar；transcript reader、准入和 Writer 全部使用真实实现。
vi.mock('./host/sessionPermissionChannel.js', () => ({
  installThreadPermissionHandling: vi.fn(),
}));
import { SettingsService } from '@qwen-code/resource';
import {
  restoreRuntimeConfigFromResumeData,
  type ResumeRuntimeConfigRestoreResult,
} from '../../utils/resumeModel.js';
import { ThreadSession, type ThreadSessionParams } from './threadSession.js';
import type { SessionResumeData } from '@qwen-code/core';

vi.mock('../../utils/resumeModel.js', () => ({
  restoreRuntimeConfigFromResumeData: vi.fn(
    () => ({}) as ResumeRuntimeConfigRestoreResult,
  ),
}));

const mockedRestore = vi.mocked(restoreRuntimeConfigFromResumeData);

afterEach(() => vi.restoreAllMocks());

function params(): ThreadSessionParams {
  return {
    sessionId: 'resume-metadata',
    cwd: '/project',
    cliArgs: {} as ThreadSessionParams['cliArgs'],
    host: {
      events: { emit: vi.fn() },
      requests: {},
    } as unknown as ThreadSessionParams['host'],
    permissionManager: createTestPermissionManager(),
    resourceService: new ResourceService(),
    settingsService: new SettingsService(),
    modelTransportManager: new ModelTransportManager([]),
  };
}

interface ResumeInternals {
  loadResumeMetadata(config: Config): Promise<void>;
  applyResumeRuntimeConfig(config: Config): Promise<void>;
  applyResumeWorkspaceDirectories(config: Config): void;
  releaseResumeLease(): void;
  resumeSnapshot: SessionResumeData | undefined;
  resumeReadState: unknown;
}

function internalsOf(session: ThreadSession): ResumeInternals {
  return session as unknown as ResumeInternals;
}

async function dispose(options: ThreadSessionParams): Promise<void> {
  await options.resourceService.dispose();
  await options.settingsService.dispose();
}

function userMessage(uuid: string, sessionId: string): Message {
  return {
    type: 'user',
    uuid,
    sessionId,
    parentUuid: null,
    timestamp: '2026-10-27T00:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text: uuid }] },
  } as Message;
}

function isolateSidecar(): void {
  vi.spyOn(
    SessionQueryRunner.prototype as unknown as {
      openSessionStateStore(): unknown;
    },
    'openSessionStateStore',
  ).mockReturnValue({});
}

async function transcriptFixture(persistence = true) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bounded-thread-'));
  const filePath = path.join(root, 'session.jsonl');
  const options = { ...params(), cwd: root, resumeTranscriptPath: filePath };
  const store = new TranscriptStore();
  const message = userMessage('old', options.sessionId);
  const writer = await store.acquireSessionWriter({
    filePath,
    sessionId: options.sessionId,
    cwd: root,
    entrypoint: 'cli',
  });
  await writer.recordMessages([message], undefined, { immediate: true });
  await writer.recordRuntimeConfig({ model: 'm-1' });
  await writer.recordWorkspaceDirectories([root]);
  await writer.recordCustomTitle('T');
  await writer.close();
  // 运行配置挂在 ModelProviderManager 的按模型偏好上，不再是 Config 的字段，
  // 因此恢复与录制两条路径都要能从这里读到目录项与偏好。
  const preferences = new Map<string, ModelConfig>();
  const listedModel = (key: string) => ({ key, enabled: true }) as Model;
  const modelProviderManager = {
    stop: async () => {},
    listModels: async () => [
      listedModel('m-1'),
      listedModel('initialize-model'),
    ],
    getModel: async (key: string) => listedModel(key),
    getModelConfig: ({ key }: Model) => preferences.get(key),
    setModelConfig: ({ key }: Model, patch: ModelConfig) => {
      const current = preferences.get(key) ?? {};
      preferences.set(key, {
        ...current,
        ...(patch.reasoning
          ? { reasoning: { ...current.reasoning, ...patch.reasoning } }
          : {}),
        ...(patch.context
          ? { context: { ...current.context, ...patch.context } }
          : {}),
      });
      return true;
    },
  };
  const overrides: Record<string, unknown> = {
    getSessionId: () => options.sessionId,
    getWorkingDir: () => root,
    getProjectRoot: () => root,
    getSessionArtifactProjectRoot: () => root,
    getOutputFormat: () => 'text',
    getSessionPersistence: () => persistence,
    getTranscriptStore: () => store,
    getWorkspaceContext: () => ({ getDirectories: () => [root] }),
    getModel: () => 'm-1',
    getSkillManager: () => ({
      clearInvokedSkillsForAgent: vi.fn(),
      activateSkill: vi.fn(),
    }),
    dispose: async () => {},
    getModelProviderManager: () => modelProviderManager,
  };
  const config = new Proxy(overrides, {
    get(target, prop) {
      if (!(prop in target)) Reflect.set(target, prop, vi.fn());
      return Reflect.get(target, prop);
    },
  }) as unknown as Config;
  return {
    root,
    filePath,
    options,
    store,
    message,
    config,
    preferences,
    cleanup: async () => {
      await store.close();
      await dispose(options);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe('ThreadSession resume 元数据', () => {
  it('fork：resumeData 直接映射进 resumeSnapshot，readState 沿用宿主值', async () => {
    const worktreeStates = [
      {
        sessionId: 'resume-metadata',
        originalCwd: '/project',
        worktreePath: '/fork-worktree',
        worktreeName: 'fork',
      },
    ];
    const resumeState = {
      sessionId: 'resume-metadata',
      filePath: '/t/fork.jsonl',
      worktreeStates,
    } as never;
    const options: ThreadSessionParams = {
      ...params(),
      forked: true,
      resumeTranscriptPath: '/t/fork.jsonl',
      resumeData: {
        resumeState,
        messages: [],
        fileHistorySnapshots: [],
        sourceSessionId: 'src-1',
        model: 'm-pro',
        directories: ['/other'],
      },
    };
    const session = new ThreadSession(options);
    const internals = internalsOf(session);
    const cache = vi.fn();
    await internals.loadResumeMetadata({
      setSessionArtifactWorktreeStates: cache,
      getWorktreeSettings: () => undefined,
    } as unknown as Config);
    expect(cache).toHaveBeenCalledWith(worktreeStates);

    expect(internals.resumeSnapshot).toMatchObject({
      sessionId: 'resume-metadata',
      sourceSessionId: 'src-1',
      model: 'm-pro',
      directories: ['/other'],
    });
    expect(internals.resumeReadState).toBe(resumeState);
    const retained = session as unknown as {
      params: ThreadSessionParams;
      pendingForkResumeData?: unknown;
      finishResumeRead(): void;
      copyForkPlanState(config: Config): Promise<void>;
    };
    expect(retained.params.resumeData).toBeUndefined();
    expect(retained.pendingForkResumeData).toBeUndefined();
    const copyPlanForResume = vi.fn(async () => {});
    await retained.copyForkPlanState({
      planStateManager: { copyPlanForResume },
      storage: { getPlansDir: () => '/plans' },
    } as unknown as Config);
    expect(copyPlanForResume).toHaveBeenCalledWith(
      internals.resumeSnapshot!.messages,
      'src-1',
      options.sessionId,
      '/plans',
    );
    retained.finishResumeRead();
    expect(internals.resumeReadState).toBeUndefined();

    await dispose(options);
  });

  it('plain resume：真实读取运行配置、目录与标题，并交接同一 attempt 给 Writer', async () => {
    const f = await transcriptFixture();
    try {
      const session = new ThreadSession(f.options);
      Object.assign(session, { config: f.config, settings: {} });
      const fullRead = vi.spyOn(f.store.repository(), 'resolveSession');
      const read = vi.spyOn(f.store.repository(), 'readForResume');
      const acquire = vi.spyOn(f.store, 'acquireSessionWriter');
      isolateSidecar();
      const runner = await session.getQueryRunner();
      const candidate = (await read.mock.results[0]
        .value) as ResumeTranscriptResult;
      expect(internalsOf(session).resumeSnapshot).toMatchObject({
        sourceSessionId: f.options.sessionId,
        model: 'm-1',
        directories: [f.root],
        customTitle: 'T',
      });
      expect(runner.getMessages()).toEqual(candidate.messages);
      expect(f.config.setSessionArtifactWorktreeStates).toHaveBeenCalledWith(
        candidate.worktreeStates,
      );
      expect(acquire.mock.calls[0][0]).toMatchObject({
        coldResume: { attempt: candidate.attempt },
        resume: { state: { attempt: candidate.attempt } },
      });
      expect(fullRead).not.toHaveBeenCalled();
      expect(() => candidate.attempt.check()).toThrow();
      const writer = (
        session as unknown as {
          transcriptWriter: Awaited<
            ReturnType<TranscriptStore['acquireSessionWriter']>
          >;
        }
      ).transcriptWriter;
      await writer.recordMessages(
        [f.message, userMessage('new', f.options.sessionId)],
        undefined,
        { immediate: true },
      );
      const historical = await f.store
        .repository()
        .resolveSession(f.filePath, {
          sessionId: f.options.sessionId,
          view: 'historical',
        });
      expect(historical?.messages.map(({ uuid }) => uuid)).toEqual([
        'old',
        'new',
      ]);
      expect(historical?.chain.at(-1)).toMatchObject({ parentUuid: 'old' });
      await session.close();
      const reopened = new ThreadSession(f.options);
      Object.assign(reopened, { config: f.config, settings: {} });
      const reopenedRunner = await reopened.getQueryRunner();
      expect(reopenedRunner.getMessages().map(({ uuid }) => uuid)).toEqual([
        'old',
        'new',
      ]);
      await reopened.close();
    } finally {
      await f.cleanup();
    }
  });

  it('fork 无 resumeData 时 open 释放名额后仍重建 attempt 并接管 Writer', async () => {
    const f = await transcriptFixture();
    try {
      const session = new ThreadSession({ ...f.options, forked: true });
      Object.assign(session, { config: f.config, settings: {} });
      const acquire = vi.spyOn(f.store, 'acquireSessionWriter');
      isolateSidecar();
      const internals = internalsOf(session);
      await internals.loadResumeMetadata(f.config);
      const openedAttempt = (
        internals as unknown as {
          resumeAttempt?: { signal: AbortSignal };
        }
      ).resumeAttempt;
      internals.releaseResumeLease();
      expect(openedAttempt?.signal.aborted).toBe(true);

      const runner = await session.getQueryRunner();
      const handed = acquire.mock.calls[0]?.[0] as
        | { coldResume?: { attempt: unknown } }
        | undefined;
      expect(handed?.coldResume?.attempt).toBeDefined();
      expect(handed?.coldResume?.attempt).not.toBe(openedAttempt);
      expect(runner.getMessages().map(({ uuid }) => uuid)).toEqual(['old']);
      await session.close();
    } finally {
      await f.cleanup();
    }
  });

  it('非恢复类装配错误不终结会话，保留候选并可重试成功', async () => {
    const f = await transcriptFixture();
    try {
      const session = new ThreadSession(f.options);
      Object.assign(session, { config: f.config, settings: {} });
      isolateSidecar();
      vi.spyOn(
        ThreadSession.prototype as unknown as {
          assembleQueryRunner(): Promise<unknown>;
        },
        'assembleQueryRunner',
      ).mockRejectedValueOnce(new Error('temporary catalog failure'));
      const terminated = vi.fn();
      void session.termination.then(terminated);

      await expect(session.getQueryRunner()).rejects.toThrow(
        'temporary catalog failure',
      );
      await Promise.resolve();
      expect(terminated).not.toHaveBeenCalled();
      const failedAttempt = (
        session as unknown as {
          releasedResumeAttempt?: { signal: AbortSignal };
        }
      ).releasedResumeAttempt;
      expect(failedAttempt?.signal.aborted).toBe(true);
      const other = await beginResumeRead({ limits: { timeoutMs: 100 } });
      other.finish();


      const runner = await session.getQueryRunner();
      expect(runner.getMessages().map(({ uuid }) => uuid)).toEqual(['old']);
      await session.close();
    } finally {
      await f.cleanup();
    }
  });

  it('预计算候选不再读取正文；无持久化也接受运行态并释放准入', async () => {
    const f = await transcriptFixture(false);
    const attempt = await beginResumeRead({});
    try {
      const candidate = await f.store
        .repository()
        .readForResume(f.filePath, { sessionId: f.options.sessionId, attempt });
      expect(candidate).not.toBeNull();
      const read = vi.spyOn(f.store.repository(), 'readForResume');
      const acquire = vi.spyOn(f.store, 'acquireSessionWriter');
      const session = new ThreadSession({
        ...f.options,
        resumeCandidate: candidate!,
      });
      Object.assign(session, { config: f.config, settings: {} });
      isolateSidecar();
      const runner = await session.getQueryRunner();
      expect(runner.getMessages()).toEqual(candidate!.messages);
      expect(read).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(() => attempt.check()).toThrow();
      await session.close();
    } finally {
      await attempt.finish();
      await f.cleanup();
    }
  });

  it.each([
    { model: 'initialize-model', reasoningEffort: 'high', contextWindow: 32768 },
    { reasoningEffort: 'high', contextWindow: 32768 },
  ])('initialize 显式运行配置不被随后 Writer 快照刷新覆盖：%j', async (initialize) => {
    const f = await transcriptFixture();
    const actual = await vi.importActual<
      typeof import('../../utils/resumeModel.js')
    >('../../utils/resumeModel.js');
    let model = 'm-1';
    Object.assign(f.config, {
      getModel: () => model,
      setModel: (next: string) => {
        model = next;
      },
    });
    const session = new ThreadSession(f.options);
    try {
      await mockedRestore.withImplementation(
        actual.restoreRuntimeConfigFromResumeData,
        async () => {
          Object.assign(session, { config: f.config, settings: {} });
          await internalsOf(session).loadResumeMetadata(f.config);
          await internalsOf(session).applyResumeRuntimeConfig(f.config);
          await session.applyInitializeDeclarations(initialize);
          await fs.appendFile(f.filePath, JSON.stringify({
            type: 'runtime-config', sessionId: f.options.sessionId, timestamp: Date.now(),
            model: 'm-1', reasoningEffort: 'low', contextWindow: 8192,
          }) + '\n');
          isolateSidecar();
          await session.getQueryRunner();
          expect(f.config.getModel()).toBe(
            'model' in initialize ? initialize.model : 'm-1',
          );
          const preference = f.preferences.get(f.config.getModel());
          expect(preference?.reasoning?.effort).toBe('high');
          expect(preference?.context?.contextWindow).toBe(32768);
          await session.close();
          const persisted = await f.store.repository().loadIndex(f.filePath);
          expect(
            persisted?.metadata.runtimeConfigs.get(f.options.sessionId)?.model,
          ).toBe('model' in initialize ? initialize.model : 'm-1');
        },
      );
    } finally {
      mockedRestore.mockImplementation(async () => ({}));
      await session.close();
      await f.cleanup();
    }
  });

  it('冷恢复遇到真实共享 Writer 冲突后，hook/控制复用同一失败、不重扫或写盘', async () => {
    const f = await transcriptFixture();
    const active = await f.store.acquireSessionWriter({
      filePath: f.filePath,
      sessionId: f.options.sessionId,
      cwd: f.root,
      entrypoint: 'cli',
    });
    const attempt = await beginResumeRead({});
    try {
      const candidate = await f.store
        .repository()
        .readForResume(f.filePath, { sessionId: f.options.sessionId, attempt });
      const before = await fs.readFile(f.filePath);
      const read = vi.spyOn(f.store.repository(), 'readForResume');
      const session = new ThreadSession({
        ...f.options,
        resumeCandidate: candidate!,
      });
      Object.assign(session, { config: f.config, settings: {} });
      const hooks = (
        session as unknown as { hooks: { ensureStart(): Promise<void> } }
      ).hooks;
      await expect(hooks.ensureStart()).rejects.toMatchObject({
        reason: 'conflict',
      });
      await expect(session.getQueryRunner()).rejects.toMatchObject({
        reason: 'conflict',
      });
      await expect(session.persistSessionCheckpoint()).rejects.toMatchObject({
        reason: 'conflict',
      });
      expect(read).not.toHaveBeenCalled();
      expect(await fs.readFile(f.filePath)).toEqual(before);
      expect(active.hasMessageUuid('old')).toBe(true);
      await active.recordMessages(
        [userMessage('still-active', f.options.sessionId)],
        undefined,
        { immediate: true },
      );
      expect(active.hasMessageUuid('still-active')).toBe(true);
      expect(() => attempt.check()).toThrow();
      await session.close();
      await active.close();
    } finally {
      await attempt.finish();
      await f.cleanup();
    }
  });

  it('Writer 快照失效重读复用同一 attempt，提交新消息和元数据', async () => {
    const f = await transcriptFixture();
    try {
      const active = await f.store.acquireSessionWriter({
        filePath: f.filePath,
        sessionId: f.options.sessionId,
        cwd: f.root,
        entrypoint: 'cli',
      });
      const session = new ThreadSession(f.options);
      Object.assign(session, { config: f.config, settings: {} });
      await internalsOf(session).loadResumeMetadata(f.config);
      const initial = internalsOf(session).resumeSnapshot!;
      const wiredMessages = initial.messages;
      const attempt = initial.transcriptReadState?.attempt;
      const read = vi.spyOn(f.store.repository(), 'readForResume');
      await active.recordMessages(
        [userMessage('fresh', f.options.sessionId)],
        undefined,
        { immediate: true },
      );
      await active.recordCustomTitle('fresh-title');
      await active.close();
      isolateSidecar();
      const runner = await session.getQueryRunner();
      expect(runner.getMessages().map(({ uuid }) => uuid)).toEqual([
        'old',
        'fresh',
      ]);
      expect(initial.messages).toBe(wiredMessages);
      expect(initial.customTitle).toBe('fresh-title');
      const refreshed = await read.mock.results[0].value;
      expect(
        f.config.setSessionArtifactWorktreeStates,
      ).toHaveBeenLastCalledWith(refreshed.worktreeStates);
      expect(f.config.setSessionArtifactWorktreeStates).toHaveBeenCalledTimes(
        2,
      );
      expect(read.mock.calls[0][1].attempt).toBe(attempt);
      await session.close();
    } finally {
      await f.cleanup();
    }
  });

  it('刷新准备发现工作区边界变化，旧接线数组不变且不新增本次恢复记录', async () => {
    const f = await transcriptFixture();
    try {
      const active = await f.store.acquireSessionWriter({
        filePath: f.filePath,
        sessionId: f.options.sessionId,
        cwd: f.root,
        entrypoint: 'cli',
      });
      const session = new ThreadSession(f.options);
      Object.assign(session, { config: f.config, settings: {} });
      await internalsOf(session).loadResumeMetadata(f.config);
      const initial = internalsOf(session).resumeSnapshot!;
      const wiredMessages = initial.messages;
      await active.recordWorkspaceDirectories([
        f.root,
        path.join(f.root, 'other'),
      ]);
      await active.recordMessages(
        [userMessage('fresh', f.options.sessionId)],
        undefined,
        { immediate: true },
      );
      await active.close();
      const before = await fs.readFile(f.filePath);
      await expect(session.getQueryRunner()).rejects.toMatchObject({
        reason: 'unsafe',
      });
      expect(initial.messages).toBe(wiredMessages);
      expect(initial.messages.map(({ uuid }) => uuid)).toEqual(['old']);
      expect(await fs.readFile(f.filePath)).toEqual(before);
      await session.close();
    } finally {
      await f.cleanup();
    }
  });

  it('无 Writer 的候选快照变化，拒绝迟到运行态并释放 attempt', async () => {
    const f = await transcriptFixture(false);
    const attempt = await beginResumeRead({});
    try {
      const candidate = await f.store
        .repository()
        .readForResume(f.filePath, { sessionId: f.options.sessionId, attempt });
      await fs.appendFile(f.filePath, '\n');
      const session = new ThreadSession({
        ...f.options,
        resumeCandidate: candidate!,
      });
      Object.assign(session, { config: f.config, settings: {} });
      await expect(session.getQueryRunner()).rejects.toMatchObject({
        reason: 'snapshot',
      });
      expect(session.peekQueryRunner()).toBeNull();
      expect(() => attempt.check()).toThrow();
      await session.close();
    } finally {
      await attempt.finish();
      await f.cleanup();
    }
  });

  it('历史恢复期间取消不发布迟到 runner，不写运行配置且后续调用不重读', async () => {
    const f = await transcriptFixture();
    const controller = new AbortController();
    const attempt = await beginResumeRead({ signal: controller.signal });
    let session: ThreadSession | undefined;
    try {
      const candidate = await f.store.repository().readForResume(f.filePath, {
        sessionId: f.options.sessionId,
        attempt,
      });
      const before = await fs.readFile(f.filePath);
      const read = vi.spyOn(f.store.repository(), 'readForResume');
      const resume = SessionQueryRunner.prototype.resume;
      vi.spyOn(SessionQueryRunner.prototype, 'resume').mockImplementationOnce(
        async function (this: SessionQueryRunner, ...args) {
          controller.abort();
          await resume.apply(this, args);
        },
      );
      session = new ThreadSession({ ...f.options, resumeCandidate: candidate! });
      Object.assign(session, { config: f.config, settings: {} });
      isolateSidecar();
      await expect(session.getQueryRunner()).rejects.toMatchObject({
        reason: 'cancelled',
      });
      await session.close();
      expect(session.peekQueryRunner()).toBeNull();
      expect(session.getTranscriptPath()).toBeUndefined();
      await expect(session.getQueryRunner()).rejects.toMatchObject({
        reason: 'cancelled',
      });
      expect(read).not.toHaveBeenCalled();
      expect(await fs.readFile(f.filePath)).toEqual(before);
      expect(() => attempt.check()).toThrow();
    } finally {
      await session?.close();
      attempt.finish();
      await f.cleanup();
    }
  });

  it('真实文件不存在时恢复失败，不退化成空会话', async () => {
    const f = await transcriptFixture();
    try {
      await fs.unlink(f.filePath);
      const session = new ThreadSession(f.options);
      await expect(
        internalsOf(session).loadResumeMetadata(f.config),
      ).rejects.toMatchObject({ reason: 'snapshot' });
      expect(internalsOf(session).resumeSnapshot).toBeUndefined();
      await session.close();
    } finally {
      await f.cleanup();
    }
  });
});

describe('ThreadSession resume 恢复应用', () => {
  it('applyResumeRuntimeConfig 把 snapshot 交给 restoreRuntimeConfigFromResumeData', async () => {
    mockedRestore.mockClear();
    const options = params();
    const session = new ThreadSession(options);
    const internals = internalsOf(session);
    const snapshot = {
      sessionId: 'resume-metadata',
      messages: [],
      model: 'm-1',
    } as SessionResumeData;
    internals.resumeSnapshot = snapshot;

    await internals.applyResumeRuntimeConfig({} as Config);
    expect(mockedRestore).toHaveBeenCalledWith({} as Config, snapshot);

    internals.resumeSnapshot = undefined;
    await internals.applyResumeRuntimeConfig({} as Config);
    expect(mockedRestore).toHaveBeenCalledTimes(1);
    return dispose(options);
  });

  it('applyResumeWorkspaceDirectories：目录进 WorkspaceContext 与 permission，并刷新文件发现', () => {
    const options = params();
    const session = new ThreadSession(options);
    const internals = internalsOf(session);
    internals.resumeSnapshot = {
      sessionId: 'resume-metadata',
      messages: [],
      directories: ['/other', '   '],
    } as SessionResumeData;
    const setAdditionalDirectories = vi.fn();
    const refreshRuntimeWorkspaceServices = vi.fn();
    let directories = ['/project'];
    const config = {
      getWorkspaceContext: () => ({
        getDirectories: () => [...directories],
        addDirectories: vi.fn((added: string[]) => {
          directories = [...directories, ...added];
          return { added, failed: [] };
        }),
      }),
      permission: {
        getAdditionalDirectories: () => [],
        setAdditionalDirectories,
      },
      refreshRuntimeWorkspaceServices,
    } as unknown as Config;

    internals.applyResumeWorkspaceDirectories(config);
    expect(setAdditionalDirectories).toHaveBeenCalledWith(['/other']);
    expect(refreshRuntimeWorkspaceServices).toHaveBeenCalledTimes(1);
    return dispose(options);
  });

  it('没有可用的恢复目录时不触碰 workspace', () => {
    const options = params();
    const session = new ThreadSession(options);
    const internals = internalsOf(session);
    internals.resumeSnapshot = {
      sessionId: 'resume-metadata',
      messages: [],
      directories: ['   '],
    } as SessionResumeData;
    const addDirectories = vi.fn();
    const config = {
      getWorkspaceContext: () => ({
        getDirectories: () => ['/project'],
        addDirectories,
      }),
    } as unknown as Config;

    internals.applyResumeWorkspaceDirectories(config);
    expect(addDirectories).not.toHaveBeenCalled();
    return dispose(options);
  });
});
