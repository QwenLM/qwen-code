/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { cloneUsage } from '../../protocol/provider/empty-usage.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  SystemMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../protocol/transcript/message.js';
import {
  cleanMessagesForLogging,
  isChainParticipant,
  isLoggableMessage,
  SessionTranscriptWriter,
} from './session-writer.js';
import {
  createAssistantAPIErrorMessage,
  createToolResultMessage,
} from '../../protocol/transcript/conversions.js';
import { createTestTranscriptWriter } from './testing/fixtures.js';
import { ENV_EXPOSE_TOKEN_USAGE } from '../../config/brand.js';
import type { AppendChannelLease } from './append-coordinator.js';
import { TranscriptRepository } from './repository.js';
import { TranscriptStore } from './store.js';
import { AppendChannel, nodeTranscriptFileSystem } from './append-channel.js';

const tempDirs: string[] = [];

beforeEach(() => {
  delete process.env[ENV_EXPOSE_TOKEN_USAGE];
});

afterEach(async () => {
  delete process.env[ENV_EXPOSE_TOKEN_USAGE];
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function makeUserMessage(content: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      role: 'user',
      content,
    },
  };
}

function makeAssistantMessage(content: string): AssistantMessage {
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
      stop_reason: 'end_turn',

      usage: {
        ...cloneUsage(),
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: 'text', text: content }],
    },
  };
}

function makeAssistantFragment(
  content: AssistantMessage['message']['content'],
  stopReason: AssistantMessage['message']['stop_reason'] | undefined,
): AssistantMessage {
  const message = makeAssistantMessage('');
  message.message = { ...message.message, content };
  message.message = {
    ...message.message,
    stop_reason: stopReason ?? null,
  };
  if (stopReason === undefined) {
    delete message.message.usage;
  }
  return message;
}

function makeSystemMessage(
  subtype: SystemMessage['subtype'],
  content: string,
): SystemMessage {
  return {
    type: 'system',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    subtype,
    content,
    level: 'info',
  };
}

function makeAttachmentMessage(userType?: string): AttachmentMessage {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    userType,
    attachment: {
      type: 'critical_system_reminder',
      content: 'attachment',
    },
  };
}

function makeTaskReminderMessage(): AttachmentMessage {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: {
      type: 'task_reminder',
      content: [],
      itemCount: 0,
    },
  };
}

function makeHookSuccessMessage(
  content: string,
  stdout?: string,
  stderr?: string,
): AttachmentMessage {
  return {
    type: 'attachment',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    attachment: {
      type: 'hook_success',
      content,
      stdout,
      stderr,
    },
  };
}

function makeToolUseSummaryMessage(): ToolUseSummaryMessage {
  return {
    type: 'tool_use_summary',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    summary: {},
    precedingToolUseIds: [],
  };
}

function makeTombstoneMessage(): TombstoneMessage {
  return {
    type: 'tombstone',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { id: 'partial' },
  };
}

async function createWriter() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-writer-'));
  tempDirs.push(dir);

  const filePath = path.join(dir, 'session.jsonl');
  const { writer, store } = await createTestTranscriptWriter({
    filePath,
    sessionId: 'session-1',
    cwd: '/workspace/project',
    entrypoint: 'cli',
    version: '1.2.3',
    gitBranch: 'feat/test',
    flushIntervalMs: 0,
  });

  return { writer, filePath, store };
}

async function readJsonl(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('cleanMessagesForLogging', () => {
  it('persists attachments while filtering display-only message wrappers', () => {
    const progress: Message = {
      type: 'progress',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      data: { step: 'thinking' },
    };
    const messages: Message[] = [
      makeUserMessage('hello'),
      progress,
      makeAttachmentMessage(),
      makeAttachmentMessage('ant'),
      makeAttachmentMessage(),
      makeTaskReminderMessage(),
      makeToolUseSummaryMessage(),
      makeTombstoneMessage(),
    ];

    expect(
      cleanMessagesForLogging(messages).map((message) => message.type),
    ).toEqual(['user', 'attachment', 'attachment', 'attachment', 'attachment']);
    expect(isLoggableMessage(progress)).toBe(false);
  });

  it('drops empty hook success attachments but keeps meaningful output', () => {
    const empty = makeHookSuccessMessage('', '  ', '\n');
    const meaningful = makeHookSuccessMessage('', 'workspace ready');

    expect(cleanMessagesForLogging([empty, meaningful])).toEqual([meaningful]);
    expect(isLoggableMessage(empty)).toBe(false);
    expect(isLoggableMessage(meaningful)).toBe(true);
  });

  it('promotes virtual messages to real transcript entries', () => {
    const virtualUser = makeUserMessage('hidden wrapper');
    virtualUser.isVirtual = true;

    const [cleaned] = cleanMessagesForLogging([virtualUser]);
    expect(cleaned).toMatchObject({
      type: 'user',
      uuid: virtualUser.uuid,
    });
    expect(cleaned).not.toHaveProperty('isVirtual');
  });

  it('persists compact file tool results without complete file contents', () => {
    const message: UserMessage = {
      type: 'user',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-edit',
            content: 'Updated /workspace/example.ts',
          },
        ],
      },
      toolUseResult: {
        filePath: '/workspace/example.ts',
        oldString: 'old',
        newString: 'new',
        originalFile: 'old',
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ['-old', '+new'],
          },
        ],
        userModified: false,
        replaceAll: false,
      },
    };

    const [cleaned] = cleanMessagesForLogging([message]);
    expect(cleaned).toMatchObject({
      toolUseResult: {
        success: true,
        file_path: '/workspace/example.ts',
        additions: 1,
        deletions: 1,
      },
    });
    expect((cleaned as UserMessage).toolUseResult).not.toHaveProperty(
      'originalFile',
    );
    expect(message.toolUseResult).toHaveProperty('originalFile', 'old');
  });
});

describe('isChainParticipant', () => {
  it('keeps only transcript chain message types', () => {
    expect(isChainParticipant(makeUserMessage('user'))).toBe(true);
    expect(isChainParticipant(makeAssistantMessage('assistant'))).toBe(true);
    expect(isChainParticipant(makeSystemMessage('informational', 'info'))).toBe(
      true,
    );
    expect(isChainParticipant(makeTaskReminderMessage())).toBe(true);
    expect(isChainParticipant(makeAttachmentMessage())).toBe(true);
    expect(isChainParticipant(makeAttachmentMessage('ant'))).toBe(true);
    expect(isChainParticipant(makeHookSuccessMessage('', ' ', ''))).toBe(false);
    expect(
      isChainParticipant(makeHookSuccessMessage('', 'workspace ready')),
    ).toBe(true);
    expect(isChainParticipant(makeToolUseSummaryMessage())).toBe(false);
    expect(isChainParticipant(makeTombstoneMessage())).toBe(false);
  });
});

describe('SessionTranscriptWriter through TranscriptStore', () => {
  it.each(['ENOSPC', 'EIO'] as const)(
    'rolls back a failed batch and preserves the retry contract for %s',
    async (code) => {
      const directory = await fs.mkdtemp(
        path.join(os.tmpdir(), 'transcript-batch-failure-'),
      );
      tempDirs.push(directory);
      const filePath = path.join(directory, 'session.jsonl');
      const baseline = makeUserMessage('existing conversation');
      const first = makeUserMessage('first chunk');
      const second = makeUserMessage('failed chunk');
      const third = makeUserMessage('unattempted chunk');
      const failure = Object.assign(new Error(`${code}: write failed`), {
        code,
      });
      let fail = true;
      const appendFile = vi.fn(
        async (
          ...args: Parameters<typeof nodeTranscriptFileSystem.appendFile>
        ) => {
          if (fail && args[1].toString().includes(second.uuid)) throw failure;
          await nodeTranscriptFileSystem.appendFile(...args);
        },
      );
      const store = new TranscriptStore({
        coordinatorOptions: {
          flushIntervalMs: 0,
          maxBatchBytes: 1,
          fileSystem: {
            ...nodeTranscriptFileSystem,
            realpath: fs.realpath,
            appendFile,
          },
        },
      });
      const writer = await store.acquireSessionWriter({
        filePath,
        sessionId: 'session-1',
        cwd: directory,
        entrypoint: 'cli',
      });
      try {
        await writer.recordMessages([baseline]);
        const before = await fs.readFile(filePath);
        const batch = [first, second, third];
        const outcomes = await Promise.allSettled([
          writer.recordMessages(batch),
          writer.recordMessages(batch),
        ]);
        expect(outcomes).toEqual([
          { status: 'rejected', reason: failure },
          { status: 'rejected', reason: failure },
        ]);
        expect(await fs.readFile(filePath)).toEqual(before);
        const callsAfterFailure = appendFile.mock.calls.length;
        fail = false;
        if (code === 'ENOSPC') {
          await writer.recordMessages(batch);
          const next = makeUserMessage('after cleanup');
          await writer.recordMessages([next]);
          expect(
            (await readJsonl(filePath)).filter(
              (entry) => entry['type'] === 'user',
            ),
          ).toMatchObject([
            { uuid: baseline.uuid, parentUuid: null },
            { uuid: first.uuid, parentUuid: baseline.uuid },
            { uuid: second.uuid, parentUuid: first.uuid },
            { uuid: third.uuid, parentUuid: second.uuid },
            { uuid: next.uuid, parentUuid: third.uuid },
          ]);
          const restored =
            await new TranscriptRepository().loadSessionWriterState(
              filePath,
              'session-1',
            );
          expect(restored.mainParentUuid).toBe(next.uuid);
        } else {
          await expect(writer.recordMessages(batch)).rejects.toBe(failure);
          await expect(writer.flush()).rejects.toBe(failure);
          expect(appendFile).toHaveBeenCalledTimes(callsAfterFailure);
          expect(await fs.readFile(filePath)).toEqual(before);
        }
      } finally {
        if (code === 'ENOSPC') await store.close();
        else await expect(store.close()).rejects.toBe(failure);
      }
    },
  );

  it('persists original MCP identities on tool calls even without a result', async () => {
    const { writer, filePath, store } = await createWriter();
    const assistant = makeAssistantMessage('');
    assistant.message = {
      ...assistant.message,
      content: [
        {
          type: 'tool_use',
          id: 'mcp-call',
          name: 'mcp__demo__u_611aec98eddc',
          input: { id: 'demo-001' },
          mcpInfo: { serverName: '转换服务', toolName: '文档格式转换_查询' },
        },
      ],
    };
    await writer.recordMessages([makeUserMessage('query'), assistant]);
    await writer.flush();
    const entries = await readJsonl(filePath);
    const persisted = entries.find((entry) => entry['uuid'] === assistant.uuid);
    expect(persisted).toMatchObject({
      message: { content: assistant.message.content },
    });
    expect(persisted).not.toHaveProperty('mcpToolIdentities');
    await writer.recordMessages([
      createToolResultMessage(
        [
          {
            type: 'tool_result',
            tool_use_id: 'mcp-call',
            content: 'Permission denied',
            is_error: true,
          },
        ],
        assistant.uuid,
      ),
    ]);
    await writer.flush();
    const restored = await new TranscriptRepository().resolveSession(filePath);
    expect(
      restored?.messages.find((message) => message.uuid === assistant.uuid),
    ).toMatchObject({
      message: { content: assistant.message.content },
    });
    await writer.close();
    await store.close();
  });

  it('persists an explicit null worktree state before the first message', async () => {
    const { writer, filePath, store } = await createWriter();

    await writer.recordWorktreeState(null);
    await writer.flush();

    const resolved = await new TranscriptRepository().resolveSession(filePath);
    expect(
      resolved?.index.metadata.worktreeSessions.get('session-1'),
    ).toBeNull();

    await writer.close();
    await store.close();
  });

  it('persists worktree state when closing before the first message', async () => {
    const { writer, filePath, store } = await createWriter();

    await writer.recordWorktreeState({
      originalCwd: '/workspace/project',
      preEnterOriginalCwd: '/workspace/project',
      worktreePath: '/workspace/worktree',
      worktreeCwd: '/workspace/worktree',
      worktreeName: 'feature',
      sessionId: 'session-1',
      lifecycle: 'owner',
    });
    await writer.close();

    const resolved = await new TranscriptRepository().resolveSession(filePath);

    expect(resolved?.index.metadata.worktreeSessions.get('session-1')).toEqual({
      originalCwd: '/workspace/project',
      preEnterOriginalCwd: '/workspace/project',
      worktreePath: '/workspace/worktree',
      worktreeCwd: '/workspace/worktree',
      worktreeName: 'feature',
      sessionId: 'session-1',
      lifecycle: 'owner',
    });

    await store.close();
  });

  it('updates message runtime metadata without moving the transcript file', async () => {
    const { writer, filePath, store } = await createWriter();

    await writer.recordWorktreeState({
      originalCwd: '/workspace/project',
      preEnterOriginalCwd: '/workspace/project',
      worktreePath: '/workspace/worktree',
      worktreeCwd: '/workspace/worktree/apps/desktop',
      worktreeName: 'feature',
      worktreeBranch: 'worktree-feature',
      sessionId: 'session-1',
      lifecycle: 'owner',
    });
    await writer.recordMessages([makeUserMessage('inside worktree')]);
    await writer.recordWorktreeState(null);
    await writer.recordMessages([makeUserMessage('back home')]);
    await writer.flush();

    const users = (await readJsonl(filePath)).filter(
      (entry) => entry['type'] === 'user',
    );
    expect(users[0]).toMatchObject({
      cwd: '/workspace/worktree/apps/desktop',
      gitBranch: 'worktree-feature',
    });
    expect(users[1]).toMatchObject({
      cwd: '/workspace/project',
      gitBranch: 'feat/test',
    });
    expect(writer.getSessionFilePath()).toBe(await fs.realpath(filePath));

    await writer.close();
    await store.close();
  });

  it('keeps a historical transcript without worktree state as undefined', async () => {
    const { filePath, store, writer } = await createWriter();
    await writer.close();
    await store.close();

    const historicalUser = makeUserMessage('historical prompt');
    await fs.writeFile(
      filePath,
      `${JSON.stringify({
        ...historicalUser,
        parentUuid: null,
        isSidechain: false,
        cwd: '/workspace/project',
        sessionId: 'session-1',
        userType: 'external',
        entrypoint: 'cli',
        version: '1.2.3',
        gitBranch: 'feat/test',
      })}\n`,
      'utf8',
    );

    const resolved = await new TranscriptRepository().resolveSession(filePath);
    expect(
      resolved?.index.metadata.worktreeSessions.get('session-1'),
    ).toBeUndefined();
  });

  it('records the active leaf after every successful main-chain advance', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const assistant = makeAssistantMessage('world');

    await writer.recordMessages([user]);
    await writer.recordMessages([assistant]);
    await writer.flush();

    const entries = await readJsonl(filePath);
    const userIndex = entries.findIndex((entry) => entry['uuid'] === user.uuid);
    const userLeafIndex = entries.findIndex(
      (entry) =>
        entry['type'] === 'active-leaf' && entry['leafUuid'] === user.uuid,
    );
    const assistantIndex = entries.findIndex(
      (entry) => entry['uuid'] === assistant.uuid,
    );
    const assistantLeafIndex = entries.findIndex(
      (entry) =>
        entry['type'] === 'active-leaf' && entry['leafUuid'] === assistant.uuid,
    );
    const normalMarkers = entries.filter(
      (entry) => entry['type'] === 'active-leaf' && entry['explicit'] === false,
    );

    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(userIndex).toBeLessThan(userLeafIndex);
    expect(assistantIndex).toBeGreaterThan(userLeafIndex);
    expect(assistantIndex).toBeLessThan(assistantLeafIndex);
    expect(normalMarkers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ leafUuid: user.uuid, explicit: false }),
        expect.objectContaining({ leafUuid: assistant.uuid, explicit: false }),
      ]),
    );
  });

  it('does not move the main active leaf for sidechain messages', async () => {
    const { writer, filePath } = await createWriter();

    await writer.recordSidechainMessages(
      [makeUserMessage('delegate'), makeAssistantMessage('done')],
      'agent-1',
    );
    await writer.flush();

    expect(
      (await readJsonl(filePath)).filter(
        (entry) => entry['type'] === 'active-leaf',
      ),
    ).toEqual([]);
  });

  it('keeps the explicit active leaf as the last marker after metadata refresh', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const assistant = makeAssistantMessage('world');
    await writer.recordMessages([user, assistant]);

    await writer.recordActiveLeaf(user.uuid, {
      explicit: true,
      rewound: true,
      durable: true,
    });
    await writer.recordCustomTitle('rewound title');
    await writer.recordTag('rewound');
    await writer.flush();

    const activeMarkers = (await readJsonl(filePath)).filter(
      (entry) => entry['type'] === 'active-leaf',
    );
    expect(activeMarkers.at(-1)).toMatchObject({
      leafUuid: user.uuid,
      explicit: true,
      rewound: true,
    });
  });

  it.each([
    { failurePoint: 'append' as const, failureMessage: 'append failed' },
    { failurePoint: 'barrier' as const, failureMessage: 'barrier failed' },
  ])(
    'does not move the parent cursor when durable marker $failurePoint fails',
    async ({ failurePoint, failureMessage }) => {
      const appended: Array<ReadonlyArray<Record<string, unknown>>> = [];
      const append = vi.fn(
        async (entries: ReadonlyArray<Record<string, unknown>>) => {
          appended.push(entries);
          if (failurePoint === 'append' && append.mock.calls.length === 1) {
            throw new Error(failureMessage);
          }
        },
      );
      const barrier = vi.fn(async () => {
        if (failurePoint === 'barrier' && barrier.mock.calls.length === 1) {
          throw new Error(failureMessage);
        }
      });
      const channel = {
        filePath: '/workspace/session.jsonl',
        append,
        barrier,
        flush: vi.fn().mockResolvedValue(undefined),
        readTail: vi.fn().mockResolvedValue(Buffer.alloc(0)),
        release: vi.fn().mockResolvedValue(undefined),
      } as unknown as AppendChannelLease;
      const writer = new SessionTranscriptWriter({
        channel,
        sessionId: 'session-1',
        cwd: '/workspace',
        entrypoint: 'cli',
      });
      writer.initializeExistingTranscript(['old-leaf'], 'old-leaf');

      await expect(
        writer.recordActiveLeaf('new-leaf', {
          explicit: true,
          rewound: true,
          durable: true,
        }),
      ).rejects.toThrow(failureMessage);

      const next = makeUserMessage('after failure');
      await writer.recordMessages([next]);
      const persistedNext = appended
        .flat()
        .find((entry) => entry['uuid'] === next.uuid);
      expect(persistedNext).toMatchObject({ parentUuid: 'old-leaf' });
    },
  );

  it('persists task reminders in the parent chain', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('continue');
    const reminder = makeTaskReminderMessage();
    const assistant = makeAssistantMessage('working');

    await writer.recordMessages([user, reminder, assistant]);
    await writer.flush();

    const entries = await readJsonl(filePath);
    const persistedReminder = entries.find(
      (entry) => entry['uuid'] === reminder.uuid,
    );
    const persistedAssistant = entries.find(
      (entry) => entry['uuid'] === assistant.uuid,
    );
    expect(persistedReminder).toMatchObject({
      type: 'attachment',
      parentUuid: user.uuid,
      attachment: {
        type: 'task_reminder',
        content: [],
        itemCount: 0,
      },
    });
    expect(persistedAssistant).toMatchObject({
      type: 'assistant',
      parentUuid: reminder.uuid,
    });
  });

  it('writes image tool results inside the tool_result content block', async () => {
    const { writer, filePath } = await createWriter();
    const assistant = makeAssistantMessage('reading image');
    const toolResult = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'toolu-image',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                mediaType: 'image/png',
                data: 'aW1hZ2U=',
              },
            },
          ],
          is_error: false,
          toolUseResult: {
            type: 'image',
            file: {
              base64: 'aW1hZ2U=',
              type: 'image/png',
              originalSize: 5,
            },
          },
        },
      ],
      assistant.uuid,
      { promptId: 'prompt-image' },
    );

    await writer.recordMessages([assistant, toolResult]);
    await writer.flush();

    const entries = await readJsonl(filePath);
    const persisted = entries.find(
      (entry) => entry['uuid'] === toolResult.uuid,
    );
    expect(persisted).toMatchObject({
      type: 'user',
      parentUuid: assistant.uuid,
      sourceToolAssistantUUID: assistant.uuid,
      promptId: 'prompt-image',
      toolUseResult: {
        type: 'image',
        file: {
          base64: 'aW1hZ2U=',
          type: 'image/png',
          originalSize: 5,
        },
      },
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu-image',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aW1hZ2U=',
                },
              },
            ],
          },
        ],
      },
    });
    expect(
      (
        persisted?.['message'] as {
          content?: Array<Record<string, unknown>>;
        }
      )?.content?.[0],
    ).not.toHaveProperty('is_error');
  });

  it('writes transcript messages with parent chain semantics', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    user.origin = { kind: 'human' };
    const assistant = makeAssistantMessage('world');
    assistant.requestId = 'req-runtime-only';
    assistant.responseGroupId = 'persisted-response-group';
    assistant.requestTokenAnchor = {
      request: 'input-fingerprint',
      response: 'response-fingerprint',
      requestId: 'req-runtime-only',
    };
    const toolResult = makeUserMessage('tool result');
    toolResult.sourceToolAssistantUUID = assistant.uuid;
    const compactBoundary = makeSystemMessage('compact_boundary', 'compacted');
    compactBoundary.isCompactSummary = true;
    compactBoundary.compactMetadata = { trigger: 'auto', preTokens: 100 };
    const compactSummary = makeUserMessage('Summary: previous work');
    compactSummary.isCompactSummary = true;
    const resumedAssistant = makeAssistantMessage('after compact');

    const lastUuid = await writer.recordMessages([
      user,
      assistant,
      toolResult,
      compactBoundary,
      compactSummary,
      resumedAssistant,
    ]);

    expect(lastUuid).toBe(resumedAssistant.uuid);

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries).toHaveLength(9);

    expect(entries[0]).toMatchObject({
      type: 'user',
      parentUuid: null,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      gitBranch: 'feat/test',
      origin: { kind: 'human' },
    });
    expect(entries[1]).toMatchObject({
      type: 'assistant',
      parentUuid: user.uuid,
    });
    expect(entries[1]?.['message']).not.toHaveProperty('usage');
    expect(entries[1]?.['message']).toHaveProperty('container', null);
    expect(entries[1]?.['message']).toHaveProperty('context_management', null);
    expect(entries[1]).not.toHaveProperty('requestId');
    expect(entries[1]?.['responseGroupId']).toBe('persisted-response-group');
    expect(entries[1]?.['requestTokenAnchor']).toEqual(
      assistant.requestTokenAnchor,
    );
    expect(entries[2]).toMatchObject({
      type: 'user',
      parentUuid: assistant.uuid,
    });
    expect(entries[3]).toMatchObject({
      type: 'system',
      parentUuid: null,
      logicalParentUuid: toolResult.uuid,
      requiresActiveLeafCommit: true,
    });
    expect(entries[4]).toMatchObject({
      type: 'user',
      parentUuid: compactBoundary.uuid,
      isCompactSummary: true,
    });
    expect(entries[5]).toMatchObject({
      type: 'assistant',
      parentUuid: compactSummary.uuid,
    });
    expect(entries[6]).toMatchObject({
      type: 'active-leaf',
      leafUuid: resumedAssistant.uuid,
      explicit: false,
      compactBoundaryUuid: compactBoundary.uuid,
    });
    expect(entries[7]).toMatchObject({
      type: 'last-prompt',
      lastPrompt: 'tool result',
    });
    expect(entries[8]).toMatchObject({
      type: 'active-leaf',
      leafUuid: resumedAssistant.uuid,
      explicit: false,
    });
  });

  it('creates fork snapshots with the same projection and cached metadata as persistence', async () => {
    const { writer } = await createWriter();
    const virtualUser = makeUserMessage('virtual but durable');
    virtualUser.isVirtual = true;
    const assistant = makeAssistantMessage('answer');
    assistant.requestId = 'runtime-request';
    const transientTask = makeSystemMessage('task_started', 'working');
    transientTask.task_id = 'task-1';
    transientTask.tool_use_id = 'tool-1';
    transientTask.description = 'working';
    const compactBoundary = makeSystemMessage('compact_boundary', 'compact');
    compactBoundary.compactMetadata = { trigger: 'manual', preTokens: 42 };
    const summary = makeUserMessage('summary');
    summary.isCompactSummary = true;
    const durableAttachment = makeTaskReminderMessage();
    const messages: Message[] = [
      virtualUser,
      assistant,
      transientTask,
      compactBoundary,
      summary,
      durableAttachment,
    ];

    await writer.recordMessages(messages);
    await writer.recordCustomTitle('Current title');
    await writer.recordAiTitle('AI title');
    await writer.recordTag('reviewed');
    await writer.recordRuntimeConfig({
      model: 'model-a',
      reasoningEffort: 'high',
      contextWindow: 256000,
    });
    await writer.recordContentReplacement([
      {
        messageUuid: assistant.uuid,
        blockIndex: 0,
        originalType: 'text',
        stubContent: '[replaced]',
      },
    ]);

    const snapshot = await writer.createForkSnapshot(messages);

    expect(snapshot.transcriptChain.map((message) => message.uuid)).toEqual([
      virtualUser.uuid,
      assistant.uuid,
      compactBoundary.uuid,
      summary.uuid,
      durableAttachment.uuid,
    ]);
    expect(snapshot.transcriptChain[0]).not.toHaveProperty('isVirtual');
    const projectedAssistant = snapshot.transcriptChain.find(
      (message) => message.type === 'assistant',
    );
    expect(projectedAssistant).not.toHaveProperty('requestId');
    expect(projectedAssistant?.message).not.toHaveProperty('usage');
    expect(snapshot.transcriptChain[2]).toMatchObject({
      parentUuid: null,
      logicalParentUuid: assistant.uuid,
      requiresActiveLeafCommit: true,
    });
    expect(snapshot.transcriptChain[3]).toMatchObject({
      parentUuid: compactBoundary.uuid,
    });
    expect(snapshot).toMatchObject({
      customTitle: 'Current title',
      aiTitle: 'AI title',
      tag: 'reviewed',
      runtimeConfig: {
        model: 'model-a',
        reasoningEffort: 'high',
        contextWindow: 256000,
      },
      contentReplacements: [
        {
          messageUuid: assistant.uuid,
          blockIndex: 0,
          originalType: 'text',
          stubContent: '[replaced]',
        },
      ],
    });
  });

  it('skips SDK-only task lifecycle system events during persistence', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const taskStarted = makeSystemMessage('task_started', '');
    taskStarted.task_id = 'task-1';
    taskStarted.tool_use_id = 'toolu-1';
    taskStarted.description = 'Reading file';

    const taskProgress = makeSystemMessage('task_progress', '');
    taskProgress.task_id = 'task-1';
    taskProgress.tool_use_id = 'toolu-1';
    taskProgress.description = 'Reading file';
    taskProgress.usage = {
      total_tokens: 500,
      tool_uses: 3,
      duration_ms: 1200,
    };
    taskProgress.last_tool_name = 'Read';

    const taskNotification = makeSystemMessage('task_notification', '');
    taskNotification.task_id = 'task-1';
    taskNotification.tool_use_id = 'toolu-1';
    taskNotification.status = 'completed';
    taskNotification.summary = 'Task finished';
    taskNotification.usage = {
      total_tokens: 1000,
      tool_uses: 5,
      duration_ms: 3000,
    };

    await writer.recordMessages([
      user,
      taskStarted,
      taskProgress,
      taskNotification,
    ]);
    await writer.flush();
    const entries = await readJsonl(filePath);
    const transcriptMessages = entries.filter(
      (entry) => entry['type'] === 'user' || entry['type'] === 'system',
    );

    expect(entries.some((e) => e['subtype'] === 'task_started')).toBe(false);
    expect(entries.some((e) => e['subtype'] === 'task_progress')).toBe(false);
    expect(entries.some((e) => e['subtype'] === 'task_notification')).toBe(
      false,
    );
    expect(transcriptMessages).toHaveLength(1);
    expect(transcriptMessages[0]).toMatchObject({
      type: 'user',
      uuid: user.uuid,
      message: expect.objectContaining({ content: 'hello' }),
    });
  });

  it('preserves assistant usage when the internal env switch is enabled', async () => {
    process.env[ENV_EXPOSE_TOKEN_USAGE] = 'true';
    const { writer, filePath } = await createWriter();
    const assistant = makeAssistantMessage('world');

    await writer.recordMessages([makeUserMessage('hello'), assistant]);
    await writer.flush();

    const entries = await readJsonl(filePath);
    expect(entries[1]?.['message']).toMatchObject({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
      },
    });
  });

  it('preserves custom provider usage in the session transcript by default', async () => {
    const { writer, filePath } = await createWriter();
    const assistant = makeAssistantMessage('custom provider response');
    assistant.modelSource = 'custom';
    assistant.customProviderId = 'gateway';
    assistant.message.usage!.cache_creation_input_tokens = 30;
    assistant.message.usage!.cache_read_input_tokens = 40;

    await writer.recordMessages([makeUserMessage('hello'), assistant]);
    await writer.flush();

    const entries = await readJsonl(filePath);
    expect(entries[1]).toMatchObject({
      type: 'assistant',
      modelSource: 'custom',
      customProviderId: 'gateway',
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
        },
      },
    });
  });

  it('persists credits metadata while masking token usage by default', async () => {
    const { writer, filePath } = await createWriter();
    const assistant = makeAssistantMessage('world');
    Object.assign(assistant.message.usage!, {
      request_id: 'request-credits',
      billable: true,
      credits: 1.1965760162857142,
      original_credits: 2.3931520325714284,
    });

    await writer.recordMessages([makeUserMessage('hello'), assistant]);
    await writer.flush();

    const entries = await readJsonl(filePath);
    expect(entries[1]?.['message']).toMatchObject({
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        request_id: 'request-credits',
        billable: true,
        credits: 1.1965760162857142,
        original_credits: 2.3931520325714284,
      },
    });
  });

  it('deduplicates repeated prefix writes', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const assistant = makeAssistantMessage('world');

    await writer.recordMessages([user, assistant]);
    const lastUuid = await writer.recordMessages([user, assistant]);

    expect(lastUuid).toBe(assistant.uuid);
    await writer.flush();
    expect(
      (await readJsonl(filePath)).filter((entry) => 'uuid' in entry),
    ).toHaveLength(2);
  });

  it.each(['separate', 'combined'] as const)(
    'preserves compacted history when an old user is replayed in a %s batch',
    async (batch) => {
      const { writer, filePath, store } = await createWriter();
      const oldUser = makeUserMessage('old remote prompt');
      const boundary = makeSystemMessage('compact_boundary', 'compacted');
      boundary.compactMetadata = { trigger: 'auto', preTokens: 100 };
      const summary = makeUserMessage('summary');
      summary.isCompactSummary = true;
      const newerUser = makeUserMessage('new remote prompt');
      const newerAnswer = makeAssistantMessage('new answer');
      await writer.recordMessages([oldUser]);
      await writer.recordMessages([boundary, summary, newerUser, newerAnswer]);
      await writer.close();
      await store.close();

      const resumed = await createTestTranscriptWriter({
        filePath,
        sessionId: 'session-1',
        cwd: '/workspace/project',
        entrypoint: 'cli',
        flushIntervalMs: 0,
      });
      try {
        const reply = makeAssistantMessage('reply after reconnect');
        if (batch === 'separate') {
          const parent = await resumed.writer.recordMessages(
            [oldUser],
            newerAnswer.uuid,
          );
          await resumed.writer.recordMessages([reply], parent);
        } else {
          await resumed.writer.recordMessages([oldUser, reply]);
        }
        await resumed.writer.flush();
        const entries = await readJsonl(filePath);
        expect(
          entries.find((entry) => entry['uuid'] === reply.uuid),
        ).toMatchObject({ parentUuid: newerAnswer.uuid });
        expect(
          entries.filter((entry) => entry['uuid'] === oldUser.uuid),
        ).toHaveLength(1);
        const restored = await new TranscriptRepository().resolveSession(
          filePath,
        );
        expect(restored?.leafUuid).toBe(reply.uuid);
        expect(restored?.messages.map((message) => message.uuid)).toEqual([
          boundary.uuid,
          summary.uuid,
          newerUser.uuid,
          newerAnswer.uuid,
          reply.uuid,
        ]);
      } finally {
        await resumed.writer.close();
        await resumed.store.close();
      }
    },
  );

  it('adopts a caller-selected main parent for the next ordered write', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const assistant = makeAssistantMessage('first branch');
    const alternate = makeAssistantMessage('alternate branch');

    await writer.recordMessages([user, assistant]);
    writer.adoptMainParentUuid(user.uuid);
    await writer.recordMessages([alternate]);
    await writer.flush();

    const alternateEntry = (await readJsonl(filePath)).find(
      (entry) => entry['uuid'] === alternate.uuid,
    );
    expect(alternateEntry).toMatchObject({
      uuid: alternate.uuid,
      parentUuid: user.uuid,
    });
  });

  it.each(['adopt', 'hint', 'rewind', 'empty-rewind'] as const)(
    'preserves an explicit %s selection across a repeated prefix',
    async (selection) => {
      const { writer, filePath, store } = await createWriter();
      try {
        const user = makeUserMessage('original question');
        const oldAnswer = makeAssistantMessage('old branch');
        const alternate = makeAssistantMessage('selected branch');
        await writer.recordMessages([user, oldAnswer]);
        const parent = selection === 'empty-rewind' ? null : user.uuid;
        if (selection === 'adopt') {
          writer.adoptMainParentUuid(parent);
        } else if (selection !== 'hint') {
          await writer.recordActiveLeaf(parent, {
            explicit: true,
            rewound: true,
            durable: true,
          });
        }
        await writer.recordMessages(
          [user, oldAnswer, alternate],
          selection === 'hint' ? parent : undefined,
        );
        await writer.flush();
        const entries = await readJsonl(filePath);
        expect(
          entries.find((entry) => entry['uuid'] === alternate.uuid),
        ).toMatchObject({ parentUuid: parent });
        const restored = await new TranscriptRepository().resolveSession(
          filePath,
        );
        expect(restored?.leafUuid).toBe(alternate.uuid);
        expect(restored?.messages.map((message) => message.uuid)).toEqual(
          selection === 'empty-rewind'
            ? [alternate.uuid]
            : [user.uuid, alternate.uuid],
        );
      } finally {
        await writer.close();
        await store.close();
      }
    },
  );

  it('writes sidechain transcript messages with agent identity', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('delegate');
    const assistant = makeAssistantMessage('done');

    const lastUuid = await writer.recordSidechainMessages(
      [user, assistant],
      'agent-123',
    );

    expect(lastUuid).toBe(assistant.uuid);

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      type: 'user',
      isSidechain: true,
      agentId: 'agent-123',
      parentUuid: null,
    });
    expect(entries[1]).toMatchObject({
      type: 'assistant',
      isSidechain: true,
      agentId: 'agent-123',
      parentUuid: user.uuid,
    });
    expect(entries[2]).toMatchObject({
      type: 'last-prompt',
      lastPrompt: 'delegate',
    });
  });

  it('buffers non-terminal assistant fragments until the terminal assistant arrives', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const thinking = makeAssistantFragment(
      [{ type: 'thinking', thinking: 'working', signature: '' }],
      undefined,
    );
    const finalAssistant = makeAssistantFragment(
      [{ type: 'text', text: 'done' }],
      'end_turn',
    );

    let parentUuid = await writer.recordMessages([user]);
    parentUuid = await writer.recordMessages([thinking], parentUuid);
    expect(parentUuid).toBe(user.uuid);
    expect(await writer.recordMessages([finalAssistant], parentUuid)).toBe(
      finalAssistant.uuid,
    );

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries.map((entry) => entry['type'])).toEqual([
      'user',
      'active-leaf',
      'assistant',
      'assistant',
      'active-leaf',
      'last-prompt',
      'active-leaf',
    ]);
    expect(entries[2]).toMatchObject({
      type: 'assistant',
      uuid: thinking.uuid,
      parentUuid: user.uuid,
      message: expect.objectContaining({ stop_reason: null }),
    });
    expect(entries[3]).toMatchObject({
      type: 'assistant',
      uuid: finalAssistant.uuid,
      parentUuid: thinking.uuid,
      message: expect.objectContaining({ stop_reason: 'end_turn' }),
    });
  });

  it('buffers non-terminal assistant fragments across cumulative transcript snapshots', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const thinking = makeAssistantFragment(
      [{ type: 'thinking', thinking: 'working', signature: '' }],
      undefined,
    );
    const finalAssistant = makeAssistantFragment(
      [{ type: 'text', text: 'done' }],
      'end_turn',
    );

    await writer.recordMessages([user]);
    expect(await writer.recordMessages([user, thinking])).toBe(user.uuid);
    expect(await writer.recordMessages([user, thinking, finalAssistant])).toBe(
      finalAssistant.uuid,
    );

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries.map((entry) => entry['uuid']).filter(Boolean)).toEqual([
      user.uuid,
      thinking.uuid,
      finalAssistant.uuid,
    ]);
    expect(
      entries.find((entry) => entry['uuid'] === thinking.uuid),
    ).toMatchObject({
      uuid: thinking.uuid,
      parentUuid: user.uuid,
    });
    expect(
      entries.find((entry) => entry['uuid'] === finalAssistant.uuid),
    ).toMatchObject({
      uuid: finalAssistant.uuid,
      parentUuid: thinking.uuid,
    });
  });

  it('does not persist trailing non-terminal assistant fragments on flush', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const thinking = makeAssistantFragment(
      [{ type: 'thinking', thinking: 'still working', signature: '' }],
      undefined,
    );

    let parentUuid = await writer.recordMessages([user]);
    parentUuid = await writer.recordMessages([thinking], parentUuid);
    expect(parentUuid).toBe(user.uuid);
    await writer.flush();

    const entries = await readJsonl(filePath);
    expect(entries.map((entry) => entry['type'])).toEqual([
      'user',
      'active-leaf',
      'last-prompt',
      'active-leaf',
    ]);
    expect(entries.some((entry) => entry['uuid'] === thinking.uuid)).toBe(
      false,
    );
  });

  it('drops buffered non-terminal assistant fragments when a non-assistant message continues the chain', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const thinking = makeAssistantFragment(
      [{ type: 'thinking', thinking: 'interrupted', signature: '' }],
      undefined,
    );
    const interruption = makeUserMessage('new prompt');

    let parentUuid = await writer.recordMessages([user]);
    parentUuid = await writer.recordMessages([thinking], parentUuid);
    expect(await writer.recordMessages([interruption], parentUuid)).toBe(
      interruption.uuid,
    );

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries.map((entry) => entry['type'])).toEqual([
      'user',
      'active-leaf',
      'user',
      'active-leaf',
      'last-prompt',
      'active-leaf',
    ]);
    expect(entries.some((entry) => entry['uuid'] === thinking.uuid)).toBe(
      false,
    );
    expect(entries[2]).toMatchObject({
      uuid: interruption.uuid,
      parentUuid: user.uuid,
    });
  });

  it.each([false, true])(
    'persists interrupted text without tools when the error notice arrives (aborted=%s)',
    async (aborted) => {
      const { writer, filePath, store } = await createWriter();
      const user = makeUserMessage('hello');
      const retained = makeAssistantFragment(
        [{ type: 'text', text: 'partial answer', citations: null }],
        null,
      );
      retained.partialStreamIndex = 0;
      if (aborted) retained.aborted = true;
      const notice = createAssistantAPIErrorMessage({
        content: 'Model response interrupted.',
      });

      let parentUuid = await writer.recordMessages([user]);
      parentUuid = await writer.recordMessages([retained], parentUuid);
      expect(parentUuid).toBe(user.uuid);
      expect(await writer.recordMessages([notice], parentUuid)).toBe(notice.uuid);
      await writer.close();
      await store.close();

      const entries = await readJsonl(filePath);
      expect(
        entries.find((entry) => entry['uuid'] === retained.uuid),
      ).toMatchObject({
        parentUuid: user.uuid,
        message: { stop_reason: null, content: retained.message.content },
      });
      expect(
        entries.find((entry) => entry['uuid'] === retained.uuid)?.['aborted'],
      ).toBe(aborted ? true : undefined);
      expect(
        entries.find((entry) => entry['uuid'] === notice.uuid),
      ).toMatchObject({
        parentUuid: retained.uuid,
        isApiErrorMessage: true,
      });
      const restored = await new TranscriptRepository().resolveSession(filePath);
      expect(restored?.messages.map((message) => message.uuid)).toEqual([
        user.uuid,
        retained.uuid,
        notice.uuid,
      ]);
    },
  );

  it('persists the stream recovery placeholder before its paired tool result', async () => {
    const { writer, filePath, store } = await createWriter();
    const user = makeUserMessage('hello');
    const retained = makeAssistantFragment(
      [{ type: 'text', text: 'partial answer', citations: null }],
      null,
    );
    retained.partialStreamIndex = 0;
    const notice = createAssistantAPIErrorMessage({
      content: 'Model response interrupted.',
    });
    const placeholder = makeAssistantFragment(
      [{ type: 'tool_use', id: 'unfinished', name: 'Write', input: {} }],
      'tool_use',
    );
    delete placeholder.message.usage;
    const paired = createToolResultMessage(
      [
        {
          type: 'tool_result',
          tool_use_id: 'unfinished',
          content: 'not executed',
          is_error: true,
        },
      ],
      placeholder.uuid,
    );
    const reminder = makeAttachmentMessage();

    let parentUuid = await writer.recordMessages([user]);
    for (const message of [retained, notice, placeholder, paired, reminder]) {
      parentUuid = await writer.recordMessages([message], parentUuid);
    }
    await writer.close();
    await store.close();

    const entries = await readJsonl(filePath);
    const byUuid = new Map(
      entries
        .filter((entry) => 'uuid' in entry)
        .map((entry) => [entry['uuid'] as string, entry]),
    );
    expect([...byUuid.keys()]).toEqual([
      user.uuid,
      retained.uuid,
      notice.uuid,
      placeholder.uuid,
      paired.uuid,
      reminder.uuid,
    ]);
    expect(byUuid.get(paired.uuid)).toMatchObject({
      parentUuid: placeholder.uuid,
    });
    for (const entry of byUuid.values()) {
      const parent = entry['parentUuid'];
      if (parent != null) expect(byUuid.has(parent as string)).toBe(true);
    }
  });

  it('clears buffered assistant fragments when a tombstone targets them', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    const thinking = makeAssistantFragment(
      [{ type: 'thinking', thinking: 'fallback attempt', signature: '' }],
      undefined,
    );
    const tombstone: TombstoneMessage = {
      type: 'tombstone',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: thinking,
    };
    const finalAssistant = makeAssistantFragment(
      [{ type: 'text', text: 'fallback done' }],
      'end_turn',
    );

    let parentUuid = await writer.recordMessages([user]);
    parentUuid = await writer.recordMessages([thinking], parentUuid);
    parentUuid = await writer.recordMessages([tombstone], parentUuid);
    expect(parentUuid).toBe(user.uuid);
    await writer.recordMessages([finalAssistant], parentUuid);

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries.map((entry) => entry['type'])).toEqual([
      'user',
      'active-leaf',
      'assistant',
      'active-leaf',
      'last-prompt',
      'active-leaf',
    ]);
    expect(entries.some((entry) => entry['uuid'] === thinking.uuid)).toBe(
      false,
    );
    expect(entries[2]).toMatchObject({
      uuid: finalAssistant.uuid,
      parentUuid: user.uuid,
    });
  });

  it('does not rewrite workspace metadata when adopting an existing transcript', async () => {
    const { filePath } = await createWriter();
    const user = makeUserMessage('hello');
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          type: 'workspace-directories',
          sessionId: 'session-1',
          directories: ['/workspace/project'],
        }),
        JSON.stringify({
          ...user,
          parentUuid: null,
          isSidechain: false,
          cwd: '/workspace/project',
          sessionId: 'session-1',
          userType: 'external',
          entrypoint: 'cli',
          version: '1.2.3',
          gitBranch: 'feat/test',
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      gitBranch: 'feat/test',
      flushIntervalMs: 0,
      initialWorkspaceDirectories: ['/workspace/project'],
    });

    await writer.flush();

    expect(await readJsonl(filePath)).toHaveLength(2);

    await writer.reAppendSessionMetadata();
    const entries = await readJsonl(filePath);
    expect(entries).toHaveLength(3);
    expect(entries[2]).toMatchObject({
      type: 'workspace-directories',
      sessionId: 'session-1',
      directories: ['/workspace/project'],
    });
  });

  it('records runtime config metadata and keeps the latest snapshot cached', async () => {
    const { writer, filePath } = await createWriter();
    await writer.recordRuntimeConfig({
      model: 'model-a',
      reasoningEffort: null,
      contextWindow: 256000,
    });
    await writer.recordMessages([makeUserMessage('hello')]);
    await writer.recordRuntimeConfig({
      model: 'model-a',
      reasoningEffort: 'high',
      contextWindow: null,
    });
    await writer.flush();

    const entries = await readJsonl(filePath);
    const runtimeEntries = entries.filter(
      (entry) => entry['type'] === 'runtime-config',
    );
    expect(runtimeEntries.length).toBeGreaterThanOrEqual(2);
    expect(runtimeEntries[0]).toMatchObject({
      type: 'runtime-config',
      sessionId: 'session-1',
      model: 'model-a',
      reasoningEffort: null,
      contextWindow: 256000,
    });
    expect(runtimeEntries.at(-1)).toMatchObject({
      type: 'runtime-config',
      sessionId: 'session-1',
      model: 'model-a',
      reasoningEffort: 'high',
      contextWindow: null,
    });
  });

  it('re-stamps transcript timestamp at write time', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    user.timestamp = '2020-01-01T00:00:00.000Z';

    await writer.recordMessages([user]);

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries).toHaveLength(4);
    expect(entries[0]?.['timestamp']).not.toBe('2020-01-01T00:00:00.000Z');
    expect(entries[0]).toMatchObject({
      entrypoint: 'cli',
      gitBranch: 'feat/test',
      version: '1.2.3',
    });
    expect(entries[2]).toMatchObject({
      type: 'last-prompt',
      lastPrompt: 'hello',
    });
  });

  it('does not replace last prompt metadata with command-style prompts', async () => {
    const { writer, filePath } = await createWriter();
    const taskPrompt = makeUserMessage('implement auth flow');
    const assistant = makeAssistantMessage('working on it');
    const resumeCommand = makeUserMessage('/resume');

    await writer.recordMessages([taskPrompt, assistant]);
    await writer.recordMessages([resumeCommand]);

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries.map((entry) => entry['type'])).toEqual([
      'user',
      'assistant',
      'active-leaf',
      'last-prompt',
      'active-leaf',
      'user',
      'active-leaf',
      'last-prompt',
      'active-leaf',
    ]);
    expect(
      entries.filter((entry) => entry['type'] === 'last-prompt').at(-1),
    ).toMatchObject({
      type: 'last-prompt',
      lastPrompt: 'implement auth flow',
    });
  });

  it('re-stamps session fields when replaying messages from another session', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');
    user.sessionId = 'source-session';
    user.cwd = '/other/project';
    user.userType = 'source-user';
    user.entrypoint = 'sdk';
    user.version = '9.9.9';
    user.gitBranch = 'source-branch';

    await writer.recordMessages([user]);

    const [entry] = await readJsonl(filePath);
    expect(entry).toMatchObject({
      sessionId: 'session-1',
      cwd: '/workspace/project',
      userType: 'external',
      entrypoint: 'cli',
      version: '1.2.3',
      gitBranch: 'feat/test',
    });
  });

  it('can restore known UUIDs before continuing a transcript', async () => {
    const { writer, filePath, store } = await createWriter();
    const user = makeUserMessage('hello');

    await writer.recordMessages([user]);
    await writer.close();

    const nextWriter = await store.acquireSessionWriter({
      filePath,
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
    });

    const assistant = makeAssistantMessage('world');
    await nextWriter.recordMessages([user, assistant]);

    await nextWriter.flush();
    const entries = await readJsonl(filePath);
    expect(entries.filter((entry) => 'uuid' in entry)).toHaveLength(2);
    expect(
      entries.find((entry) => entry['uuid'] === assistant.uuid),
    ).toMatchObject({
      type: 'assistant',
      parentUuid: user.uuid,
    });
  });

  it('appends metadata entries and re-appends refreshed title/tag state', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');

    await writer.recordMessages([user]);
    await writer.recordLastPrompt('draft prompt');
    await writer.recordCustomTitle('Old title');
    await writer.recordTag('old-tag');
    await writer.recordWorkspaceDirectories([
      '/workspace/project',
      '/workspace/lib',
    ]);
    await writer.recordAiTitle('AI title');

    await fs.appendFile(
      filePath,
      `${JSON.stringify({
        type: 'custom-title',
        sessionId: 'session-1',
        customTitle: 'Fresh title',
      })}\n`,
      'utf8',
    );
    await fs.appendFile(
      filePath,
      `${JSON.stringify({
        type: 'tag',
        sessionId: 'session-1',
        tag: 'fresh-tag',
      })}\n`,
      'utf8',
    );
    await fs.appendFile(
      filePath,
      `${JSON.stringify({
        type: 'workspace-directories',
        sessionId: 'session-1',
        directories: ['/workspace/project', '/workspace/updated-lib'],
      })}\n`,
      'utf8',
    );

    await writer.reAppendSessionMetadata();
    await writer.flush();

    const entries = await readJsonl(filePath);

    expect(entries.map((entry) => entry['type'])).toEqual([
      'user',
      'active-leaf',
      'last-prompt',
      'custom-title',
      'tag',
      'workspace-directories',
      'ai-title',
      'custom-title',
      'tag',
      'workspace-directories',
      'last-prompt',
      'custom-title',
      'ai-title',
      'tag',
      'workspace-directories',
      'active-leaf',
    ]);
    expect(entries.at(-6)).toMatchObject({
      type: 'last-prompt',
      lastPrompt: 'draft prompt',
    });
    expect(entries.at(-5)).toMatchObject({
      type: 'custom-title',
      customTitle: 'Fresh title',
    });
    expect(entries.at(-4)).toMatchObject({
      type: 'ai-title',
      aiTitle: 'AI title',
    });
    expect(entries.at(-3)).toMatchObject({
      type: 'tag',
      tag: 'fresh-tag',
    });
    expect(entries.at(-2)).toMatchObject({
      type: 'workspace-directories',
      directories: ['/workspace/project', '/workspace/updated-lib'],
    });
    expect(entries.at(-1)).toMatchObject({
      type: 'active-leaf',
      leafUuid: user.uuid,
    });
  });

  it('does not materialize a transcript file for metadata-only sessions', async () => {
    const { writer, filePath } = await createWriter();

    await writer.recordWorkspaceDirectories([
      '/workspace/project',
      '/workspace/extra',
    ]);
    await writer.recordCustomTitle('Draft title');
    await writer.close();

    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not materialize an initial null worktree state when closed before the first message', async () => {
    const { writer, filePath } = await createWriter();

    await writer.recordWorktreeState(null);
    await writer.recordWorkspaceDirectories(['/workspace/project']);
    await writer.close();

    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('flushes cached workspace directories when the first user message materializes the transcript', async () => {
    const { writer, filePath } = await createWriter();
    const user = makeUserMessage('hello');

    await writer.recordWorkspaceDirectories([
      '/workspace/project',
      '/workspace/extra',
    ]);
    await writer.recordMessages([user]);

    await writer.flush();
    const entries = await readJsonl(filePath);
    expect(entries).toEqual([
      {
        type: 'workspace-directories',
        sessionId: 'session-1',
        directories: ['/workspace/project', '/workspace/extra'],
      },
      expect.objectContaining({
        type: 'user',
        uuid: user.uuid,
      }),
      expect.objectContaining({
        type: 'active-leaf',
        leafUuid: user.uuid,
        explicit: false,
      }),
      {
        type: 'last-prompt',
        sessionId: 'session-1',
        lastPrompt: 'hello',
      },
      {
        type: 'workspace-directories',
        sessionId: 'session-1',
        directories: ['/workspace/project', '/workspace/extra'],
      },
      expect.objectContaining({
        type: 'active-leaf',
        leafUuid: user.uuid,
        explicit: false,
      }),
    ]);
  });

  it('retains startup metadata when first materialization fails with ENOENT', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-writer-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'session.jsonl');
    const missingPathError = Object.assign(
      new Error('transcript unavailable'),
      {
        code: 'ENOENT',
      },
    );
    let failOpen = true;
    const channel = new AppendChannel({
      filePath,
      flushIntervalMs: 0,
      fileSystem: {
        ...nodeTranscriptFileSystem,
        open: async (targetPath, flags, mode) => {
          if (failOpen) throw missingPathError;
          return nodeTranscriptFileSystem.open(targetPath, flags, mode);
        },
      },
    });
    const writer = new SessionTranscriptWriter({
      channel: {
        filePath,
        append: channel.append.bind(channel),
        barrier: channel.barrier.bind(channel),
        flush: channel.flush.bind(channel),
        withExclusiveRead: channel.withExclusiveRead.bind(channel),
        readTail: channel.readTail.bind(channel),
        readAll: channel.readAll.bind(channel),
        release: channel.close.bind(channel),
      },
      sessionId: 'session-1',
      cwd: '/workspace/project',
      entrypoint: 'cli',
    });
    await writer.recordWorkspaceDirectories(['/workspace/project']);
    await writer.recordSummary('startup-leaf', 'buffered startup summary');
    const user = makeUserMessage('hello');

    await expect(writer.recordMessages([user])).rejects.toBe(missingPathError);
    failOpen = false;
    await writer.recordMessages([user]);
    await writer.close();

    const entries = await readJsonl(filePath);
    expect(entries.slice(0, 3)).toEqual([
      {
        type: 'workspace-directories',
        sessionId: 'session-1',
        directories: ['/workspace/project'],
      },
      {
        type: 'summary',
        leafUuid: 'startup-leaf',
        summary: 'buffered startup summary',
      },
      expect.objectContaining({
        type: 'user',
        uuid: user.uuid,
        parentUuid: null,
      }),
    ]);
    expect(entries.filter((entry) => entry['uuid'] === user.uuid)).toHaveLength(
      1,
    );
    expect(entries.filter((entry) => entry['type'] === 'summary')).toHaveLength(
      1,
    );
  });
});

describe('recordMessages immediate', () => {
  it('immediate 在 60s 批量间隔下仍立即落盘：首条（materialize）与后续（append）都不等定时器', async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'transcript-immediate-'),
    );
    tempDirs.push(dir);
    const filePath = path.join(dir, 'session.jsonl');
    const { writer } = await createTestTranscriptWriter({
      filePath,
      sessionId: 'session-immediate',
      cwd: '/workspace/project',
      entrypoint: 'cli',
      version: '1.2.3',
      gitBranch: 'feat/test',
      flushIntervalMs: 60_000,
    });

    const withinBudget = async (promise: Promise<unknown>) =>
      Promise.race([
        promise.then(() => 'done' as const),
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 1_000),
        ),
      ]);

    // 第一条走 materializeTranscript，第二条走 writeOrBuffer 的已物化分支；
    // 批量间隔被钉到 60s，若任一分支仍等定时器，这里必然得到 timeout。
    await expect(
      withinBudget(
        writer.recordMessages([makeUserMessage('first')], null, {
          immediate: true,
        }),
      ),
    ).resolves.toBe('done');
    await expect(
      withinBudget(
        writer.recordMessages([makeUserMessage('second')], null, {
          immediate: true,
        }),
      ),
    ).resolves.toBe('done');

    expect((await readJsonl(filePath)).length).toBeGreaterThanOrEqual(2);
    await writer.close();
  });
});
