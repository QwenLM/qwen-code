/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SkillListingAttachment } from '../attachments/models/skill-attachments.js';
import { HookOutputAttachment } from '../attachments/models/hook-attachments.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessage,
  createUserMessage,
  cloneUsage,
  normalizeMessagesForAPI,
  type Message,
  type SystemMessage,
} from '../protocol/index.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { HookEventName } from '../hooks/types.js';
import { createTestTranscriptWriter } from './transcript/testing/fixtures.js';
import {
  ForkSessionError,
  ForkSessionService,
} from './fork-session-service.js';
import { getSessionTranscriptPath } from './transcript-paths.js';
import { SessionStateStore } from './session-state-store.js';
import { Storage } from '../config/storage.js';
import { TranscriptStore } from './transcript/store.js';
import { TranscriptRepository } from './transcript/repository.js';
import {
  SessionTranscriptWriter,
  projectMessagesForTranscript,
} from './transcript/session-writer.js';
import type { SessionWriterStateSource } from './transcript/store.js';

import { beginResumeRead } from './transcript/resume-read-budget.js';

const tempDirs: string[] = [];
const SOURCE_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const FORK_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const EXISTING_TARGET_ID = '44444444-4444-4444-8444-444444444444';

interface TranscriptEntryWithUuid extends Record<string, unknown> {
  uuid: string;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function hasUuid(
  entry: Record<string, unknown>,
): entry is TranscriptEntryWithUuid {
  return isString(entry['uuid']);
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createProjectRoot() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-session-'));
  tempDirs.push(projectRoot);
  return projectRoot;
}

async function createSourceSession(
  projectRoot: string,
  configHomeDir = path.join(projectRoot, '.config'),
  attachments: readonly Message[] = [],
) {
  const sessionId = SOURCE_SESSION_ID;
  const filePath = getSessionTranscriptPath(
    projectRoot,
    sessionId,
    configHomeDir,
  );
  const { writer } = await createTestTranscriptWriter({
    filePath,
    sessionId,
    cwd: projectRoot,
    entrypoint: 'cli',
    version: '1.0.0',
    flushIntervalMs: 0,
  });

  const user = createUserMessage('hello');
  const usage = cloneUsage();
  usage.input_tokens = 1;
  usage.output_tokens = 1;
  const assistant = createAssistantMessage(
    {
      messageId: 'assistant-1',

      model: 'test-model',
      stopReason: 'end_turn',

      usage: {
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
      },
      blocks: [{ type: 'text', text: 'world' }],
    },
    undefined,
    undefined,
    usage,
  );

  await writer.recordMessages([user, ...attachments, assistant]);
  await writer.recordContentReplacement([
    {
      messageUuid: assistant.uuid,
      blockIndex: 0,
      originalType: 'tool_result',
      stubContent: '[stub]',
    },
  ]);
  await writer.recordRuntimeConfig({
    model: 'test-model',
    reasoningEffort: 'high',
    contextWindow: 256000,
  });
  await writer.close();
  await new SessionStateStore({
    projectRoot,
    sessionId,
    configHomeDir,
  }).setWorkspaceDirectories([projectRoot]);

  return { sessionId, user, assistant };
}

describe('ForkSessionService', () => {
  it('forks Compact ancestors from historical lineage without expanding post-Compact runtime', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const sourcePath = getSessionTranscriptPath(
        projectRoot,
        SOURCE_SESSION_ID,
        configHome,
      );
      const { writer } = await createTestTranscriptWriter({
        filePath: sourcePath,
        sessionId: SOURCE_SESSION_ID,
        cwd: projectRoot,
        entrypoint: 'cli',
        version: '1.0.0',
        flushIntervalMs: 0,
      });
      const oldUser = createUserMessage('old user');
      const oldAssistant = createAssistantMessage({
        messageId: 'old-assistant',

        model: 'test-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'old reply' }],
      });
      await writer.recordMessages([oldUser, oldAssistant]);

      const boundary: SystemMessage = {
        type: 'system',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isCompactSummary: true,
      };
      const summary = createUserMessage('summary');
      summary.isCompactSummary = true;
      const postAssistant = createAssistantMessage({
        messageId: 'post-assistant',

        model: 'test-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'post reply' }],
      });
      await writer.recordMessages([boundary, summary, postAssistant]);
      await writer.close();

      const service = new ForkSessionService(new TranscriptStore());
      const beforeCompact = await service.createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
        resumeSessionAt: oldAssistant.uuid,
      });
      const afterCompact = await service.createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: SECOND_SESSION_ID,
        resumeSessionAt: postAssistant.uuid,
      });

      expect(beforeCompact.messages.map((message) => message.uuid)).toEqual([
        oldUser.uuid,
        oldAssistant.uuid,
      ]);
      expect(afterCompact.messages.map((message) => message.uuid)).toEqual([
        boundary.uuid,
        summary.uuid,
        postAssistant.uuid,
      ]);
      const afterCompactEntries = (
        await fs.readFile(afterCompact.sessionPath, 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        afterCompactEntries.filter(hasUuid).map((entry) => entry['uuid']),
      ).toEqual([
        oldUser.uuid,
        oldAssistant.uuid,
        boundary.uuid,
        summary.uuid,
        postAssistant.uuid,
      ]);
    } finally {
      storageSpy.mockRestore();
    }
  });

  it.each(['persisted', 'runtime'] as const)(
    'restarts a %s Compact fork whose lineage metadata crosses the 64 MiB resume cap',
    async (sourceMode) => {
      const projectRoot = await createProjectRoot();
      const configHome = path.join(projectRoot, '.config');
      const storageSpy = vi
        .spyOn(Storage, 'getGlobalConfigDir')
        .mockReturnValue(configHome);
      const store = new TranscriptStore();
      try {
        const sourcePath = getSessionTranscriptPath(
          projectRoot,
          SOURCE_SESSION_ID,
        );
        const boundary: SystemMessage = {
          type: 'system',
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
          subtype: 'compact_boundary',
          content: 'Conversation compacted',
          level: 'info',
          isCompactSummary: true,
        };
        const summary = createUserMessage('summary');
        summary.isCompactSummary = true;
        const tail = createUserMessage('continue after compaction');
        const history = Array.from({ length: 64 }, () =>
          createUserMessage('x'.repeat(1024 ** 2 - 2048)),
        );
        const projection = projectMessagesForTranscript(
          [
            { ...boundary, uuid: randomUUID() },
            ...history,
            boundary,
            summary,
            tail,
          ],
          { sessionId: SOURCE_SESSION_ID, cwd: projectRoot, entrypoint: 'cli' },
        );
        const lines = projection.messages.map((entry) => JSON.stringify(entry));
        lines.push(
          JSON.stringify({
            type: 'active-leaf',
            sessionId: SOURCE_SESSION_ID,
            leafUuid: tail.uuid,
            compactBoundaryUuid: boundary.uuid,
            explicit: false,
            timestamp: 1,
          }),
        );
        // forkedFrom pushes this source over the former cap. Each line stays ~1 MiB.
        const sourceSize = 64 * 1024 ** 2 - 4096;
        const padding =
          sourceSize -
          lines.reduce((bytes, line) => bytes + Buffer.byteLength(line) + 1, 0);
        expect(padding).toBeGreaterThan(0);
        lines[1] = lines[1].replace('xxx', 'xxx' + 'x'.repeat(padding));
        expect(
          Math.max(...lines.map((line) => Buffer.byteLength(line))),
        ).toBeLessThan(8 * 1024 ** 2);
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(sourcePath, lines.join('\n') + '\n');
        expect((await fs.stat(sourcePath)).size).toBe(sourceSize);
        const fork = await new ForkSessionService(store).createFork({
          projectRoot,
          sourceSessionId: SOURCE_SESSION_ID,
          targetSessionId: FORK_SESSION_ID,
          ...(sourceMode === 'runtime'
            ? {
                runtimeSnapshot: {
                  transcriptChain: lines
                    .slice(0, -1)
                    .map(
                      (line) =>
                        JSON.parse(
                          line,
                        ) as (typeof projection.messages)[number],
                    ),
                },
              }
            : {}),
        });
        expect((await fs.stat(fork.sessionPath)).size).toBeGreaterThan(
          64 * 1024 ** 2,
        );
        await store.close();
        const attempt = await beginResumeRead();
        try {
          const restarted = await new TranscriptRepository().readForResume(
            fork.sessionPath,
            { sessionId: FORK_SESSION_ID, attempt },
          );
          expect(restarted?.messages.map((message) => message.uuid)).toEqual([
            boundary.uuid,
            summary.uuid,
            tail.uuid,
          ]);
          expect(restarted?.writerState.messageUuids).toContain(
            history[0].uuid,
          );
        } finally {
          attempt.finish();
        }
      } finally {
        await store.close();
        storageSpy.mockRestore();
      }
    },
  );

  it('preserves the provider prefix of model-visible attachments', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
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
      const source = await createSourceSession(projectRoot, configHome, [
        skills,
        hook,
      ]);
      const sourceMessages = [source.user, skills, hook, source.assistant];

      const result = await new ForkSessionService(
        new TranscriptStore(),
      ).createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
        targetTitle: 'Attachment branch',
      });

      expect(result.messages.map((message) => message.uuid)).toEqual(
        sourceMessages.map((message) => message.uuid),
      );
      expect(normalizeMessagesForAPI(result.messages)).toEqual(
        normalizeMessagesForAPI(sourceMessages),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('creates a forked transcript with fork lineage and copied metadata', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId, assistant } =
        await createSourceSession(projectRoot);
      const service = new ForkSessionService(new TranscriptStore());

      const result = await service.createFork({
        projectRoot,
        sourceSessionId,
        targetSessionId: FORK_SESSION_ID,
        targetTitle: 'Example (Branch)',
      });

      expect(result.sessionId).toBe(FORK_SESSION_ID);
      expect(result.runtimeConfig).toMatchObject({
        model: 'test-model',
        reasoningEffort: 'high',
        contextWindow: 256000,
      });
      expect(result.forkedFrom).toEqual({
        sessionId: sourceSessionId,
        messageUuid: assistant.uuid,
      });

      const forkContent = await fs.readFile(result.sessionPath, 'utf8');
      const entries = forkContent
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(entries[0]).toMatchObject({
        type: 'user',
        sessionId: FORK_SESSION_ID,
        parentUuid: null,
        isSidechain: false,
        forkedFrom: {
          sessionId: sourceSessionId,
        },
      });
      expect(entries[1]).toMatchObject({
        type: 'assistant',
        sessionId: FORK_SESSION_ID,
        parentUuid: entries[0]?.['uuid'],
        isSidechain: false,
        forkedFrom: {
          sessionId: sourceSessionId,
          messageUuid: assistant.uuid,
        },
      });
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'custom-title',
          sessionId: FORK_SESSION_ID,
          customTitle: 'Example (Branch)',
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'content-replacement',
          sessionId: FORK_SESSION_ID,
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'runtime-config',
          sessionId: FORK_SESSION_ID,
          model: 'test-model',
          reasoningEffort: 'high',
          contextWindow: 256000,
        }),
      );
      expect(entries).toContainEqual({
        type: 'relocated',
        sessionId: FORK_SESSION_ID,
        relocatedCwd: projectRoot,
      });
      expect(entries).toContainEqual({
        type: 'worktree-state',
        sessionId: FORK_SESSION_ID,
        worktreeSession: null,
      });
      expect(entries).not.toContainEqual(
        expect.objectContaining({
          type: 'workspace-directories',
        }),
      );

      const repository = new TranscriptRepository();
      const targetProjection = await repository.resolveSession(
        result.sessionPath,
        { sessionId: FORK_SESSION_ID },
      );
      expect(targetProjection).not.toBeNull();
      const freshResumeState = repository.createResumeReadState(
        targetProjection!,
        FORK_SESSION_ID,
      );
      expect(result.resumeState.writerState).toEqual(
        freshResumeState.writerState,
      );
      expect(result.resumeState.snapshot).toEqual(freshResumeState.snapshot);

      await expect(
        new SessionStateStore({
          projectRoot,
          sessionId: FORK_SESSION_ID,
          configHomeDir: configHome,
        }).getWorkspaceDirectories(),
      ).resolves.toEqual([projectRoot]);
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('forks at a historical message, preserves checkpoints, and filters replacements', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const sourcePath = getSessionTranscriptPath(
        projectRoot,
        SOURCE_SESSION_ID,
        configHome,
      );
      const { writer } = await createTestTranscriptWriter({
        filePath: sourcePath,
        sessionId: SOURCE_SESSION_ID,
        cwd: projectRoot,
        entrypoint: 'cli',
        version: '1.0.0',
        flushIntervalMs: 0,
      });
      const firstUser = createUserMessage('first');
      const firstAssistant = createAssistantMessage({
        messageId: 'assistant-first',

        model: 'test-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'first reply' }],
      });
      const secondUser = createUserMessage('second');
      const secondAssistant = createAssistantMessage({
        messageId: 'assistant-second',

        model: 'test-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'second reply' }],
      });
      await writer.recordMessages([
        firstUser,
        firstAssistant,
        secondUser,
        secondAssistant,
      ]);
      for (const message of [firstUser, secondUser]) {
        await writer.recordFileHistorySnapshot({
          messageId: message.uuid,
          snapshot: {
            messageId: message.uuid,
            timestamp: new Date('2026-08-12T00:00:00.000Z'),
            trackedFileBackups: {},
          },
          isSnapshotUpdate: false,
        });
      }
      await writer.recordContentReplacement([
        {
          messageUuid: firstAssistant.uuid,
          blockIndex: 0,
          originalType: 'tool_result',
          stubContent: '[first stub]',
        },
        {
          messageUuid: secondAssistant.uuid,
          blockIndex: 0,
          originalType: 'tool_result',
          stubContent: '[second stub]',
        },
      ]);
      await writer.close();

      const result = await new ForkSessionService(
        new TranscriptStore(),
      ).createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
        resumeSessionAt: firstAssistant.uuid,
        resumeDropsTurn: secondUser.uuid,
      });

      expect(result.messages.map((message) => message.uuid)).toEqual([
        firstUser.uuid,
        firstAssistant.uuid,
      ]);
      expect(
        result.fileHistorySnapshots.map((snapshot) => snapshot.messageId),
      ).toEqual([firstUser.uuid]);
      expect(result.forkedFrom).toEqual({
        sessionId: SOURCE_SESSION_ID,
        messageUuid: firstAssistant.uuid,
      });

      const entries = (await fs.readFile(result.sessionPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        entries
          .filter(
            (entry) =>
              entry['type'] === 'user' || entry['type'] === 'assistant',
          )
          .map((entry) => entry['uuid']),
      ).toEqual([firstUser.uuid, firstAssistant.uuid]);
      const snapshotEntries = entries.filter(
        (entry) => entry['type'] === 'file-history-snapshot',
      );
      expect(snapshotEntries.map((entry) => entry['messageId'])).toEqual([
        firstUser.uuid,
      ]);
      expect(snapshotEntries[0]).toMatchObject({
        type: 'file-history-snapshot',
        messageId: firstUser.uuid,
        isSnapshotUpdate: false,
      });
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'content-replacement',
          replacements: [
            expect.objectContaining({ messageUuid: firstAssistant.uuid }),
          ],
        }),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('copies checkpoint backups into the fork before writing its transcript', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const filePath = getSessionTranscriptPath(
        projectRoot,
        SOURCE_SESSION_ID,
        configHome,
      );
      const { writer } = await createTestTranscriptWriter({
        filePath,
        sessionId: SOURCE_SESSION_ID,
        cwd: projectRoot,
        entrypoint: 'cli',
        version: '1.0.0',
        flushIntervalMs: 0,
      });
      const user = createUserMessage('hello');
      await writer.recordMessages([user]);

      const backupFileName = 'checkpoint-backup';
      const sourceBackupDir = path.join(
        configHome,
        'file-history',
        SOURCE_SESSION_ID,
      );
      await fs.mkdir(sourceBackupDir, { recursive: true });
      await fs.writeFile(path.join(sourceBackupDir, backupFileName), 'before');
      await writer.recordFileHistorySnapshot({
        messageId: user.uuid,
        snapshot: {
          messageId: user.uuid,
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
          trackedFileBackups: {
            'src/file.ts': {
              backupFileName,
              version: 1,
              backupTime: new Date('2026-08-12T00:00:00.000Z'),
            },
          },
        },
        isSnapshotUpdate: false,
      });
      await writer.close();

      const result = await new ForkSessionService(
        new TranscriptStore(),
      ).createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
      });

      await expect(
        fs.readFile(
          path.join(
            configHome,
            'file-history',
            FORK_SESSION_ID,
            backupFileName,
          ),
          'utf8',
        ),
      ).resolves.toBe('before');
      expect(result.fileHistorySnapshots).toHaveLength(1);
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('continues the fork when a checkpoint backup is missing', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const filePath = getSessionTranscriptPath(
        projectRoot,
        SOURCE_SESSION_ID,
        configHome,
      );
      const { writer } = await createTestTranscriptWriter({
        filePath,
        sessionId: SOURCE_SESSION_ID,
        cwd: projectRoot,
        entrypoint: 'cli',
        version: '1.0.0',
        flushIntervalMs: 0,
      });
      const user = createUserMessage('hello');
      await writer.recordMessages([user]);
      await writer.recordFileHistorySnapshot({
        messageId: user.uuid,
        snapshot: {
          messageId: user.uuid,
          timestamp: new Date('2026-08-12T00:00:00.000Z'),
          trackedFileBackups: {
            'src/file.ts': {
              // 源 blob 已丢失（跨 config root 的旧会话）；fork 仍应成立。
              backupFileName: 'missing-backup',
              version: 1,
              backupTime: new Date('2026-08-12T00:00:00.000Z'),
            },
          },
        },
        isSnapshotUpdate: false,
      });
      await writer.close();

      const result = await new ForkSessionService(
        new TranscriptStore(),
      ).createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
      });

      expect(result.fileHistorySnapshots).toHaveLength(1);
      const entries = (await fs.readFile(result.sessionPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(
        entries.filter((entry) => entry['type'] === 'file-history-snapshot'),
      ).toHaveLength(1);
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('forks an active conversation from its runtime snapshot without reading the source transcript', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const user = createUserMessage('live conversation');
      const assistant = createAssistantMessage({
        messageId: 'assistant-live',

        model: 'live-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'live reply' }],
      });
      const repository = {
        readForFork: vi.fn().mockRejectedValue(
          Object.assign(new Error('EPERM: source transcript is not readable'), {
            code: 'EPERM',
          }),
        ),
      } as unknown as TranscriptRepository;
      const service = new ForkSessionService(
        new TranscriptStore({ repository }),
      );

      const result = await service.createFork({
        projectRoot,
        // 源与目标可以不在同一个 project bucket；runtimeSnapshot 的会话信息必须
        // 按 sourceProjectRoot 投影，而不是误用目标的 projectRoot。
        sourceProjectRoot: '/source-root',
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
        runtimeSnapshot: {
          transcriptChain: projectMessagesForTranscript([user, assistant], {
            sessionId: SOURCE_SESSION_ID,
            cwd: projectRoot,
            userType: 'external',
            version: '1.2.3',
            entrypoint: 'cli',
            preserveTimestamps: true,
          }).messages,
          directories: [projectRoot],
          runtimeConfig: {
            type: 'runtime-config',
            sessionId: SOURCE_SESSION_ID,
            timestamp: Date.now(),
            model: 'live-model',
            reasoningEffort: 'high',
            contextWindow: 200_000,
          },
        },
      });

      expect(repository.readForFork).not.toHaveBeenCalled();
      expect(result.sourceSessionInfo.transcriptProjectRoot).toBe(
        '/source-root',
      );
      await expect(
        fs.stat(
          getSessionTranscriptPath(projectRoot, SOURCE_SESSION_ID, configHome),
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const entries = (await fs.readFile(result.sessionPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries.slice(0, 2)).toEqual([
        expect.objectContaining({
          type: 'user',
          sessionId: FORK_SESSION_ID,
          cwd: projectRoot,
          userType: 'external',
          version: '1.2.3',
          entrypoint: 'cli',
          parentUuid: null,
        }),
        expect.objectContaining({
          type: 'assistant',
          sessionId: FORK_SESSION_ID,
          parentUuid: user.uuid,
        }),
      ]);
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'runtime-config',
          sessionId: FORK_SESSION_ID,
          model: 'live-model',
        }),
      );
      expect(result.messages).toHaveLength(2);
      expect(result.fileHistorySnapshots).toEqual([]);
      expect(result.directories).toEqual([projectRoot]);
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('stores a worktree fork in the artifact bucket while preserving its runtime checkout', async () => {
    const projectRoot = await createProjectRoot();
    const worktreeCwd = path.join(
      projectRoot,
      '.qwen',
      'worktrees',
      'feature',
    );
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId } = await createSourceSession(
        projectRoot,
        configHome,
      );
      const result = await new ForkSessionService(
        new TranscriptStore(),
      ).createFork({
        projectRoot,
        targetCwd: worktreeCwd,
        sourceSessionId,
        targetSessionId: FORK_SESSION_ID,
        targetWorktreeSession: {
          originalCwd: projectRoot,
          preEnterOriginalCwd: projectRoot,
          worktreePath: worktreeCwd,
          worktreeCwd,
          worktreeName: 'feature',
          worktreeBranch: 'feature',
          originalBranch: 'main',
          sessionId: FORK_SESSION_ID,
          lifecycle: 'attached',
        },
      });

      expect(result.sessionPath).toBe(
        getSessionTranscriptPath(projectRoot, FORK_SESSION_ID, configHome),
      );
      const entries = (await fs.readFile(result.sessionPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'relocated',
          relocatedCwd: worktreeCwd,
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'worktree-state',
          worktreeSession: expect.objectContaining({
            lifecycle: 'attached',
            worktreeCwd,
          }),
        }),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('captures the active writer state without reopening its transcript and copies live metadata', async () => {
    const projectRoot = await createProjectRoot();
    const worktreeCwd = path.join(
      projectRoot,
      '.qwen',
      'worktrees',
      'feature',
    );
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);
    const repository = {
      readForFork: vi.fn().mockRejectedValue(
        Object.assign(new Error('EPERM: source transcript is not readable'), {
          code: 'EPERM',
        }),
      ),
    } as unknown as TranscriptRepository;
    const stateSource: SessionWriterStateSource = {
      loadSessionWriterState: vi.fn().mockResolvedValue({
        messageUuids: [],
        mode: 'coordinator',
      }),
    };
    const store = new TranscriptStore({
      repository,
      stateSource,
      coordinatorOptions: { flushIntervalMs: 0 },
    });

    try {
      const sourcePath = getSessionTranscriptPath(
        projectRoot,
        SOURCE_SESSION_ID,
        configHome,
      );
      const activeWriter = await store.acquireSessionWriter({
        filePath: sourcePath,
        sessionId: SOURCE_SESSION_ID,
        cwd: projectRoot,
        entrypoint: 'cli',
        version: '1.2.3',
        initialWorkspaceDirectories: [projectRoot],
      });
      const user = createUserMessage('live conversation');
      const assistant = createAssistantMessage({
        messageId: 'assistant-live',

        model: 'live-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'live reply' }],
      });
      await activeWriter.recordMessages([user, assistant]);
      await activeWriter.recordCustomTitle('Renamed conversation');
      await activeWriter.recordTag('active-tag');
      await activeWriter.recordRuntimeConfig({
        model: 'live-model',
        reasoningEffort: 'high',
        contextWindow: 200_000,
      });
      await activeWriter.recordContentReplacement([
        {
          messageUuid: assistant.uuid,
          blockIndex: 0,
          originalType: 'tool_result',
          stubContent: '[stub]',
        },
      ]);

      const service = new ForkSessionService(store);
      const runtimeSnapshot = await service.captureActiveSessionSnapshot({
        projectRoot: worktreeCwd,
        sourceSessionId: SOURCE_SESSION_ID,
        sourceSessionPath: sourcePath,
        messages: [user, assistant],
        directories: [projectRoot],
        fileHistorySnapshots: [],
      });
      const result = await service.createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
        targetTitle: 'Renamed conversation (Branch)',
        runtimeSnapshot,
      });

      expect(repository.readForFork).not.toHaveBeenCalled();
      expect(stateSource.loadSessionWriterState).toHaveBeenCalledTimes(1);
      expect(runtimeSnapshot).toMatchObject({
        customTitle: 'Renamed conversation',
        tag: 'active-tag',
        mode: 'coordinator',
        runtimeConfig: {
          model: 'live-model',
          reasoningEffort: 'high',
          contextWindow: 200_000,
        },
        contentReplacements: [
          {
            messageUuid: assistant.uuid,
            stubContent: '[stub]',
          },
        ],
      });
      const entries = (await fs.readFile(result.sessionPath, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'mode',
          sessionId: FORK_SESSION_ID,
          mode: 'coordinator',
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'tag',
          sessionId: FORK_SESSION_ID,
          tag: 'active-tag',
        }),
      );
      expect(entries).toContainEqual(
        expect.objectContaining({
          type: 'content-replacement',
          sessionId: FORK_SESSION_ID,
        }),
      );
      expect(result.sourceSessionInfo).toMatchObject({
        id: SOURCE_SESSION_ID,
        displayName: 'Renamed conversation',
        isCurrentSession: true,
      });
      await activeWriter.close();
    } finally {
      await store.close();
      storageSpy.mockRestore();
    }
  });

  it('captures pre-Compact lineage from an active writer for a historical fork', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });

    try {
      const sourcePath = getSessionTranscriptPath(
        projectRoot,
        SOURCE_SESSION_ID,
        configHome,
      );
      const activeWriter = await store.acquireSessionWriter({
        filePath: sourcePath,
        sessionId: SOURCE_SESSION_ID,
        cwd: projectRoot,
        entrypoint: 'cli',
        version: '1.2.3',
      });
      const oldUser = createUserMessage('old user');
      const oldAssistant = createAssistantMessage({
        messageId: 'old-assistant',

        model: 'test-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'old reply' }],
      });
      await activeWriter.recordMessages([oldUser, oldAssistant]);

      const boundary: SystemMessage = {
        type: 'system',
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        subtype: 'compact_boundary',
        content: 'Conversation compacted',
        level: 'info',
        isCompactSummary: true,
      };
      const summary = createUserMessage('summary');
      summary.isCompactSummary = true;
      const postAssistant = createAssistantMessage({
        messageId: 'post-assistant',

        model: 'test-model',
        stopReason: 'end_turn',

        usage: ((value) => ({
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          cacheReadInputTokens: value.cache_read_input_tokens,
          cacheCreationInputTokens: value.cache_creation_input_tokens,
        }))(cloneUsage()),
        blocks: [{ type: 'text', text: 'post reply' }],
      });
      await activeWriter.recordMessages([boundary, summary, postAssistant]);

      const service = new ForkSessionService(store);
      const runtimeSnapshot = await service.captureActiveSessionSnapshot({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        messages: [boundary, summary, postAssistant],
      });
      const result = await service.createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        targetSessionId: FORK_SESSION_ID,
        resumeSessionAt: oldAssistant.uuid,
        runtimeSnapshot,
      });

      expect(
        runtimeSnapshot.transcriptChain.map((message) => message.uuid),
      ).toEqual([
        oldUser.uuid,
        oldAssistant.uuid,
        boundary.uuid,
        summary.uuid,
        postAssistant.uuid,
      ]);
      expect(result.messages.map((message) => message.uuid)).toEqual([
        oldUser.uuid,
        oldAssistant.uuid,
      ]);
      await activeWriter.close();
    } finally {
      await store.close();
      storageSpy.mockRestore();
    }
  });

  it('active branch captures history above 64 MiB without whole-file allocation and releases admission', async () => {
    const projectRoot = await createProjectRoot();
    const sourcePath = path.join(projectRoot, 'source.jsonl');
    const store = new TranscriptStore();
    const writer = await store.acquireSessionWriter({
      filePath: sourcePath,
      sessionId: SOURCE_SESSION_ID,
      cwd: projectRoot,
      entrypoint: 'test',
    });
    const users = Array.from({ length: 65 }, () =>
      createUserMessage('x'.repeat(1024 ** 2)),
    );
    for (const user of users)
      await writer.recordMessages([user], undefined, { immediate: true });
    expect((await fs.stat(sourcePath)).size).toBeGreaterThan(64 * 1024 ** 2);
    const wholeFile = vi
      .spyOn(SessionTranscriptWriter.prototype, 'readTranscriptSnapshot')
      .mockRejectedValue(new Error('whole-file read is forbidden'));
    try {
      const snapshot = await new ForkSessionService(
        store,
      ).captureActiveSessionSnapshot({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        sourceSessionPath: sourcePath,
        messages: users,
      });
      expect(snapshot.transcriptChain.map((message) => message.uuid)).toEqual(
        users.map((message) => message.uuid),
      );
      expect(wholeFile).not.toHaveBeenCalled();
      const next = await beginResumeRead({ limits: { timeoutMs: 1000 } });
      next.finish();
      const retained = await store.acquireExistingSessionWriter({
        filePath: sourcePath,
        sessionId: SOURCE_SESSION_ID,
      });
      expect(retained).toBeDefined();
      await retained?.close();
    } finally {
      wholeFile.mockRestore();
      await writer.close();
      await store.close();
    }
  });

  it('rejects active snapshot capture when no live writer owns the transcript', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);
    const stateSource: SessionWriterStateSource = {
      loadSessionWriterState: vi.fn().mockRejectedValue(
        Object.assign(new Error('EPERM: source transcript is not readable'), {
          code: 'EPERM',
        }),
      ),
    };
    const store = new TranscriptStore({ stateSource });

    try {
      await expect(
        new ForkSessionService(store).captureActiveSessionSnapshot({
          projectRoot,
          sourceSessionId: SOURCE_SESSION_ID,
          messages: [createUserMessage('unowned conversation')],
        }),
      ).rejects.toThrow(
        `Active transcript writer for session "${SOURCE_SESSION_ID}" is unavailable.`,
      );
      expect(stateSource.loadSessionWriterState).not.toHaveBeenCalled();
    } finally {
      await store.close();
      storageSpy.mockRestore();
    }
  });

  it('surfaces a source transcript read failure instead of reporting that the session does not exist', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);
    const readError = Object.assign(
      new Error('EPERM: operation not permitted, open source.jsonl'),
      { code: 'EPERM' },
    );
    const repository = {
      readForFork: vi.fn().mockRejectedValue(readError),
    } as unknown as TranscriptRepository;

    try {
      const service = new ForkSessionService(
        new TranscriptStore({ repository }),
      );

      await expect(
        service.createFork({
          projectRoot,
          sourceSessionId: SOURCE_SESSION_ID,
          targetSessionId: FORK_SESSION_ID,
        }),
      ).rejects.toBe(readError);
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('rejects unsafe or mismatched historical source locations before reading', async () => {
    const projectRoot = await createProjectRoot();
    const repository = {
      readForFork: vi.fn(),
    } as unknown as TranscriptRepository;
    const service = new ForkSessionService(new TranscriptStore({ repository }));

    await expect(
      service.createFork({
        projectRoot,
        sourceSessionId: '../outside',
        targetSessionId: FORK_SESSION_ID,
      }),
    ).rejects.toThrow('Source session "../outside" is invalid.');
    await expect(
      service.createFork({
        projectRoot,
        sourceSessionId: SOURCE_SESSION_ID,
        sourceSessionPath: path.join(projectRoot, 'outside.jsonl'),
        targetSessionId: FORK_SESSION_ID,
      }),
    ).rejects.toThrow(
      `Source transcript path does not belong to session "${SOURCE_SESSION_ID}".`,
    );
    expect(repository.readForFork).not.toHaveBeenCalled();
  });

  it('reads a cross-worktree fork from the exact resolved source bucket', async () => {
    const projectRoot = await createProjectRoot();
    const sourceProjectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId } = await createSourceSession(
        sourceProjectRoot,
        configHome,
      );
      const sourceSessionPath = getSessionTranscriptPath(
        sourceProjectRoot,
        sourceSessionId,
        configHome,
      );
      const result = await new ForkSessionService(
        new TranscriptStore(),
      ).createFork({
        projectRoot,
        sourceSessionId,
        sourceSessionPath,
        sourceProjectRoot,
        targetSessionId: FORK_SESSION_ID,
      });

      expect(result.sourceSessionInfo).toMatchObject({
        id: sourceSessionId,
        sessionPath: sourceSessionPath,
        transcriptProjectRoot: sourceProjectRoot,
      });
      expect(result.sessionPath).toBe(
        getSessionTranscriptPath(projectRoot, FORK_SESSION_ID, configHome),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('removes the target transcript when workspace state persistence fails', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId } =
        await createSourceSession(projectRoot);
      const stateWriteSpy = vi
        .spyOn(SessionStateStore.prototype, 'createExclusive')
        .mockRejectedValueOnce(new Error('state write failed'));
      const service = new ForkSessionService(new TranscriptStore());
      const targetPath = getSessionTranscriptPath(
        projectRoot,
        FORK_SESSION_ID,
        configHome,
      );

      await expect(
        service.createFork({
          projectRoot,
          sourceSessionId,
          targetSessionId: FORK_SESSION_ID,
        }),
      ).rejects.toThrow('state write failed');
      await expect(fs.stat(targetPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      stateWriteSpy.mockRestore();
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('preserves the operation and cleanup failures when artifact removal fails', async () => {
    const projectRoot = await createProjectRoot();
    const store = new TranscriptStore();
    const service = new ForkSessionService(store);
    const originalError = new Error('session resume failed');
    const cleanupError = new Error('transcript cleanup failed');
    vi.spyOn(store, 'deleteTranscript').mockRejectedValueOnce(cleanupError);

    try {
      await expect(
        service.deleteForkArtifacts({
          projectRoot,
          sessionId: FORK_SESSION_ID,
          sessionPath: getSessionTranscriptPath(projectRoot, FORK_SESSION_ID),
          originalError,
        }),
      ).rejects.toMatchObject({
        message: `Failed to remove incomplete fork session "${FORK_SESSION_ID}" after "session resume failed": transcript cleanup failed`,
        errors: [originalError, cleanupError],
      });
    } finally {
      await store.close();
    }
  });

  it('generates unique branch titles with numbered suffixes without parsing full transcripts', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      await createSourceSession(projectRoot);
      await fs.mkdir(
        path.dirname(
          getSessionTranscriptPath(projectRoot, SECOND_SESSION_ID, configHome),
        ),
        {
          recursive: true,
        },
      );
      await fs.writeFile(
        getSessionTranscriptPath(projectRoot, SECOND_SESSION_ID, configHome),
        JSON.stringify({
          type: 'custom-title',
          sessionId: SECOND_SESSION_ID,
          customTitle: 'Example (Branch)',
        }) +
          '\n' +
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            timestamp: new Date().toISOString(),
            message: { role: 'user', content: 'hello' },
            parentUuid: null,
            isSidechain: false,
            cwd: projectRoot,
            sessionId: SECOND_SESSION_ID,
            userType: 'external',
            version: '1.0.0',
          }) +
          '\n',
      );

      const service = new ForkSessionService(new TranscriptStore());
      const resolveSpy = vi.spyOn(
        TranscriptRepository.prototype,
        'resolveSession',
      );
      expect(
        await service.generateUniqueBranchTitle(projectRoot, 'Example', {
          excludeSessionIds: [SOURCE_SESSION_ID],
        }),
      ).toBe('Example (Branch 2)');
      expect(resolveSpy).not.toHaveBeenCalled();
      resolveSpy.mockRestore();
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('rejects reusing the source session ID as the fork target', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId } =
        await createSourceSession(projectRoot);
      const service = new ForkSessionService(new TranscriptStore());

      await expect(
        service.createFork({
          projectRoot,
          sourceSessionId,
          targetSessionId: sourceSessionId,
        }),
      ).rejects.toThrowError(
        new ForkSessionError(
          `Target session "${sourceSessionId}" must be different from the source session.`,
        ),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('rejects using an existing session as the fork target', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId } =
        await createSourceSession(projectRoot);
      const service = new ForkSessionService(new TranscriptStore());

      const existingTargetPath = getSessionTranscriptPath(
        projectRoot,
        EXISTING_TARGET_ID,
        configHome,
      );
      await fs.mkdir(path.dirname(existingTargetPath), { recursive: true });
      await fs.writeFile(existingTargetPath, '{"type":"noop"}\n', 'utf8');

      await expect(
        service.createFork({
          projectRoot,
          sourceSessionId,
          targetSessionId: EXISTING_TARGET_ID,
        }),
      ).rejects.toThrowError(
        new ForkSessionError(
          `Target session "${EXISTING_TARGET_ID}" already exists.`,
        ),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('preserves existing target state when no target transcript exists', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId } =
        await createSourceSession(projectRoot);
      const existingState = new SessionStateStore({
        projectRoot,
        sessionId: EXISTING_TARGET_ID,
        configHomeDir: configHome,
      });
      await existingState.setSegment('existing', { owner: 'original' });
      const targetPath = getSessionTranscriptPath(
        projectRoot,
        EXISTING_TARGET_ID,
        configHome,
      );

      await expect(
        new ForkSessionService(new TranscriptStore()).createFork({
          projectRoot,
          sourceSessionId,
          targetSessionId: EXISTING_TARGET_ID,
        }),
      ).rejects.toThrowError(
        new ForkSessionError(
          `Target session "${EXISTING_TARGET_ID}" already exists.`,
        ),
      );

      await expect(existingState.getSegment('existing')).resolves.toEqual({
        owner: 'original',
      });
      await expect(fs.stat(targetPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      storageSpy.mockRestore();
    }
  });

  it('rejects using a non-UUID target session ID', async () => {
    const projectRoot = await createProjectRoot();
    const configHome = path.join(projectRoot, '.config');
    await fs.mkdir(configHome, { recursive: true });
    const storageSpy = vi
      .spyOn(Storage, 'getGlobalConfigDir')
      .mockReturnValue(configHome);

    try {
      const { sessionId: sourceSessionId } =
        await createSourceSession(projectRoot);
      const service = new ForkSessionService(new TranscriptStore());

      await expect(
        service.createFork({
          projectRoot,
          sourceSessionId,
          targetSessionId: 'invalid-id',
        }),
      ).rejects.toThrowError(
        new ForkSessionError(
          'Target session "invalid-id" must be a valid UUID.',
        ),
      );
    } finally {
      storageSpy.mockRestore();
    }
  });
});
