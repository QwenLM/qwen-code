/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * initialize 的 runner 面声明在 runner 懒建期间的暂存与回放。
 *
 * 回归的是「四项声明被静默丢弃」：applyInitializeDeclarations 跑在 initialize 握手期，
 * 那时 this.runner 必为 null（runner 首轮才建），旧代码的 `runner &&` / `runner?.` 门禁
 * 把 systemPrompt / appendSystemPrompt / includePartialMessages / modelRequestPatches
 * 全丢。worker 没这个问题（engine 启动期装配），所以这是 thread 链独有的迁移缺口。
 *
 * 三条用例：
 * 1. runner 未建时声明只暂存、不报错；
 * 2. buildQueryRunner 构造完 runner 后回放——断言落在**真 runner** 的私有状态上，
 *    覆盖的是接线本身而不只是暂存结构；
 * 3. runner 已存在时声明立即应用（首轮之后的再声明路径，与旧行为一致）。
 */

import { expect, it, vi } from 'vitest';import { createTestPermissionManager } from '../../test-utils/permissionManager.js';

import {
  ModelTransportManager,
  ResourceService,
} from '@qwen-code/core';
import { SettingsService } from '@qwen-code/resource';
import { ThreadSession, type ThreadSessionParams } from './threadSession.js';
import { SessionQueryRunner } from './query/sessionQueryRunner.js';

// runner 构造里的会话状态存储是磁盘 I/O，与本回归无关：桩掉私有缝，只留构造本身。
vi.spyOn(
  SessionQueryRunner.prototype as unknown as {
    openSessionStateStore(): unknown;
  },
  'openSessionStateStore',
).mockReturnValue({});

// 权限接线要真 Config 的 permission 内部面，fake config 供不起；与本回归无关，桩掉。
vi.mock('./host/sessionPermissionChannel.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installThreadPermissionHandling: vi.fn(),
}));

function params(): ThreadSessionParams {
  return {
    sessionId: 'init-declarations',
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

/** applyInitializeDeclarations / buildQueryRunner 只需要少数 config 方法有真值，
 *  其余一律 vi.fn() 兜底（返回 undefined 即关断对应可选装配）。 */
function fakeConfig(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {
    getWorkingDir: () => '/project',
    getOutputFormat: () => 'stream-json',
    getSessionPersistence: () => false,
    setPromptAssembler: vi.fn(),
    setFileHistoryManager: vi.fn(),
  };
  return new Proxy(overrides, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      const stub = vi.fn();
      Reflect.set(target, prop, stub);
      return stub;
    },
  }) as Record<string, unknown>;
}

function fakeRunner(): Record<string, unknown> & {
  updateSystemPromptSources: ReturnType<typeof vi.fn>;
  updateSdkMemoryPrompt: ReturnType<typeof vi.fn>;
  setIncludePartialMessages: ReturnType<typeof vi.fn>;
  setModelRequestPatches: ReturnType<typeof vi.fn>;
} {
  return {
    updateSystemPromptSources: vi.fn(),
    updateSdkMemoryPrompt: vi.fn(),
    setIncludePartialMessages: vi.fn(),
    setModelRequestPatches: vi.fn(),
  };
}

type SessionInternals = {
  runner: unknown;
  config: unknown;
  settings: unknown;
  pendingRunnerDeclarations: Record<string, unknown>;
  applyRunnerDeclarationsToRunner(): void;
};

function internals(session: ThreadSession): SessionInternals {
  return session as unknown as SessionInternals;
}

it('runner 未建时声明只暂存，不抛错也不丢', async () => {
  const session = new ThreadSession(params());
  Object.assign(session, { config: fakeConfig() });

  await session.applyInitializeDeclarations({
    appendSystemPrompt: 'APPEND-X',
    includePartialMessages: true,
  } as never);

  const pending = internals(session).pendingRunnerDeclarations;
  expect(pending['promptSources']).toEqual({
    overrideSystemPrompt: null,
    appendSystemPrompt: 'APPEND-X',
  });
  expect(pending['includePartialMessages']).toBe(true);
  expect(internals(session).runner).toBeNull();
});

it('buildQueryRunner 构造完 runner 后回放暂存声明', async () => {
  const session = new ThreadSession(params());
  Object.assign(session, { config: fakeConfig(), settings: {} });

  await session.applyInitializeDeclarations({
    systemPrompt: 'OVERRIDE-Y',
    includePartialMessages: true,
  } as never);

  const runner = await session.getQueryRunner();
  const state = runner as unknown as {
    systemPromptOverride?: string;
    includePartialMessages?: boolean;
  };
  expect(state.systemPromptOverride).toBe('OVERRIDE-Y');
  expect(state.includePartialMessages).toBe(true);
});

it('runner 已存在时声明立即应用，不经暂存回放', async () => {
  const session = new ThreadSession(params());
  Object.assign(session, { config: fakeConfig() });
  const runner = fakeRunner();
  Object.assign(session, { runner });

  await session.applyInitializeDeclarations({
    appendSystemPrompt: 'APPEND-Z',
  } as never);

  expect(runner.updateSystemPromptSources).toHaveBeenCalledWith({
    overrideSystemPrompt: null,
    appendSystemPrompt: 'APPEND-Z',
  });
});
