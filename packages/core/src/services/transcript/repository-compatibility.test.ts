/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cloneUsage } from '../../protocol/provider/empty-usage.js';
import { SkillListingAttachment } from '../../attachments/models/skill-attachments.js';
import { HookOutputAttachment } from '../../attachments/models/hook-attachments.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AttachmentMessage,
  AssistantMessage,
  Message,
  SystemMessage,
} from '../../protocol/transcript/message.js';
import type {
  ActiveLeafEntry,
  TranscriptMessage,
} from '../../protocol/transcript/entry.js';
import {
  createToolResultMessage,
  createUserMessage,
} from '../../protocol/transcript/conversions.js';
import { createTestTranscriptWriter } from './testing/fixtures.js';
import { TranscriptRepository } from './repository.js';
import { computeLeafUuids, resolveTranscriptChain } from './graph-resolver.js';
import { filterUnresolvedToolUses } from './resume-projector.js';
import { runLogger } from '../../utils/runLogger.js';
import { createAttachmentMessage } from '../../attachments/factory.js';
import { HookEventName } from '../../hooks/types.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function makeAssistantMessage(options?: {
  text?: string;
  content?: AssistantMessage['message']['content'];
  stopReason?: AssistantMessage['message']['stop_reason'];
}): AssistantMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: randomUUID(),

      model: 'test-model',
      stop_reason:
        options?.stopReason === undefined ? 'end_turn' : options.stopReason,

      usage: {
        ...cloneUsage(),
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: options?.content ?? [
        { type: 'text', text: options?.text ?? 'assistant' },
      ],
    },
  };
}

async function createTempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-reader-'));
  tempDirs.push(dir);
  return path.join(dir, 'session.jsonl');
}

function toTranscriptMessage(
  message: Message,
  parentUuid: string | null,
  overrides: Partial<TranscriptMessage> = {},
): TranscriptMessage {
  return {
    ...message,
    parentUuid,
    isSidechain: false,
    cwd: '/workspace/project',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.2.3',
    timestamp: message.timestamp,
    ...overrides,
  } as TranscriptMessage;
}

/**
 * 将新 Reader 分层架构组合成旧测试使用的观察面。
 *
 * 这个适配器只存在于测试中，用于逐项验证历史 transcript 语义；生产代码不再
 * 提供旧测试观察面。
 */
class RepositoryCompatibilityHarness {
  private readonly repository = new TranscriptRepository();

  async readTranscriptForLoad(filePath: string) {
    const projected = await this.repository.resolveSession(filePath);
    if (!projected) {
      return {
        entries: [],
        messages: new Map<string, TranscriptMessage>(),
        leafUuids: new Set<string>(),
        summaries: new Map<string, string>(),
        customTitles: new Map<string, string>(),
        aiTitles: new Map<string, string>(),
        lastPrompts: new Map<string, string>(),
        tags: new Map<string, string>(),
        workspaceDirectories: new Map<string, readonly string[]>(),
        runtimeConfigs: new Map(),
        modes: new Map(),
        fileHistorySnapshots: [],
        contentReplacements: new Map(),
        hasCompactBoundary: false,
        compatibilityDiagnostics: [],
      };
    }
    const { index, compatible } = projected;
    return {
      entries: index.entriesInFileOrder.map((indexed) => indexed.entry),
      messages: compatible.messagesByUuid,
      leafUuids: computeLeafUuids(compatible),
      ...index.metadata,
      fileHistorySnapshots: projected.fileHistorySnapshots,
      contentReplacements: projected.contentReplacements,
      hasCompactBoundary: compatible.hasCompactBoundary,
      compatibilityDiagnostics: compatible.diagnostics,
    };
  }

  buildConversationChain(
    messages: ReadonlyMap<string, TranscriptMessage>,
    leafUuid?: string,
  ): readonly TranscriptMessage[] {
    return resolveTranscriptChain(
      {
        messagesByUuid: messages,
        orderByUuid: new Map(
          [...messages.keys()].map((uuid, order) => [uuid, order]),
        ),
      },
      leafUuid,
    ).messages;
  }

  filterUnresolvedToolUses(messages: readonly Message[]): readonly Message[] {
    return filterUnresolvedToolUses(messages);
  }
}

describe('transcript repository compatibility', () => {
  it('resumes all attachments at their original turn boundary', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });
    const user = createUserMessage('inspect the repository');
    const skills = createAttachmentMessage(
      new SkillListingAttachment({
        type: 'skill_listing',
        content: '- inspect: Inspect a repository',
        names: ['inspect'],
        skillCount: 1,
        isInitial: true,
      }),
    ) as unknown as Message;
    const hook = createAttachmentMessage(
      new HookOutputAttachment({
        type: 'hook_output',
        hookEventName: HookEventName.UserPromptSubmit,
        output: 'follow repository policy',
      }),
    ) as unknown as Message;
    // Historical attachments remain readable without a runtime model.
    const dynamicSkill = {
      type: 'attachment',
      uuid: 'historical-dynamic-skill',
      timestamp: new Date().toISOString(),
      attachment: {
        type: 'dynamic_skill',
        skillDir: '/workspace/.skills',
        skillNames: ['inspect'],
        displayPath: '.skills',
      },
    } as unknown as Message;
    const assistant = makeAssistantMessage({ text: 'done' });

    await writer.recordMessages([user, skills, hook, dynamicSkill, assistant]);
    await writer.flush();

    const projected = await new TranscriptRepository().resolveSession(filePath);

    expect(projected?.messages.map((message) => message.uuid)).toEqual([
      user.uuid,
      skills.uuid,
      hook.uuid,
      dynamicSkill.uuid,
      assistant.uuid,
    ]);
    expect(projected?.messages.map((message) => message.type)).toEqual([
      'user',
      'attachment',
      'attachment',
      'attachment',
      'assistant',
    ]);
  });

  it('drops a malformed persisted attachment without losing later conversation messages', async () => {
    const filePath = await createTempFile();
    const user = createUserMessage('continue after a damaged attachment');
    const assistant = makeAssistantMessage({ text: 'conversation recovered' });
    const userEntry = toTranscriptMessage(user, null);
    const malformedEntry = {
      ...toTranscriptMessage(
        createAttachmentMessage(
          new SkillListingAttachment({
            type: 'skill_listing',
            content: 'placeholder',
            names: [],
            skillCount: 0,
            isInitial: true,
          }),
        ) as unknown as Message,
        user.uuid,
      ),
      attachment: null,
    } as unknown as TranscriptMessage;
    const assistantEntry = toTranscriptMessage(assistant, malformedEntry.uuid);
    await fs.writeFile(
      filePath,
      `${[userEntry, malformedEntry, assistantEntry]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
      'utf8',
    );

    const projected = await new TranscriptRepository().resolveSession(filePath);

    expect(projected?.messages.map((message) => message.uuid)).toEqual([
      user.uuid,
      assistant.uuid,
    ]);
    expect(projected?.chain.map((message) => message.uuid)).toEqual([
      user.uuid,
      assistant.uuid,
    ]);
    expect(projected?.chain[1]?.parentUuid).toBe(user.uuid);
    expect(projected?.leafUuid).toBe(assistant.uuid);
  });

  it('keeps the complete resume chain across a durable task reminder', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });

    const firstUser = createUserMessage('original request');
    const firstAssistant = makeAssistantMessage({ text: 'working' });
    const reminder: AttachmentMessage = {
      type: 'attachment',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      attachment: {
        type: 'task_reminder',
        content: [
          {
            id: '1',
            subject: 'finish the work',
            description: 'resume-chain regression task',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          },
        ],
        itemCount: 1,
      },
    };
    const secondUser = createUserMessage('continue');
    const secondAssistant = makeAssistantMessage({ text: 'continued' });

    await writer.recordMessages([
      firstUser,
      firstAssistant,
      reminder,
      secondUser,
      secondAssistant,
    ]);
    await writer.flush();

    const projected = await new TranscriptRepository().resolveSession(filePath);

    expect(projected?.chain.map((message) => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
      reminder.uuid,
      secondUser.uuid,
      secondAssistant.uuid,
    ]);
    expect(projected?.messages.map((message) => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
      reminder.uuid,
      secondUser.uuid,
      secondAssistant.uuid,
    ]);
  });

  it('normalizes a task-reminder leaf to its user ancestor', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });

    const user = createUserMessage('continue tracked work');
    const reminder: AttachmentMessage = {
      type: 'attachment',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      attachment: {
        type: 'task_reminder',
        content: [
          {
            id: '1',
            subject: 'finish the work',
            description: 'terminal reminder regression task',
            status: 'pending',
            blocks: [],
            blockedBy: [],
          },
        ],
        itemCount: 1,
      },
    };

    await writer.recordMessages([user, reminder]);
    await writer.flush();

    const repository = new TranscriptRepository();
    const projected = await repository.resolveSession(filePath);
    const writerState = await repository.loadSessionWriterState(
      filePath,
      'session-1',
    );

    expect(projected?.leafUuid).toBe(user.uuid);
    expect(projected?.messages.map((message) => message.uuid)).toEqual([
      user.uuid,
      reminder.uuid,
    ]);
    expect(writerState.mainParentUuid).toBe(user.uuid);
  });

  it('does not let a terminal task reminder make an incomplete branch stable', async () => {
    const filePath = await createTempFile();
    const user = createUserMessage('choose the stable branch');
    user.uuid = 'user-uuid';
    user.timestamp = '2026-08-04T00:00:00.000Z';

    const stableAssistant = makeAssistantMessage({ text: 'stable answer' });
    stableAssistant.uuid = 'stable-assistant-uuid';
    (stableAssistant as AssistantMessage & { parentUuid: string }).parentUuid =
      user.uuid;
    stableAssistant.timestamp = '2026-08-04T00:01:00.000Z';

    const incompleteAssistant = makeAssistantMessage({
      content: [{ type: 'text', text: 'incomplete' }],
      stopReason: undefined,
    });
    incompleteAssistant.message = {
      ...incompleteAssistant.message,
      stop_reason: null,
    };
    incompleteAssistant.uuid = 'incomplete-assistant-uuid';
    (
      incompleteAssistant as AssistantMessage & { parentUuid: string }
    ).parentUuid = user.uuid;
    incompleteAssistant.timestamp = '2026-08-04T00:02:00.000Z';

    const reminder: Extract<TranscriptMessage, { type: 'attachment' }> = {
      type: 'attachment',
      uuid: 'task-reminder-uuid',
      parentUuid: incompleteAssistant.uuid,
      isSidechain: false,
      cwd: '/workspace/project',
      sessionId: 'session-1',
      userType: 'external',
      version: '1.2.3',
      timestamp: '2026-08-04T00:03:00.000Z',
      attachment: {
        type: 'task_reminder',
        content: [],
        itemCount: 0,
      },
    };

    await fs.writeFile(
      filePath,
      [user, stableAssistant, incompleteAssistant, reminder]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
      'utf8',
    );

    const repository = new TranscriptRepository();
    const projected = await repository.resolveSession(filePath);
    const writerState = await repository.loadSessionWriterState(
      filePath,
      'session-1',
    );

    expect(projected?.leafUuid).toBe(stableAssistant.uuid);
    expect(projected?.messages.map((message) => message.uuid)).toEqual([
      user.uuid,
      stableAssistant.uuid,
    ]);
    expect(writerState.mainParentUuid).toBe(stableAssistant.uuid);
  });

  it('reads transcript entries and rebuilds the latest conversation chain', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });

    const user = createUserMessage('hello');
    const assistant = makeAssistantMessage({ text: 'world' });
    const compactBoundary: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      subtype: 'compact_boundary',
      content: 'compacted',
      level: 'info',
      isCompactSummary: true,
    };
    const resumedAssistant = makeAssistantMessage({ text: 'after compact' });

    await writer.recordMessages([
      user,
      assistant,
      compactBoundary,
      resumedAssistant,
    ]);
    await writer.flush();

    await fs.appendFile(
      filePath,
      `${JSON.stringify({
        type: 'last-prompt',
        sessionId: 'session-1',
        lastPrompt: 'hello',
      })}\n`,
      'utf8',
    );
    await fs.appendFile(
      filePath,
      `${JSON.stringify({
        type: 'workspace-directories',
        sessionId: 'session-1',
        directories: ['/workspace/project', '/workspace/extra'],
      })}\n`,
      'utf8',
    );
    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);

    expect(result.hasCompactBoundary).toBe(true);
    expect(result.lastPrompts.get('session-1')).toBe('hello');
    expect(result.workspaceDirectories.get('session-1')).toEqual([
      '/workspace/project',
      '/workspace/extra',
    ]);
    expect(result.runtimeConfigs.get('session-1')).toBeUndefined();
    expect(result.leafUuids.has(resumedAssistant.uuid)).toBe(true);

    const chain = reader.buildConversationChain(result.messages);
    expect(chain.map((message) => message.uuid)).toEqual([
      compactBoundary.uuid,
      resumedAssistant.uuid,
    ]);
    expect(chain[1]?.type).toBe('assistant');
    expect((chain[1] as AssistantMessage).message.content).toEqual(
      resumedAssistant.message.content,
    );

    const relinkedBoundary = result.messages.get(compactBoundary.uuid);
    expect(relinkedBoundary?.parentUuid).toBeNull();
    expect(relinkedBoundary?.logicalParentUuid).toBe(assistant.uuid);
  });

  it('keeps the latest runtime config metadata for each session', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });

    await writer.recordRuntimeConfig({
      model: 'model-a',
      reasoningEffort: null,
      contextWindow: 256000,
    });
    await writer.recordMessages([createUserMessage('hello')]);
    await writer.recordRuntimeConfig({
      model: 'model-a',
      reasoningEffort: 'medium',
      contextWindow: null,
    });
    await writer.close();

    const result =
      await new RepositoryCompatibilityHarness().readTranscriptForLoad(
        filePath,
      );

    expect(result.runtimeConfigs.get('session-1')).toMatchObject({
      type: 'runtime-config',
      sessionId: 'session-1',
      model: 'model-a',
      reasoningEffort: 'medium',
      contextWindow: null,
    });
  });

  it('uses explicit leafUuid when provided', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });

    const firstUser = createUserMessage('first');
    const firstAssistant = makeAssistantMessage({ text: 'first reply' });
    const secondUser = createUserMessage('second');
    const secondAssistant = makeAssistantMessage({ text: 'second reply' });

    await writer.recordMessages([firstUser, firstAssistant]);
    await writer.recordMessages(
      [firstUser, firstAssistant, secondUser, secondAssistant],
      firstAssistant.uuid,
    );
    await writer.flush();

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);

    const chain = reader.buildConversationChain(
      result.messages,
      firstAssistant.uuid,
    );
    expect(chain.map((message) => message.uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ]);
  });

  it('resumes from the latest active leaf marker for the requested session', async () => {
    const filePath = await createTempFile();
    const firstUser = createUserMessage('first');
    const firstAssistant = makeAssistantMessage({ text: 'first reply' });
    const secondUser = createUserMessage('second');
    const secondAssistant = makeAssistantMessage({ text: 'second reply' });
    const firstUserEntry = toTranscriptMessage(firstUser, null);
    const firstAssistantEntry = toTranscriptMessage(
      firstAssistant,
      firstUser.uuid,
    );
    const secondUserEntry = toTranscriptMessage(
      secondUser,
      firstAssistant.uuid,
    );
    const secondAssistantEntry = toTranscriptMessage(
      secondAssistant,
      secondUser.uuid,
    );
    const activeLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: firstAssistant.uuid,
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    const entries = [
      firstUserEntry,
      firstAssistantEntry,
      secondUserEntry,
      secondAssistantEntry,
      {
        type: 'file-history-snapshot',
        messageId: firstUser.uuid,
        snapshot: {
          messageId: firstUser.uuid,
          timestamp: '2026-08-04T00:00:00.000Z',
          trackedFileBackups: {},
        },
        isSnapshotUpdate: false,
      },
      {
        type: 'file-history-snapshot',
        messageId: secondUser.uuid,
        snapshot: {
          messageId: secondUser.uuid,
          timestamp: '2026-08-04T00:00:01.000Z',
          trackedFileBackups: {},
        },
        isSnapshotUpdate: false,
      },
      {
        type: 'content-replacement',
        sessionId: 'session-1',
        replacements: [
          {
            messageUuid: firstAssistant.uuid,
            blockIndex: 0,
            originalType: 'text',
            stubContent: 'active replacement',
          },
          {
            messageUuid: secondAssistant.uuid,
            blockIndex: 0,
            originalType: 'text',
            stubContent: 'inactive replacement',
          },
        ],
      },
      activeLeaf,
    ];
    await fs.writeFile(
      filePath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
      'utf8',
    );
    const repository = new TranscriptRepository();

    const resumed = await repository.resolveSession(filePath, {
      sessionId: 'session-1',
    });

    expect(resumed?.messages.map(({ uuid }) => uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ]);
    expect(
      resumed?.fileHistorySnapshots.map(({ messageId }) => messageId),
    ).toEqual([firstUser.uuid]);
    expect(resumed?.contentReplacements.get('session-1')).toEqual([
      expect.objectContaining({
        messageUuid: firstAssistant.uuid,
        stubContent: 'active replacement',
      }),
    ]);

    const callerOverride = await repository.resolveSession(filePath, {
      sessionId: 'session-1',
      leafUuid: secondAssistant.uuid,
    });
    expect(callerOverride?.messages.map(({ uuid }) => uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
      secondUser.uuid,
      secondAssistant.uuid,
    ]);
    await expect(
      repository.loadSessionWriterState(filePath, 'session-1'),
    ).resolves.toMatchObject({ mainParentUuid: firstAssistant.uuid });
  });

  it('treats an active null marker as an explicitly empty conversation', async () => {
    const filePath = await createTempFile();
    const existing = toTranscriptMessage(createUserMessage('existing'), null);
    const activeLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: null,
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    await fs.writeFile(
      filePath,
      `${JSON.stringify(existing)}\n${JSON.stringify(activeLeaf)}\n`,
      'utf8',
    );
    const repository = new TranscriptRepository();

    const resumed = await repository.resolveSession(filePath, {
      sessionId: 'session-1',
    });

    expect(resumed?.messages).toEqual([]);
    await expect(
      repository.loadSessionWriterState(filePath, 'session-1'),
    ).resolves.toMatchObject({ mainParentUuid: null });
  });

  it('records a diagnostic and falls back when the persisted active leaf is missing', async () => {
    const filePath = await createTempFile();
    const existing = toTranscriptMessage(createUserMessage('existing'), null);
    const invalidActiveLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: 'missing',
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    await fs.writeFile(
      filePath,
      `${JSON.stringify(existing)}\n${JSON.stringify(invalidActiveLeaf)}\n`,
      'utf8',
    );
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const repository = new TranscriptRepository();

    const resumed = await repository.resolveSession(filePath, {
      sessionId: 'session-1',
    });

    expect(resumed?.messages.map(({ uuid }) => uuid)).toEqual([existing.uuid]);
    await expect(
      repository.loadSessionWriterState(filePath, 'session-1'),
    ).resolves.toMatchObject({ mainParentUuid: existing.uuid });
    expect(warn).toHaveBeenCalledWith(
      'transcript.active_leaf.invalid',
      'session=session-1',
      'leaf=missing',
      'reason=missing',
      'fallback=default-leaf',
    );
  });

  it('falls back to a healthy conversation when the active system leaf has a dangling parent', async () => {
    const filePath = await createTempFile();
    const existing = toTranscriptMessage(
      createUserMessage('existing conversation'),
      null,
      { timestamp: '2026-08-04T00:00:00.000Z' },
    );
    const warning = toTranscriptMessage(
      {
        type: 'system',
        uuid: randomUUID(),
        timestamp: '2026-08-04T00:01:00.000Z',
        subtype: 'informational',
        content: 'startup command conflict',
        level: 'info',
        isMeta: false,
      },
      'missing-parent',
    );
    const activeLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: warning.uuid,
      explicit: false,
      timestamp: 1_754_300_000_000,
    };
    await fs.writeFile(
      filePath,
      `${JSON.stringify(existing)}\n${JSON.stringify(warning)}\n${JSON.stringify(activeLeaf)}\n`,
      'utf8',
    );
    const repository = new TranscriptRepository();

    const resumed = await repository.resolveSession(filePath, {
      sessionId: 'session-1',
    });

    expect(resumed?.leafUuid).toBe(existing.uuid);
    expect(resumed?.messages.map(({ uuid }) => uuid)).toEqual([existing.uuid]);
    await expect(
      repository.loadSessionWriterState(filePath, 'session-1'),
    ).resolves.toMatchObject({ mainParentUuid: existing.uuid });
  });

  it('records a diagnostic and falls back when the active leaf belongs to another session', async () => {
    const filePath = await createTempFile();
    const localLeaf = toTranscriptMessage(createUserMessage('local'), null, {
      timestamp: '2026-08-04T00:00:02.000Z',
    });
    const foreignLeaf = toTranscriptMessage(
      createUserMessage('foreign'),
      null,
      {
        sessionId: 'session-2',
        timestamp: '2026-08-04T00:00:01.000Z',
      },
    );
    const invalidActiveLeaf: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: foreignLeaf.uuid,
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    await fs.writeFile(
      filePath,
      `${JSON.stringify(localLeaf)}\n${JSON.stringify(foreignLeaf)}\n${JSON.stringify(invalidActiveLeaf)}\n`,
      'utf8',
    );
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
    const repository = new TranscriptRepository();

    const resumed = await repository.resolveSession(filePath, {
      sessionId: 'session-1',
    });

    expect(resumed?.messages.map(({ uuid }) => uuid)).toEqual([localLeaf.uuid]);
    await expect(
      repository.loadSessionWriterState(filePath, 'session-1'),
    ).resolves.toMatchObject({ mainParentUuid: localLeaf.uuid });
    expect(warn).toHaveBeenCalledWith(
      'transcript.active_leaf.invalid',
      'session=session-1',
      `leaf=${foreignLeaf.uuid}`,
      'reason=session-mismatch',
      'fallback=default-leaf',
    );
  });

  it('preserves legacy default leaf selection when no marker exists', async () => {
    const filePath = await createTempFile();
    const first = toTranscriptMessage(createUserMessage('first'), null);
    const second = toTranscriptMessage(createUserMessage('second'), first.uuid);
    await fs.writeFile(
      filePath,
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`,
      'utf8',
    );

    const resumed = await new TranscriptRepository().resolveSession(filePath, {
      sessionId: 'session-1',
    });

    expect(resumed?.messages.map(({ uuid }) => uuid)).toEqual([
      first.uuid,
      second.uuid,
    ]);
  });

  it('honors the last complete marker when a later active leaf line is truncated', async () => {
    const filePath = await createTempFile();
    const firstUser = createUserMessage('first');
    const firstAssistant = makeAssistantMessage({ text: 'first reply' });
    const laterUser = createUserMessage('later');
    const laterAssistant = makeAssistantMessage({ text: 'later reply' });
    const marker: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: firstAssistant.uuid,
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    const entries = [
      toTranscriptMessage(firstUser, null),
      toTranscriptMessage(firstAssistant, firstUser.uuid),
      marker,
      toTranscriptMessage(laterUser, firstAssistant.uuid),
      toTranscriptMessage(laterAssistant, laterUser.uuid),
    ];
    const truncatedMarker =
      '{"type":"active-leaf","sessionId":"session-1","leafUuid":';
    await fs.writeFile(
      filePath,
      `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n${truncatedMarker}`,
      'utf8',
    );
    const repository = new TranscriptRepository();

    const index = await repository.loadIndex(filePath);
    expect(index?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'malformed', line: 6 }),
      ]),
    );
    expect(index?.metadata.activeLeaves.get('session-1')).toEqual(marker);

    const resumed = await repository.resolveSession(filePath, {
      sessionId: 'session-1',
    });
    expect(resumed?.messages.map(({ uuid }) => uuid)).toEqual([
      firstUser.uuid,
      firstAssistant.uuid,
    ]);
  });

  it('resumes the previous active leaf when compaction stops before its commit marker', async () => {
    const filePath = await createTempFile();
    const retainedUser = createUserMessage('x'.repeat(6 * 1024 * 1024));
    const retainedEntry = toTranscriptMessage(retainedUser, null);
    const marker: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: 'session-1',
      leafUuid: retainedUser.uuid,
      explicit: false,
      timestamp: 1_754_300_000_000,
    };
    const interruptedBoundary = toTranscriptMessage(
      {
        type: 'system',
        uuid: randomUUID(),
        timestamp: '2026-08-04T00:00:01.000Z',
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isCompactSummary: true,
        requiresActiveLeafCommit: true,
        compactMetadata: { trigger: 'auto', preTokens: 100 },
      },
      null,
      { logicalParentUuid: retainedUser.uuid },
    );
    await fs.writeFile(
      filePath,
      `${[retainedEntry, marker, interruptedBoundary]
        .map((entry) => JSON.stringify(entry))
        .join('\n')}\n`,
      'utf8',
    );

    const resumed = await new TranscriptRepository().resolveSession(filePath, {
      sessionId: 'session-1',
    });

    expect(resumed?.messages.map(({ uuid }) => uuid)).toEqual([
      retainedUser.uuid,
    ]);
  });

  it('round-trips exact human input whitespace through transcript projection', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });
    const input = '/skill   original\n  second line';
    const message = createUserMessage('expanded model prompt', {
      humanInput: { text: input, mode: 'prompt' },
    });

    await writer.recordMessages([message]);
    await writer.close();

    const resumed = await new TranscriptRepository().resolveSession(filePath, {
      sessionId: 'session-1',
    });
    expect(resumed?.messages[0]).toMatchObject({
      uuid: message.uuid,
      humanInput: { text: input, mode: 'prompt' },
    });
  });

  it('skips dangling thinking-only assistant leaves when selecting resume chain', async () => {
    const filePath = await createTempFile();
    const user = createUserMessage('hello');
    user.uuid = 'user-uuid';
    user.timestamp = '2026-05-12T00:00:00.000Z';

    const stableAssistant = makeAssistantMessage({ text: 'stable answer' });
    stableAssistant.uuid = 'stable-assistant-uuid';
    (stableAssistant as AssistantMessage & { parentUuid: string }).parentUuid =
      user.uuid;
    stableAssistant.timestamp = '2026-05-12T00:01:00.000Z';

    const danglingThinking = makeAssistantMessage({
      content: [
        {
          type: 'thinking',
          thinking: 'interrupted before the response completed',
          signature: '',
        },
      ],
      stopReason: undefined,
    });
    danglingThinking.message = {
      ...danglingThinking.message,
      stop_reason: null,
    };
    danglingThinking.uuid = 'dangling-thinking-uuid';
    (danglingThinking as AssistantMessage & { parentUuid: string }).parentUuid =
      user.uuid;
    danglingThinking.timestamp = '2026-05-12T00:02:00.000Z';

    await fs.writeFile(
      filePath,
      [user, stableAssistant, danglingThinking]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
      'utf8',
    );

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);
    const chain = reader.buildConversationChain(result.messages);

    expect(result.leafUuids.has(danglingThinking.uuid)).toBe(true);
    expect(chain.map((message) => message.uuid)).toEqual([
      user.uuid,
      stableAssistant.uuid,
    ]);
  });

  it('skips dangling non-terminal assistant leaves when selecting resume chain', async () => {
    const filePath = await createTempFile();
    const user = createUserMessage('hello');
    user.uuid = 'user-uuid';
    user.timestamp = '2026-05-12T00:00:00.000Z';

    const stableAssistant = makeAssistantMessage({ text: 'stable answer' });
    stableAssistant.uuid = 'stable-assistant-uuid';
    (stableAssistant as AssistantMessage & { parentUuid: string }).parentUuid =
      user.uuid;
    stableAssistant.timestamp = '2026-05-12T00:01:00.000Z';

    const danglingText = makeAssistantMessage({
      content: [{ type: 'text', text: 'partial text' }],
      stopReason: undefined,
    });
    danglingText.message = { ...danglingText.message, stop_reason: null };
    danglingText.uuid = 'dangling-text-uuid';
    (danglingText as AssistantMessage & { parentUuid: string }).parentUuid =
      user.uuid;
    danglingText.timestamp = '2026-05-12T00:02:00.000Z';

    await fs.writeFile(
      filePath,
      [user, stableAssistant, danglingText]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n',
      'utf8',
    );

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);
    const chain = reader.buildConversationChain(result.messages);

    expect(result.leafUuids.has(danglingText.uuid)).toBe(true);
    expect(chain.map((message) => message.uuid)).toEqual([
      user.uuid,
      stableAssistant.uuid,
    ]);
  });

  it('prunes pre-compact transcript messages for large resume loads', async () => {
    const filePath = await createTempFile();
    const largeText = 'x'.repeat(700 * 1024);
    const lines: unknown[] = [
      {
        type: 'custom-title',
        sessionId: 'session-1',
        customTitle: 'Large compacted session',
      },
      {
        type: 'tag',
        sessionId: 'session-1',
        tag: 'important',
      },
    ];

    let parentUuid: string | null = null;
    const oldMessageUuids: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const oldMessage = createUserMessage(`old ${index} ${largeText}`);
      oldMessageUuids.push(oldMessage.uuid);
      lines.push(toTranscriptMessage(oldMessage, parentUuid));
      parentUuid = oldMessage.uuid;
    }

    lines.push({
      type: 'file-history-snapshot',
      messageId: oldMessageUuids[0],
      snapshot: {
        messageId: oldMessageUuids[0],
        timestamp: new Date('2026-04-16T00:00:00.000Z'),
        trackedFileBackups: {},
      },
      isSnapshotUpdate: false,
    });
    lines.push({
      type: 'content-replacement',
      sessionId: 'session-1',
      replacements: [
        {
          messageUuid: oldMessageUuids[0],
          blockIndex: 0,
          originalType: 'tool_result',
          stubContent: 'old replacement',
        },
      ],
    });

    const boundary: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: new Date('2026-05-12T00:03:00.000Z').toISOString(),
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
    };
    const summary = createUserMessage('summary after compact');
    summary.isCompactSummary = true;
    const postAssistant = makeAssistantMessage({ text: 'post compact reply' });

    lines.push(
      toTranscriptMessage(boundary, null, { logicalParentUuid: parentUuid }),
      toTranscriptMessage(summary, boundary.uuid),
      toTranscriptMessage(postAssistant, summary.uuid),
      {
        type: 'content-replacement',
        sessionId: 'session-1',
        replacements: [
          {
            messageUuid: summary.uuid,
            blockIndex: 0,
            originalType: 'tool_result',
            stubContent: 'post replacement',
          },
        ],
      },
      {
        type: 'file-history-snapshot',
        messageId: summary.uuid,
        snapshot: {
          messageId: summary.uuid,
          timestamp: new Date('2026-04-16T00:00:01.000Z'),
          trackedFileBackups: {},
        },
        isSnapshotUpdate: false,
      },
    );

    await fs.writeFile(
      filePath,
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    );

    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(5 * 1024 * 1024);

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);
    const chain = reader.buildConversationChain(result.messages);

    expect(result.compatibilityDiagnostics).toContainEqual({
      kind: 'pre-compact-message-pruned',
      count: oldMessageUuids.length,
    });
    expect(result.hasCompactBoundary).toBe(true);
    expect(result.customTitles.get('session-1')).toBe(
      'Large compacted session',
    );
    expect(result.tags.get('session-1')).toBe('important');
    expect(result.messages.has(oldMessageUuids[0])).toBe(false);
    expect(chain.map((message) => message.uuid)).toEqual([
      boundary.uuid,
      summary.uuid,
      postAssistant.uuid,
    ]);
    expect(
      result.fileHistorySnapshots.map((snapshot) => snapshot.messageId),
    ).toEqual([summary.uuid]);
    expect(result.contentReplacements.get('session-1')).toEqual([
      {
        messageUuid: summary.uuid,
        blockIndex: 0,
        originalType: 'tool_result',
        stubContent: 'post replacement',
      },
    ]);
  });

  it('projects runtime and historical views across multiple Compact boundaries', async () => {
    const filePath = await createTempFile();
    const oldUser = createUserMessage('old user');
    oldUser.timestamp = '2026-05-12T00:00:00.000Z';
    const oldAssistant = makeAssistantMessage({ text: 'old assistant' });
    oldAssistant.timestamp = '2026-05-12T00:01:00.000Z';
    const boundary: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: '2026-05-12T00:02:00.000Z',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      isCompactSummary: true,
    };
    const summary = createUserMessage('summary');
    summary.timestamp = '2026-05-12T00:03:00.000Z';
    summary.isCompactSummary = true;
    const postAssistant = makeAssistantMessage({ text: 'post compact' });
    postAssistant.timestamp = '2026-05-12T00:04:00.000Z';
    const secondBoundary: SystemMessage = {
      ...boundary,
      uuid: randomUUID(),
      timestamp: '2026-05-12T00:05:00.000Z',
    };
    const secondSummary = createUserMessage('second summary');
    secondSummary.timestamp = '2026-05-12T00:06:00.000Z';
    secondSummary.isCompactSummary = true;
    const finalAssistant = makeAssistantMessage({ text: 'final reply' });
    finalAssistant.timestamp = '2026-05-12T00:07:00.000Z';

    const entries = [
      toTranscriptMessage(oldUser, null),
      toTranscriptMessage(oldAssistant, oldUser.uuid),
      toTranscriptMessage(boundary, null, {
        logicalParentUuid: oldAssistant.uuid,
      }),
      toTranscriptMessage(summary, boundary.uuid),
      toTranscriptMessage(postAssistant, summary.uuid),
      toTranscriptMessage(secondBoundary, null, {
        logicalParentUuid: postAssistant.uuid,
      }),
      toTranscriptMessage(secondSummary, secondBoundary.uuid),
      toTranscriptMessage(finalAssistant, secondSummary.uuid),
    ];
    await fs.writeFile(
      filePath,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    const repository = new TranscriptRepository();
    const runtime = await repository.resolveSession(filePath);
    const historical = await repository.resolveSession(filePath, {
      view: 'historical',
    });

    expect(runtime?.messages.map((message) => message.uuid)).toEqual([
      secondBoundary.uuid,
      secondSummary.uuid,
      finalAssistant.uuid,
    ]);
    expect(historical?.chain.map((message) => message.uuid)).toEqual([
      oldUser.uuid,
      oldAssistant.uuid,
      boundary.uuid,
      summary.uuid,
      postAssistant.uuid,
      secondBoundary.uuid,
      secondSummary.uuid,
      finalAssistant.uuid,
    ]);
    expect(historical?.messages.map((message) => message.uuid)).toEqual([
      oldUser.uuid,
      oldAssistant.uuid,
      postAssistant.uuid,
      finalAssistant.uuid,
    ]);
  });

  it('keeps pre-compact nodes in historical view for transcripts over 5 MB', async () => {
    const filePath = await createTempFile();
    const largeText = 'x'.repeat(900 * 1024);
    const entries: TranscriptMessage[] = [];
    let parentUuid: string | null = null;
    const oldUuids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const message = createUserMessage(`old ${index} ${largeText}`);
      message.timestamp = `2026-05-12T00:0${index}:00.000Z`;
      oldUuids.push(message.uuid);
      entries.push(toTranscriptMessage(message, parentUuid));
      parentUuid = message.uuid;
    }
    const boundary: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: '2026-05-12T00:07:00.000Z',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      isCompactSummary: true,
    };
    const summary = createUserMessage('summary');
    summary.timestamp = '2026-05-12T00:08:00.000Z';
    summary.isCompactSummary = true;
    const postAssistant = makeAssistantMessage({ text: 'post compact' });
    postAssistant.timestamp = '2026-05-12T00:09:00.000Z';
    entries.push(
      toTranscriptMessage(boundary, null, {
        logicalParentUuid: parentUuid,
      }),
      toTranscriptMessage(summary, boundary.uuid),
      toTranscriptMessage(postAssistant, summary.uuid),
    );
    await fs.writeFile(
      filePath,
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );

    expect((await fs.stat(filePath)).size).toBeGreaterThan(5 * 1024 * 1024);
    const historical = await new TranscriptRepository().resolveSession(
      filePath,
      { profile: { kind: 'compact-tail' }, view: 'historical' },
    );

    expect(historical?.messages[0]?.uuid).toBe(oldUuids[0]);
    expect(historical?.messages.at(-1)?.uuid).toBe(postAssistant.uuid);
  });

  it('keeps pre-compact metadata whose value contains compact boundary marker', async () => {
    const filePath = await createTempFile();
    const largeText = 'x'.repeat(700 * 1024);
    const boundary: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: new Date('2026-05-12T00:03:00.000Z').toISOString(),
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
    };
    const summary = createUserMessage('summary after compact');
    summary.isCompactSummary = true;
    const postAssistant = makeAssistantMessage({ text: 'post compact reply' });

    const lines: unknown[] = [
      {
        type: 'custom-title',
        sessionId: 'session-1',
        customTitle: 'compact_boundary',
      },
      {
        type: 'last-prompt',
        sessionId: 'session-1',
        lastPrompt: 'compact_boundary',
      },
    ];

    let parentUuid: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const message = createUserMessage(`old ${index} ${largeText}`);
      lines.push(toTranscriptMessage(message, parentUuid));
      parentUuid = message.uuid;
    }

    lines.push(
      toTranscriptMessage(boundary, null, { logicalParentUuid: parentUuid }),
      toTranscriptMessage(summary, boundary.uuid),
      toTranscriptMessage(postAssistant, summary.uuid),
    );

    await fs.writeFile(
      filePath,
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    );

    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(5 * 1024 * 1024);

    const result =
      await new RepositoryCompatibilityHarness().readTranscriptForLoad(
        filePath,
      );

    expect(result.compatibilityDiagnostics).toContainEqual(
      expect.objectContaining({ kind: 'pre-compact-message-pruned' }),
    );
    expect(result.customTitles.get('session-1')).toBe('compact_boundary');
    expect(result.lastPrompts.get('session-1')).toBe('compact_boundary');
  });

  it('keeps full transcript for large resume loads without compact boundary', async () => {
    const filePath = await createTempFile();
    const largeText = 'x'.repeat(700 * 1024);
    const lines: TranscriptMessage[] = [];

    let parentUuid: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const oldMessage = createUserMessage(`old ${index} ${largeText}`);
      lines.push(toTranscriptMessage(oldMessage, parentUuid));
      parentUuid = oldMessage.uuid;
    }

    await fs.writeFile(
      filePath,
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    );

    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(5 * 1024 * 1024);

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);

    expect(result.hasCompactBoundary).toBe(false);
    expect(result.messages.size).toBe(lines.length);
    expect(result.messages.has(lines[0].uuid)).toBe(true);
  });

  it('relinks preserved segment after compact boundary on resume', async () => {
    const filePath = await createTempFile();
    const oldUser = createUserMessage('old user');
    const oldAssistant = makeAssistantMessage({ text: 'old assistant' });
    const preservedUser = createUserMessage('preserved user');
    const preservedAssistant = makeAssistantMessage({
      text: 'preserved assistant',
    });
    const boundary: SystemMessage = {
      type: 'system',
      uuid: randomUUID(),
      timestamp: new Date('2026-05-12T00:03:00.000Z').toISOString(),
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
      compactMetadata: {
        trigger: 'auto',
        preTokens: 1000,
        messagesSummarized: 2,
        preservedSegment: {
          headUuid: preservedUser.uuid,
          anchorUuid: '',
          tailUuid: preservedAssistant.uuid,
        },
      },
    };
    const summary = createUserMessage('summary after compact');
    summary.isCompactSummary = true;
    boundary.compactMetadata!.preservedSegment!.anchorUuid = summary.uuid;
    const postAssistant = makeAssistantMessage({ text: 'post compact reply' });

    const lines: unknown[] = [
      toTranscriptMessage(oldUser, null),
      toTranscriptMessage(oldAssistant, oldUser.uuid),
      {
        type: 'content-replacement',
        sessionId: 'session-1',
        replacements: [
          {
            messageUuid: oldAssistant.uuid,
            blockIndex: 0,
            originalType: 'tool_result',
            stubContent: 'old replacement',
          },
        ],
      },
      toTranscriptMessage(preservedUser, oldAssistant.uuid),
      toTranscriptMessage(preservedAssistant, preservedUser.uuid),
      {
        type: 'content-replacement',
        sessionId: 'session-1',
        replacements: [
          {
            messageUuid: preservedAssistant.uuid,
            blockIndex: 0,
            originalType: 'tool_result',
            stubContent: 'preserved replacement',
          },
        ],
      },
      toTranscriptMessage(boundary, null, {
        logicalParentUuid: preservedAssistant.uuid,
      }),
      toTranscriptMessage(summary, boundary.uuid),
      toTranscriptMessage(postAssistant, summary.uuid),
    ];

    await fs.writeFile(
      filePath,
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    );

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);
    const chain = reader.buildConversationChain(result.messages);

    expect(result.messages.has(oldUser.uuid)).toBe(false);
    expect(result.messages.has(oldAssistant.uuid)).toBe(false);
    expect(result.messages.get(preservedUser.uuid)?.parentUuid).toBe(
      summary.uuid,
    );
    expect(result.messages.get(postAssistant.uuid)?.parentUuid).toBe(
      preservedAssistant.uuid,
    );
    expect(chain.map((message) => message.uuid)).toEqual([
      boundary.uuid,
      summary.uuid,
      preservedUser.uuid,
      preservedAssistant.uuid,
      postAssistant.uuid,
    ]);
    expect(result.contentReplacements.get('session-1')).toEqual([
      {
        messageUuid: preservedAssistant.uuid,
        blockIndex: 0,
        originalType: 'tool_result',
        stubContent: 'preserved replacement',
      },
    ]);
  });

  it('将 file-history-snapshot 更新折叠成最终快照链', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });

    const user = createUserMessage('hello');
    const assistant = makeAssistantMessage({ text: 'world' });
    const secondUser = createUserMessage('again');
    const secondAssistant = makeAssistantMessage({ text: 'done' });
    await writer.recordMessages([user, assistant, secondUser, secondAssistant]);
    await writer.recordFileHistorySnapshot({
      messageId: user.uuid,
      snapshot: {
        messageId: user.uuid,
        timestamp: new Date('2026-04-16T00:00:00.000Z'),
        trackedFileBackups: {},
      },
      isSnapshotUpdate: false,
    });
    await writer.recordFileHistorySnapshot({
      messageId: user.uuid,
      snapshot: {
        messageId: user.uuid,
        timestamp: new Date('2026-04-16T00:00:01.000Z'),
        trackedFileBackups: {
          'src/app.ts': {
            backupFileName: 'abcd@v1',
            version: 1,
            backupTime: new Date('2026-04-16T00:00:01.000Z'),
          },
        },
      },
      isSnapshotUpdate: true,
    });
    await writer.recordFileHistorySnapshot({
      messageId: secondUser.uuid,
      snapshot: {
        messageId: secondUser.uuid,
        timestamp: new Date('2026-04-16T00:00:02.000Z'),
        trackedFileBackups: {
          'src/app.ts': {
            backupFileName: 'abcd@v2',
            version: 2,
            backupTime: new Date('2026-04-16T00:00:02.000Z'),
          },
        },
      },
      isSnapshotUpdate: false,
    });
    await writer.flush();

    const fileHistoryEntries = (await fs.readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry['type'] === 'file-history-snapshot');
    expect(fileHistoryEntries[0]).toMatchObject({
      type: 'file-history-snapshot',
      messageId: user.uuid,
      isSnapshotUpdate: false,
      snapshot: { messageId: user.uuid },
    });
    expect(fileHistoryEntries[0]).not.toHaveProperty('promptId');
    expect(fileHistoryEntries[0]).not.toHaveProperty('sessionId');

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);

    expect(result.fileHistorySnapshots).toHaveLength(2);
    expect(result.fileHistorySnapshots[0]).toMatchObject({
      messageId: user.uuid,
      trackedFileBackups: {
        'src/app.ts': {
          backupFileName: 'abcd@v1',
          version: 1,
        },
      },
    });
    expect(result.fileHistorySnapshots[1]).toMatchObject({
      messageId: secondUser.uuid,
      trackedFileBackups: {
        'src/app.ts': {
          backupFileName: 'abcd@v2',
          version: 2,
        },
      },
    });
  });

  it('filters unresolved tool_use assistant messages', () => {
    const reader = new RepositoryCompatibilityHarness();

    const unresolvedAssistant = makeAssistantMessage({
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_unresolved',
          name: 'ReadFile',
          input: { file_path: 'a.ts' },
        },
      ],
    });
    const resolvedAssistant = makeAssistantMessage({
      stopReason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_resolved',
          name: 'ReadFile',
          input: { file_path: 'b.ts' },
        },
      ],
    });
    const resolvedToolResult = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_resolved',
          content: 'done',
          is_error: false,
        },
      ],
      resolvedAssistant.uuid,
    );
    const trailingUser = createUserMessage('next prompt');

    const filtered = reader.filterUnresolvedToolUses([
      unresolvedAssistant,
      resolvedAssistant,
      resolvedToolResult,
      trailingUser,
    ] as Message[]);

    expect(filtered.map((message) => message.uuid)).toEqual([
      resolvedAssistant.uuid,
      resolvedToolResult.uuid,
      trailingUser.uuid,
    ]);
  });

  it('preserves assistant text while removing unresolved tool_use blocks', () => {
    const reader = new RepositoryCompatibilityHarness();

    const mixedAssistant = makeAssistantMessage({
      stopReason: 'tool_use',
      content: [
        {
          type: 'text',
          text: 'Let me inspect the repository first.',
        },
        {
          type: 'tool_use',
          id: 'toolu_pending',
          name: 'ReadFile',
          input: { file_path: 'README.md' },
        },
      ],
    });

    const filtered = reader.filterUnresolvedToolUses([
      mixedAssistant,
    ] as Message[]);

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.type).toBe('assistant');
    expect(mixedAssistant.message.content).toHaveLength(2);
    if (filtered[0]?.type === 'assistant') {
      expect(filtered[0].message.content).toEqual([
        {
          type: 'text',
          text: 'Let me inspect the repository first.',
        },
      ]);
    }
  });

  it('recovers orphaned parallel tool results after chain reconstruction', async () => {
    const filePath = await createTempFile();
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      flushIntervalMs: 0,
    });

    const user = createUserMessage('parallel tools');
    const sharedMessageId = randomUUID();
    const assistantA = makeAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_a',
          name: 'ReadFile',
          input: { file_path: 'a.ts' },
        },
      ],
      stopReason: 'tool_use',
    });
    assistantA.message = { ...assistantA.message, id: sharedMessageId };

    const assistantB = makeAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_b',
          name: 'ReadFile',
          input: { file_path: 'b.ts' },
        },
      ],
      stopReason: 'tool_use',
    });
    assistantB.message = { ...assistantB.message, id: sharedMessageId };

    const toolResultB = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_b',
          content: 'done-b',
          is_error: false,
        },
      ],
      assistantB.uuid,
    );
    const toolResultA = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_a',
          content: 'done-a',
          is_error: false,
        },
      ],
      assistantA.uuid,
    );
    const nextUser = createUserMessage('next');

    await writer.recordMessages([
      user,
      assistantA,
      assistantB,
      toolResultB,
      toolResultA,
      nextUser,
    ]);
    await writer.flush();

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);
    const chain = reader.buildConversationChain(result.messages);

    expect(chain.map((message) => message.uuid)).toEqual([
      user.uuid,
      assistantA.uuid,
      assistantB.uuid,
      toolResultB.uuid,
      toolResultA.uuid,
      nextUser.uuid,
    ]);
  });

  it('normalizes legacy parentUuid links that point to message.id', async () => {
    const filePath = await createTempFile();
    const lines = [
      {
        uuid: 'legacy-user-uuid',
        parentUuid: '',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.33',
        type: 'user',
        timestamp: '2026-04-23T09:53:21.228Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hihi' }],
          id: 'legacy-user-message-id',
        },
        isMeta: false,
      },
      {
        uuid: 'legacy-assistant-uuid',
        parentUuid: 'legacy-user-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.33',
        type: 'assistant',
        timestamp: '2026-04-23T09:53:21.247Z',
        message: {
          role: 'assistant',
          id: 'legacy-assistant-message-id',
          content: [{ type: 'text', text: 'reply', citations: null }],
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        isMeta: false,
      },
    ];

    await fs.writeFile(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);
    const chain = reader.buildConversationChain(result.messages);

    expect(result.messages.get('legacy-assistant-uuid')?.parentUuid).toBe(
      'legacy-user-uuid',
    );
    expect(
      (result.messages.get('legacy-assistant-uuid') as AssistantMessage)
        .message,
    ).toHaveProperty('usage');
    expect(chain.map((message) => message.uuid)).toEqual([
      'legacy-user-uuid',
      'legacy-assistant-uuid',
    ]);
  });

  it('matches legacy shared message.id parents by tool_use_id', async () => {
    const filePath = await createTempFile();
    const lines = [
      {
        uuid: 'legacy-user-uuid',
        parentUuid: '',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.33',
        type: 'user',
        timestamp: '2026-04-23T09:53:21.228Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'parallel tools' }],
          id: 'legacy-user-message-id',
        },
        isMeta: false,
      },
      {
        uuid: 'legacy-assistant-a-uuid',
        parentUuid: 'legacy-user-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.33',
        type: 'assistant',
        timestamp: '2026-04-23T09:53:21.247Z',
        message: {
          role: 'assistant',
          id: 'legacy-shared-assistant-message-id',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_a',
              name: 'ReadFile',
              input: { file_path: 'a.ts' },
            },
          ],
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        isMeta: false,
      },
      {
        uuid: 'legacy-assistant-b-uuid',
        parentUuid: 'legacy-user-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.33',
        type: 'assistant',
        timestamp: '2026-04-23T09:53:21.248Z',
        message: {
          role: 'assistant',
          id: 'legacy-shared-assistant-message-id',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_b',
              name: 'ReadFile',
              input: { file_path: 'b.ts' },
            },
          ],
          usage: {
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        isMeta: false,
      },
      {
        uuid: 'legacy-tool-result-a-uuid',
        parentUuid: 'legacy-shared-assistant-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.33',
        type: 'user',
        timestamp: '2026-04-23T09:53:21.249Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_a',
              content: 'done-a',
              is_error: false,
            },
          ],
        },
        isMeta: false,
      },
      {
        uuid: 'legacy-tool-result-b-uuid',
        parentUuid: 'legacy-shared-assistant-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.33',
        type: 'user',
        timestamp: '2026-04-23T09:53:21.250Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_b',
              content: 'done-b',
              is_error: false,
            },
          ],
        },
        isMeta: false,
      },
    ];

    await fs.writeFile(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);

    expect(result.messages.get('legacy-tool-result-a-uuid')?.parentUuid).toBe(
      'legacy-assistant-a-uuid',
    );
    expect(result.messages.get('legacy-tool-result-b-uuid')?.parentUuid).toBe(
      'legacy-assistant-b-uuid',
    );
  });

  it('rebuilds Go transcript chains split across shared message ids', async () => {
    const filePath = await createTempFile();
    const lines = [
      {
        uuid: 'user-uuid',
        parentUuid: '',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.44',
        type: 'user',
        timestamp: '2026-04-25T09:32:33.058Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'inspect project' }],
          id: 'user-message-id',
        },
        isMeta: false,
      },
      {
        uuid: 'tool-use-a-uuid',
        parentUuid: 'user-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.44',
        type: 'assistant',
        timestamp: '2026-04-25T09:32:34.000Z',
        message: {
          role: 'assistant',
          id: 'assistant-tools-message-id',
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
          ],
        },
        isMeta: false,
      },
      {
        uuid: 'tool-use-b-uuid',
        parentUuid: 'user-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.44',
        type: 'assistant',
        timestamp: '2026-04-25T09:32:34.000Z',
        message: {
          role: 'assistant',
          id: 'assistant-tools-message-id',
          content: [
            { type: 'tool_use', id: 'toolu_b', name: 'Read', input: {} },
          ],
        },
        isMeta: false,
      },
      {
        uuid: 'tool-result-a-uuid',
        parentUuid: 'assistant-tools-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.44',
        type: 'user',
        timestamp: '2026-04-25T09:32:35.000Z',
        message: {
          role: 'user',
          id: 'tool-results-message-id',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_a',
              content: 'done-a',
              is_error: false,
            },
          ],
        },
        isMeta: false,
      },
      {
        uuid: 'tool-result-b-uuid',
        parentUuid: 'assistant-tools-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.44',
        type: 'user',
        timestamp: '2026-04-25T09:32:35.000Z',
        message: {
          role: 'user',
          id: 'tool-results-message-id',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_b',
              content: 'done-b',
              is_error: false,
            },
          ],
        },
        isMeta: false,
      },
      {
        uuid: 'thinking-uuid',
        parentUuid: 'tool-results-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.44',
        type: 'assistant',
        timestamp: '2026-04-25T09:32:36.000Z',
        message: {
          role: 'assistant',
          id: 'assistant-final-message-id',
          content: [{ type: 'thinking', thinking: 'thinking first' }],
        },
        isMeta: false,
      },
      {
        uuid: 'text-uuid',
        parentUuid: 'tool-results-message-id',
        isSidechain: false,
        userType: 'external',
        cwd: '/workspace/project',
        sessionId: 'session-1',
        version: 'v0.1.44',
        type: 'assistant',
        timestamp: '2026-04-25T09:32:36.000Z',
        message: {
          role: 'assistant',
          id: 'assistant-final-message-id',
          content: [{ type: 'text', text: 'final answer' }],
        },
        isMeta: false,
      },
      {
        type: 'user',
        uuid: 'local-command-uuid',
        timestamp: '2026-04-25T09:32:37.000Z',
        message: { role: 'user', content: 'local command' },
        isMeta: true,
        parentUuid: 'thinking-uuid',
        isSidechain: false,
        cwd: '/workspace/project',
        sessionId: 'session-1',
        userType: 'external',
        entrypoint: 'cli',
        version: '0.2.0',
      },
    ];

    await fs.writeFile(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
      'utf8',
    );

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);
    const chain = reader.buildConversationChain(result.messages);

    expect(result.messages.get('thinking-uuid')?.parentUuid).toBe(
      'tool-result-b-uuid',
    );
    expect(chain.map((message) => message.uuid)).toEqual([
      'user-uuid',
      'tool-use-a-uuid',
      'tool-use-b-uuid',
      'tool-result-a-uuid',
      'tool-result-b-uuid',
      'thinking-uuid',
      'text-uuid',
      'local-command-uuid',
    ]);
  });

  it('returns empty state for missing transcript files', async () => {
    const reader = new RepositoryCompatibilityHarness();
    const filePath = path.join(await createTempFile(), '..', 'missing.jsonl');

    const result = await reader.readTranscriptForLoad(filePath);

    expect(result.entries).toEqual([]);
    expect(result.messages.size).toBe(0);
    expect(result.leafUuids.size).toBe(0);
  });

  it('loads a final JSONL entry without a trailing newline', async () => {
    const filePath = await createTempFile();
    const user = createUserMessage('hello');
    await fs.writeFile(filePath, JSON.stringify(user), 'utf8');

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);

    expect(result.entries).toHaveLength(1);
    expect(result.messages.get(user.uuid)).toMatchObject({
      type: 'user',
      uuid: user.uuid,
    });
  });

  it('loads JSONL entries larger than 2 MiB and continues after malformed lines', async () => {
    const filePath = await createTempFile();
    const user = createUserMessage('after large line');
    const oversizedLine = JSON.stringify({
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: 'x'.repeat(2 * 1024 * 1024 + 1),
      },
    });

    await fs.writeFile(
      filePath,
      `${oversizedLine}\nnot json\n${JSON.stringify(user)}\n`,
      'utf8',
    );

    const reader = new RepositoryCompatibilityHarness();
    const result = await reader.readTranscriptForLoad(filePath);

    expect(result.entries).toHaveLength(2);
    expect(result.messages.size).toBe(2);
    expect(result.messages.get(user.uuid)).toMatchObject({
      type: 'user',
      uuid: user.uuid,
    });
  });
});
