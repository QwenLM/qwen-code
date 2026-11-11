/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SessionQueryRunner.resume 的两处恢复语义：
 *
 * 1. invoked skills：历史里的 `invoked_skills` 附件要回填 SkillManager 的激活状态
 *    （post-compact 重建与技能演进复核都读它），与 QueryEngine.resume 同形。
 * 2. attachment 上下文的 cwd：必须用会话 cwd（cwdContext），不能回落 daemon 进程目录
 *    ——否则历史附件的相对路径解析到错误根，文件读取基线全部错位。
 *
 * 协作者装配与 queryProjectionParity / selectedSkills 两个套件同式：cli 的 test-setup
 * 会在 vi.mock 注册前静态求值整张 core 图，只有 resetModules + 动态 import 才能让被测
 * 的 sessionQueryRunner 绑到带 mock 的那份。
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type SessionRuntimeBinding,
  type ToolRegistryFactory,
} from '@qwen-code/core';
import { createTestTranscriptWriter } from '../../../../../core/src/services/transcript/testing/fixtures.js';
import { storeWritesOnChain } from '../../../../../core/src/codemode/store.js';
import type { HookCoordinatorAdapter } from '../../../../../core/src/core/hook-coordinator-types.js';
import type { SessionStateKeyProvider } from '../../../../../core/src/services/session-state-crypto.js';
import type {
  SessionQueryRunner,
  SessionQueryRunnerConfig,
} from './sessionQueryRunner.js';
import type { Message } from '@qwen-code/core';

const MODEL_KEY = 'test-model';
const SESSION_CWD = path.join(os.tmpdir(), `qwen-resume-cwd-${process.pid}`);
const STATE_CONFIG_HOME = path.join(
  os.tmpdir(),
  `qwen-resume-state-${process.pid}`,
);

const skillManager = {
  activateSkill: vi.fn(),
  clearInvokedSkillsForAgent: vi.fn(),
};

let SessionQueryRunnerCtor!: typeof SessionQueryRunner;
let SessionStateStoreCtor!: typeof import('@qwen-code/core').SessionStateStore;

beforeAll(async () => {
  vi.resetModules();
  const [pkg, , runner] = await Promise.all([
    import('@qwen-code/core'),
    import('../../../../../core/src/test-utils/model-resolution.js'),
    import('./sessionQueryRunner.js'),
  ]);
  SessionQueryRunnerCtor = runner.SessionQueryRunner;
  SessionStateStoreCtor = pkg.SessionStateStore;
});

class StaticSessionStateKeyProvider implements SessionStateKeyProvider {
  async getMasterKey(): Promise<Buffer> {
    return Buffer.alloc(32, 7);
  }
}

function createRunnerConfig(): SessionQueryRunnerConfig {
  const config = {
    storage: {
      getProjectTempDir: () => os.tmpdir(),
      getPlansDir: () => os.tmpdir(),
    },
    getPermissionMode: () => 'acceptEdits',
    getModel: () => MODEL_KEY,
    getReasoningEffort: () => undefined,
    getCliReasoningEffort: () => undefined,
    getSkillManager: () => skillManager,
    getToolRegistry: () => ({ hasToolEnabled: () => false }),
    getSkillListingMaxDescChars: () => 80,
    getSkillListingBudgetFraction: () => 0.1,
    getSkillVisibilityOverrides: () => undefined,
    getMemoryContextManager: () => undefined,
    getGoalManager: () => undefined,
    getFileHistoryManager: () => undefined,
    isWorkflowsEnabled: () => false,
    getWorkflowKeywordTriggerEnabled: () => false,
    isUltracodeActive: () => false,
    isTasksEnabled: () => false,
    getSessionPersistence: () => false,
    getProjectRoot: () => os.tmpdir(),
    getTargetDir: () => SESSION_CWD,
    getWorkingDir: () => SESSION_CWD,
    onSkillChange: vi.fn().mockReturnValue(() => undefined),
    registerForkContextAccessors: vi.fn(),
    registerSessionRuntimeBinding: vi.fn(),
    planStateManager: undefined,
  } as unknown as SessionQueryRunnerConfig['config'];

  const hookCoordinator: HookCoordinatorAdapter = {
    fireBefore: vi.fn().mockResolvedValue(null),
    fireAfter: vi.fn().mockResolvedValue(null),
    drainPendingAsyncContext: vi.fn().mockReturnValue(undefined),
    fireStopFailure: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
  const toolRegistryFactory: ToolRegistryFactory = {
    create: vi.fn().mockReturnValue({
      getSchema: () => [],
      execute: vi.fn().mockResolvedValue({ toolResults: [], allMessages: [] }),
    }),
  };

  return {
    sessionId: 'resume-semantics',
    promptSurface: 'sdk' as const,
    defaultModel: MODEL_KEY,
    config,
    hookCoordinator,
    toolRegistryFactory,
    permissionMode: 'acceptEdits',
    sessionStateStoreFactory: (sid: string, { persist }: { persist: boolean }) =>
      new SessionStateStoreCtor({
        projectRoot: os.tmpdir(),
        sessionId: sid,
        configHomeDir: STATE_CONFIG_HOME,
        keyProvider: new StaticSessionStateKeyProvider(),
        persist,
      }),
  };
}

function attachmentMessage(attachment: Record<string, unknown>): Message {
  return {
    type: 'attachment',
    attachment,
    uuid: 'a-1',
    timestamp: '2026-01-01T00:00:00.000Z',
  } as unknown as Message;
}

describe('SessionQueryRunner.resume 的恢复语义', () => {
  it('标题从持久历史找回当前模型上下文已移除的原消息归属', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'title-history-'));
    const { writer } = await createTestTranscriptWriter({
      filePath: path.join(dir, 'session.jsonl'), sessionId: 'resume-semantics', cwd: dir, entrypoint: 'cli',
    });
    const runnerConfig = createRunnerConfig();
    runnerConfig.transcriptWriter = writer;
    const runner = new SessionQueryRunnerCtor(runnerConfig);
    try {
      const original = createUserMessage('执行文字\n附件引用', {
        requestSetId: 'original-turn',
        businessIdentity: { product: 'app', type: 'code_review', id: 'original-turn', model_key: 'ultimate' },
      });
      const later = createUserMessage('下一轮');
      await writer.recordMessages([original, later], null);
      await runner.resume([original, later], 'resume-semantics');
      runner.replaceMessages([later]);
      const history = await runner.getTitleSourceMessages(original.uuid);
      expect(history.find((message) => message.uuid === original.uuid)).toMatchObject({ businessIdentity: original.businessIdentity });
      expect(history.some((message) => message.uuid === 'foreign-session-message')).toBe(false);
    } finally {
      runner.dispose();
      await writer.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

    it('restores CodeMode store writes from tool results on the active branch', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codemode-store-'));
      const { writer } = await createTestTranscriptWriter({
        filePath: path.join(dir, 'session-1.jsonl'),
        sessionId: 'session-1',
        cwd: dir,
        entrypoint: 'cli',
      });
      try {
        const registerSessionRuntimeBinding = vi.fn();
        const runnerConfig = createRunnerConfig();
        runnerConfig.transcriptWriter = writer;
        runnerConfig.config.registerSessionRuntimeBinding = registerSessionRuntimeBinding;
        const engine = new SessionQueryRunnerCtor(runnerConfig);
        const store = (
          registerSessionRuntimeBinding.mock.calls[0][0] as SessionRuntimeBinding
        ).activeConversation!;
        const load = async () => storeWritesOnChain(await store.readChain());
        const codeMode = (key: string) => ({
          type: 'tool_result' as const,
          is_error: false,
          tool_use_id: `call-${key}`,
          content: 'ok',
          toolUseResult: {
            type: 'code_mode',
            status: 'completed',
            storeWrites: [{ key, value: true }],
          },
        });
        const exchange = (
          text: string,
          results: Parameters<typeof createToolResultMessage>[0],
        ) => {
          const assistant = createAssistantMessage({
            messageId: `msg-${text}`,
            model: MODEL_KEY,
            blocks: [{ type: 'text', text }],
            stopReason: 'end_turn',
          });
          return [
            createUserMessage(text),
            assistant,
            createToolResultMessage(results, assistant.uuid),
          ];
        };
        const first = exchange('one', [codeMode('kept')]);
        // Positional results: only the CodeMode entry carries writes.
        const second = exchange('two', [
          {
            type: 'tool_result',
            is_error: false,
            tool_use_id: 'read',
            content: 'x',
            toolUseResult: { type: 'text' },
          },
          codeMode('later'),
        ]);
        const leaf = await writer.recordMessages(first, null);
        await writer.recordMessages(second, leaf);
        const before = store.revision();
        await engine.resume([...first, ...second], 'session-1');
        expect(store.revision()).not.toBe(before);
        expect(await load()).toEqual([
          [{ key: 'kept', value: true }],
          [{ key: 'later', value: true }],
        ]);
        // Rewinding to the first exchange drops writes made after it.
        engine.replaceMessages(first);
        expect(await load()).toEqual([[{ key: 'kept', value: true }]]);
        engine.dispose();
      } finally {
        await writer.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });


  it('历史 invoked_skills 附件回填 SkillManager 激活状态', async () => {
    const runner = new SessionQueryRunnerCtor(createRunnerConfig());
    try {
      skillManager.activateSkill.mockClear();
      skillManager.clearInvokedSkillsForAgent.mockClear();

      await runner.resume(
        [
          attachmentMessage({
            type: 'invoked_skills',
            skills: [{ name: 'review', content: 'review body' }],
          }),
        ],
        'resume-semantics',
      );

      expect(skillManager.clearInvokedSkillsForAgent).toHaveBeenCalledWith(
        'main',
      );
      expect(skillManager.activateSkill).toHaveBeenCalledWith(
        'review',
        'review body',
        'main',
      );
    } finally {
      runner.dispose();
    }
  });

  it('历史没有 invoked_skills 附件时只清空、不激活', async () => {
    const runner = new SessionQueryRunnerCtor(createRunnerConfig());
    try {
      skillManager.activateSkill.mockClear();
      skillManager.clearInvokedSkillsForAgent.mockClear();

      await runner.resume([], 'resume-semantics');

      expect(skillManager.clearInvokedSkillsForAgent).toHaveBeenCalledWith(
        'main',
      );
      expect(skillManager.activateSkill).not.toHaveBeenCalled();
    } finally {
      runner.dispose();
    }
  });

  it('历史附件的相对路径按会话 cwd 解析，而不是 daemon 进程目录', async () => {
    const runner = new SessionQueryRunnerCtor(createRunnerConfig());
    try {
      await runner.resume(
        [
          attachmentMessage({
            type: 'already_read_file',
            filename: 'relative.txt',
            content: 'cached body',
            mtime: 123,
          }),
        ],
        'resume-semantics',
      );

      const keys = [...runner.getFileReadState().keys()];
      expect(keys).toContain(path.join(SESSION_CWD, 'relative.txt'));
      expect(keys).not.toContain(path.join(process.cwd(), 'relative.txt'));
    } finally {
      runner.dispose();
    }
  });
});
