/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActiveLeafEntry,
  TranscriptMessage,
} from '../../protocol/transcript/entry.js';
import type {
  AssistantMessage,
  SystemMessage,
  UserMessage,
} from '../../protocol/transcript/message.js';
import {
  TranscriptStore,
  type AcquireSessionWriterOptions,
  type SessionWriterStateSource,
} from './store.js';
import {
  TranscriptRepository,
  createBoundedResumeReadState,
} from './repository.js';
import {
  beginResumeRead,
  type ResumeReadAttempt,
} from './resume-read-budget.js';
import { SessionTranscriptWriter } from './session-writer.js';
import { EntryScanner } from './scanner.js';
import {
  createSessionResumeWriterBinding,
  type SessionResumeData,
} from '../sessionResumeData.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const tempDirs: string[] = [];
const resumeAttempts: ResumeReadAttempt[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const attempt of resumeAttempts.splice(0)) attempt.finish();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function user(uuid: string, content: string): UserMessage {
  return {
    type: 'user',
    uuid,
    timestamp: '2026-07-10T00:00:00.000Z',
    message: { role: 'user', content },
  };
}

function assistant(uuid: string, content: string): AssistantMessage {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-07-10T00:00:01.000Z',
    message: {
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      id: `provider-${uuid}`,

      model: 'test-model',
      content: [{ type: 'text', text: content }],
      stop_reason: 'end_turn',
    },
  };
}

function persisted(
  message: UserMessage | AssistantMessage,
  parentUuid: string | null,
): TranscriptMessage {
  return {
    ...message,
    parentUuid,
    isSidechain: false,
    cwd: '/workspace/project',
    sessionId: 'session-1',
    userType: 'external',
    version: '1.0.0',
  };
}

async function createOptions(): Promise<AcquireSessionWriterOptions> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'transcript-store-'));
  tempDirs.push(root);
  return {
    filePath: path.join(root, 'session.jsonl'),
    sessionId: 'session-1',
    cwd: '/workspace/project',
    entrypoint: 'cli',
    version: '1.0.0',
  };
}

function emptyStateSource(onLoad?: () => void): SessionWriterStateSource {
  return {
    loadSessionWriterState: async () => {
      onLoad?.();
      return { messageUuids: [] };
    },
  };
}

async function createResumeFixture(
  entries: readonly TranscriptMessage[] = [
    persisted(user('first', 'first'), null),
  ],
) {
  const options = await createOptions();
  await fs.writeFile(
    options.filePath,
    entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
  );
  const repository = new TranscriptRepository();
  const loaded = (await repository.resolveSession(options.filePath))!;
  const data: SessionResumeData = {
    sessionId: options.sessionId,
    sessionPath: options.filePath,
    messages: [...loaded.messages],
    transcriptReadState: repository.createResumeReadState(
      loaded,
      options.sessionId,
    ),
  };
  return { options, data };
}

async function startAttempt(): Promise<ResumeReadAttempt> {
  const attempt = await beginResumeRead();
  resumeAttempts.push(attempt);
  return attempt;
}

async function createColdResumeFixture() {
  const fixture = await createResumeFixture();
  const attempt = await startAttempt();
  const repository = new TranscriptRepository();
  const loaded = (await repository.readForResume(fixture.options.filePath, {
    sessionId: fixture.options.sessionId,
    attempt,
  }))!;
  const data: SessionResumeData = {
    ...fixture.data,
    messages: [...loaded.messages],
    transcriptReadState: createBoundedResumeReadState(loaded),
    resumeAttempt: attempt,
  };
  return { options: fixture.options, data, attempt };
}

it.each([false, true])(
  'rejects cold reuse without touching an advanced writer (seed: %s)',
  async (hasSeed) => {
    const { options, data } = await createResumeFixture();
    const store = new TranscriptStore();
    const active = await store.acquireSessionWriter({
      ...options,
      resume: createSessionResumeWriterBinding(data, options.cwd),
    });
    await active.recordMessages([user('advanced', 'advanced')]);
    const attempt = await startAttempt();
    const before = await fs.readFile(options.filePath, 'utf8');
    try {
      await expect(
        store.acquireSessionWriter({
          ...options,
          coldResume: { attempt },
          ...(hasSeed
            ? { resume: createSessionResumeWriterBinding(data, options.cwd) }
            : {}),
        }),
      ).rejects.toMatchObject({ reason: 'conflict' });
      expect(data.messages.map(({ uuid }) => uuid)).toEqual(['first']);
      expect(await fs.readFile(options.filePath, 'utf8')).toBe(before);
      // 普通 fork/旧种子不带冷恢复意图，仍可复用活跃 Writer。
      const reused = await store.acquireSessionWriter({
        ...options,
        resume: createSessionResumeWriterBinding(data, options.cwd),
      });
      await active.close();
      expect(reused.hasMessageUuid('advanced')).toBe(true);
      await reused.recordMessages([user('next', 'next')]);
      await reused.close();
      expect((await readMessageEntries(options.filePath)).at(-1)).toMatchObject(
        {
          uuid: 'next',
          parentUuid: 'advanced',
        },
      );
    } finally {
      attempt.finish();
      await active.close();
      await store.close();
    }
  },
);

it('rejects cold acquisition during another writer initialization without waiting for it', async () => {
  const options = await createOptions();
  let releaseLoad!: () => void;
  let started!: () => void;
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve;
  });
  const store = new TranscriptStore({
    stateSource: {
      loadSessionWriterState: async () => {
        started();
        await loadGate;
        return { messageUuids: [] };
      },
    },
  });
  const opening = store.acquireSessionWriter(options);
  await loading;
  const attempt = await startAttempt();
  try {
    await expect(
      store.acquireSessionWriter({
        ...options,
        coldResume: { attempt },
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });
    releaseLoad();
    const active = await opening;
    const reused = await store.acquireSessionWriter(options);
    await active.close();
    await reused.recordMessages([user('accepted', 'accepted')]);
    await reused.close();
    expect(await readMessageEntries(options.filePath)).toMatchObject([
      { uuid: 'accepted', parentUuid: null },
    ]);
  } finally {
    releaseLoad();
    attempt.finish();
    await store.close();
  }
});

it('rejects cold acquisition while another writer closes without taking over its lifecycle', async () => {
  const options = await createOptions();
  const store = new TranscriptStore({ stateSource: emptyStateSource() });
  const active = await store.acquireSessionWriter(options);
  await active.recordMessages([user('first', 'first')]);
  let releaseClose!: () => void;
  let started!: () => void;
  const closing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const originalClose = SessionTranscriptWriter.prototype.close;
  const close = vi
    .spyOn(SessionTranscriptWriter.prototype, 'close')
    .mockImplementation(async function (this: SessionTranscriptWriter) {
      started();
      await closeGate;
      await originalClose.call(this);
    });
  const shutdown = active.close();
  await closing;
  const attempt = await startAttempt();
  try {
    await expect(
      store.acquireSessionWriter({
        ...options,
        coldResume: { attempt },
      }),
    ).rejects.toMatchObject({ reason: 'conflict' });
    releaseClose();
    await shutdown;
    close.mockRestore();
    const reopened = await store.acquireSessionWriter(options);
    await reopened.close();
  } finally {
    releaseClose();
    attempt.finish();
    await shutdown;
    close.mockRestore();
    await store.close();
  }
});

it('reads a missing cold seed through the bounded repository rather than the ordinary state source', async () => {
  const { options } = await createResumeFixture();
  const attempt = await startAttempt();
  const stateSource = emptyStateSource(() => {
    throw new Error('unbounded fallback');
  });
  const store = new TranscriptStore({ stateSource });
  const reads = vi.spyOn(store.repository(), 'readForResume');
  const fullReads = vi.spyOn(store.repository(), 'resolveSession');
  try {
    const writer = await store.acquireSessionWriter({
      ...options,
      coldResume: { attempt },
    });
    expect(writer.hasMessageUuid('first')).toBe(true);
    expect(fullReads).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledWith(
      await fs.realpath(options.filePath),
      expect.objectContaining({ attempt }),
    );
    await writer.close();
  } finally {
    attempt.finish();
    await store.close();
  }
});

it('does not turn a disappeared unseeded transcript into an empty writer and releases its owned attempt', async () => {
  const { options } = await createResumeFixture();
  const store = new TranscriptStore();
  const repository = store.repository();
  const originalRead = repository.readForResume.bind(repository);
  vi.spyOn(repository, 'readForResume').mockImplementation(async (...args) => {
    const result = await originalRead(...args);
    if (result) await fs.rm(options.filePath);
    return result;
  });
  try {
    await expect(store.acquireSessionWriter(options)).rejects.toMatchObject({
      reason: 'snapshot',
    });
    await expect(fs.access(options.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const nextAttempt = await startAttempt();
    nextAttempt.check();
    nextAttempt.finish();
  } finally {
    await store.close();
  }
});

it('rereads an invalidated seed with the same admission while another attempt waits', async () => {
  const { options, data, attempt } = await createColdResumeFixture();
  await fs.appendFile(
    options.filePath,
    JSON.stringify(persisted(user('concurrent', 'concurrent'), 'first')) + '\n',
  );
  let admitted = false;
  const waiting = beginResumeRead().then((next) => {
    resumeAttempts.push(next);
    admitted = true;
    return next;
  });
  const store = new TranscriptStore();
  const reads = vi.spyOn(store.repository(), 'readForResume');
  try {
    const messages = data.messages;
    const writer = await store.acquireSessionWriter({
      ...options,
      coldResume: { attempt },
      resume: createSessionResumeWriterBinding(data, options.cwd),
    });
    expect(admitted).toBe(false);
    expect(data.messages).toBe(messages);
    expect(messages.map(({ uuid }) => uuid)).toEqual(['first', 'concurrent']);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledWith(
      await fs.realpath(options.filePath),
      expect.objectContaining({ attempt }),
    );
    attempt.finish();
    const nextAttempt = await waiting;
    nextAttempt.check();
    nextAttempt.finish();
    await writer.recordMessages([user('next', 'next')]);
    await writer.close();
    expect(
      (await readMessageEntries(options.filePath)).at(-1)?.parentUuid,
    ).toBe('concurrent');
  } finally {
    attempt.finish();
    (await waiting).finish();
    await store.close();
  }
});

it('fails final validation without publishing prepared data and releases a waiting attempt', async () => {
  const { options, data, attempt } = await createColdResumeFixture();
  await fs.appendFile(
    options.filePath,
    JSON.stringify(persisted(user('concurrent', 'concurrent'), 'first')) + '\n',
  );
  const messages = data.messages;
  const oldState = data.transcriptReadState;
  const binding = createSessionResumeWriterBinding(data, options.cwd)!;
  const waiting = beginResumeRead().then((next) => {
    resumeAttempts.push(next);
    return next;
  });
  const store = new TranscriptStore();
  const reads = vi.spyOn(store.repository(), 'readForResume');
  try {
    await expect(
      store.acquireSessionWriter({
        ...options,
        coldResume: { attempt },
        resume: {
          state: binding.state,
          onRefresh: async (fresh, state) => {
            const commit = await binding.onRefresh(fresh, state);
            await fs.appendFile(options.filePath, '\n');
            return commit;
          },
        },
      }),
    ).rejects.toMatchObject({ reason: 'snapshot' });
    expect(reads).toHaveBeenCalledTimes(1);
    expect(data.messages).toBe(messages);
    expect(messages.map(({ uuid }) => uuid)).toEqual(['first']);
    expect(data.transcriptReadState).toBe(oldState);
    expect(await readMessageEntries(options.filePath)).toMatchObject([
      { uuid: 'first' },
      { uuid: 'concurrent' },
    ]);
    expect(
      (await fs.readFile(options.filePath, 'utf8')).trim().split('\n'),
    ).toHaveLength(2);
    attempt.finish();
    (await waiting).finish();
  } finally {
    attempt.finish();
    (await waiting).finish();
    await store.close();
  }
});

it('reuses a resume read while the unchanged transcript stays open for reading', async () => {
  const { options, data } = await createResumeFixture();
  const reader = await fs.open(options.filePath, 'r');
  const originalContent = await reader.readFile('utf8');
  const scans = vi.spyOn(EntryScanner.prototype, 'scan');
  const store = new TranscriptStore();
  try {
    const writer = await store.acquireSessionWriter({
      ...options,
      resume: {
        state: data.transcriptReadState!,
        onRefresh: () => () => undefined,
      },
    });
    // 完整解码次数是本次优化的性能契约；后续写入仍需保留历史 UUID 去重和 parent。
    expect(scans).not.toHaveBeenCalled();
    expect(writer.hasMessageUuid('first')).toBe(true);
    expect(await fs.readFile(options.filePath, 'utf8')).toBe(originalContent);
    await writer.recordMessages([user('first', 'first'), user('next', 'next')]);
    await writer.close();
    expect(await readMessageEntries(options.filePath)).toMatchObject([
      { type: 'user', uuid: 'first', parentUuid: null },
      { type: 'user', uuid: 'next', parentUuid: 'first' },
    ]);
  } finally {
    await reader.close();
    await store.close();
  }
});

it.each([false, true])(
  'resumes an open transcript when path and descriptor stats report different devices (file changed: %s)',
  async (fileChanged) => {
    const { options, data } = await createResumeFixture();
    const reader = await fs.open(options.filePath, 'r');
    if (fileChanged) {
      await fs.appendFile(
        options.filePath,
        JSON.stringify(persisted(user('concurrent', 'concurrent'), 'first')) +
          '\n',
      );
    }
    const actualFs = await vi.importActual<typeof fs>('node:fs/promises');
    // Windows path stat and descriptor stat can expose different volume IDs.
    vi.mocked(fs.stat).mockImplementation(async (...args) => {
      const stat = await actualFs.stat(...args);
      stat.dev = stat.dev === 0 ? 1 : 0;
      return stat;
    });
    const store = new TranscriptStore();
    try {
      const writer = await store.acquireSessionWriter({
        ...options,
        resume: createSessionResumeWriterBinding(data, options.cwd),
      });
      expect(data.messages.map((message) => message.uuid)).toEqual(
        fileChanged ? ['first', 'concurrent'] : ['first'],
      );
      expect(writer.hasMessageUuid('first')).toBe(true);
      expect(writer.hasMessageUuid('concurrent')).toBe(fileChanged);
      await writer.close();
    } finally {
      await reader.close();
      await store.close();
    }
  },
);

it('refreshes the resume projection and writer together when the file changed', async () => {
  const { options, data } = await createResumeFixture();
  await fs.appendFile(
    options.filePath,
    JSON.stringify(persisted(user('concurrent', 'concurrent'), 'first')) + '\n',
  );
  const engineMessages = data.messages;
  const store = new TranscriptStore();
  try {
    const writer = await store.acquireSessionWriter({
      ...options,
      resume: createSessionResumeWriterBinding(data, options.cwd),
    });
    expect(engineMessages.map((message) => message.uuid)).toEqual([
      'first',
      'concurrent',
    ]);
    expect(writer.hasMessageUuid('concurrent')).toBe(true);
    await writer.recordMessages([user('next', 'next')]);
    await writer.close();
    expect(
      (await readMessageEntries(options.filePath)).at(-1)?.parentUuid,
    ).toBe('concurrent');
  } finally {
    await store.close();
  }
});

it('rejects resume while the transcript keeps changing and recovers once writes stop', async () => {
  const { options, data } = await createResumeFixture();
  await fs.appendFile(
    options.filePath,
    JSON.stringify(persisted(user('concurrent', 'concurrent'), 'first')) + '\n',
  );
  const resume = createSessionResumeWriterBinding(data, options.cwd)!;
  const store = new TranscriptStore();
  try {
    await expect(
      store.acquireSessionWriter({
        ...options,
        resume: {
          state: resume.state,
          onRefresh: async (fresh, state) => {
            const commit = await resume.onRefresh(fresh, state);
            // 域外准备后真实追加，使最终快照校验失败；不能半提交旧数据。
            await fs.appendFile(options.filePath, '\n');
            return commit;
          },
        },
      }),
    ).rejects.toMatchObject({ reason: 'snapshot' });
    expect(data.messages.map(({ uuid }) => uuid)).toEqual(['first']);

    const writer = await store.acquireSessionWriter({
      ...options,
      resume: createSessionResumeWriterBinding(data, options.cwd),
    });
    expect(data.messages.map((message) => message.uuid)).toEqual([
      'first',
      'concurrent',
    ]);
    expect(writer.hasMessageUuid('concurrent')).toBe(true);
    await writer.recordMessages([user('next', 'next')]);
    await writer.close();
    expect((await readMessageEntries(options.filePath)).at(-1)).toMatchObject({
      uuid: 'next',
      parentUuid: 'concurrent',
    });
  } finally {
    await store.close();
  }
});

it('reuses the repaired runtime projection while retaining an unresolved tool call as the writer parent', async () => {
  const interrupted = assistant('interrupted', '');
  interrupted.message = {
    ...interrupted.message,
    content: [
      { type: 'tool_use', id: 'pending-read', name: 'Read', input: {} },
    ],
  };
  const { options, data } = await createResumeFixture([
    persisted(user('first', 'first'), null),
    persisted(assistant('reply', 'reply'), 'first'),
    persisted(interrupted, 'reply'),
  ]);
  expect(data.messages.map(({ uuid }) => uuid)).toEqual(['first', 'reply']);
  // 正常恢复过滤未完成工具调用不等于用户主动截断历史。
  expect(
    createSessionResumeWriterBinding(
      { ...data, messages: data.messages.slice(0, 1) },
      options.cwd,
    ),
  ).toBeUndefined();
  const scans = vi.spyOn(EntryScanner.prototype, 'scan');
  const store = new TranscriptStore();
  try {
    const writer = await store.acquireSessionWriter({
      ...options,
      resume: createSessionResumeWriterBinding(data, options.cwd),
    });
    expect(scans).not.toHaveBeenCalled();
    await writer.recordMessages([user('next', 'next')]);
    await writer.close();
    expect((await readMessageEntries(options.filePath)).at(-1)).toMatchObject({
      uuid: 'next',
      parentUuid: 'interrupted',
    });
  } finally {
    await store.close();
  }
});

it('does not reuse a read from a different transcript path, fork, or historical resume point', async () => {
  const { options, data } = await createResumeFixture();
  expect(
    createSessionResumeWriterBinding(
      { ...data, sessionPath: options.filePath + '.other' },
      options.cwd,
    ),
  ).toBeUndefined();
  expect(
    createSessionResumeWriterBinding(
      { ...data, sourceSessionId: 'source' },
      options.cwd,
    ),
  ).toBeUndefined();
  expect(
    createSessionResumeWriterBinding({ ...data, messages: [] }, options.cwd),
  ).toBeUndefined();
});

it('requires reselecting when workspace roots changed after configuration was loaded', async () => {
  const { options, data } = await createResumeFixture();
  await fs.appendFile(
    options.filePath,
    JSON.stringify({
      type: 'workspace-directories',
      sessionId: options.sessionId,
      directories: ['/workspace/added'],
    }) + '\n',
  );
  const store = new TranscriptStore();
  try {
    await expect(
      store.acquireSessionWriter({
        ...options,
        resume: createSessionResumeWriterBinding(data, options.cwd),
      }),
    ).rejects.toThrow('Workspace directories changed during resume');
  } finally {
    await store.close();
  }
});

it.each([false, true])(
  'does not silently resume a cleared conversation (null marker: %s)',
  async (nullMarker) => {
    const { options, data } = await createResumeFixture();
    await fs.writeFile(
      options.filePath,
      nullMarker
        ? JSON.stringify({
            type: 'worktree-state',
            sessionId: options.sessionId,
            worktreeSession: null,
          }) + '\n'
        : '',
    );
    const store = new TranscriptStore();
    try {
      await expect(
        store.acquireSessionWriter({
          ...options,
          resume: createSessionResumeWriterBinding(data, options.cwd),
        }),
      ).rejects.toThrow('The transcript was cleared during resume');
    } finally {
      await store.close();
    }
  },
);

it('persists exit immediately after reopening a worktree-only transcript', async () => {
  const options = await createOptions();
  const store = new TranscriptStore();
  try {
    const initial = await store.acquireSessionWriter(options);
    await initial.recordWorktreeState({
      originalCwd: options.cwd,
      worktreePath: '/workspace/worktree',
      worktreeName: 'feature',
      sessionId: options.sessionId,
      lifecycle: 'owner',
    });
    await initial.close();
    const resumed = await store.acquireSessionWriter(options);
    await resumed.recordWorktreeState(null);
    const index = await new TranscriptRepository().loadIndex(options.filePath);
    expect(index!.metadata.worktreeSessions.get(options.sessionId)).toBeNull();
    await resumed.close();
  } finally {
    await store.close();
  }
});

async function readMessageEntries(filePath: string): Promise<
  Array<{
    type: string;
    uuid: string;
    parentUuid: string | null;
  }>
> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => 'uuid' in entry) as Array<{
    type: string;
    uuid: string;
    parentUuid: string | null;
  }>;
}

describe('TranscriptStore', () => {
  it('shares deduplication and parent state across independent handles', async () => {
    const options = await createOptions();
    let stateLoads = 0;
    const store = new TranscriptStore({
      stateSource: emptyStateSource(() => stateLoads++),
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const [tuiHandle, queryHandle] = await Promise.all([
      store.acquireSessionWriter(options),
      store.acquireSessionWriter(options),
    ]);
    const first = user('00000000-0000-4000-8000-000000000001', 'question');
    const second = assistant('00000000-0000-4000-8000-000000000002', 'answer');

    await tuiHandle.recordMessages([first]);
    await queryHandle.recordMessages([first]);
    await queryHandle.recordMessages([second]);
    await Promise.all([tuiHandle.close(), queryHandle.close()]);

    expect(stateLoads).toBe(1);
    expect(await readMessageEntries(options.filePath)).toEqual([
      expect.objectContaining({ uuid: first.uuid, parentUuid: null }),
      expect.objectContaining({ uuid: second.uuid, parentUuid: first.uuid }),
    ]);
    await store.close();
  });

  it('keeps the shared writer active when one handle closes', async () => {
    const options = await createOptions();
    const store = new TranscriptStore({ stateSource: emptyStateSource() });
    const firstHandle = await store.acquireSessionWriter(options);
    const secondHandle = await store.acquireSessionWriter(options);

    await firstHandle.close();
    expect(() =>
      firstHandle.recordMessages([
        user('00000000-0000-4000-8000-000000000003', 'rejected'),
      ]),
    ).toThrow('TranscriptWriterHandle is closed');
    await secondHandle.recordMessages([
      user('00000000-0000-4000-8000-000000000004', 'accepted'),
    ]);
    await secondHandle.close();

    expect(await readMessageEntries(options.filePath)).toMatchObject([
      { uuid: '00000000-0000-4000-8000-000000000004' },
    ]);
    await store.close();
  });

  it('hydrates pre-compact UUIDs that are absent from the resumed message projection', async () => {
    const options = await createOptions();
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    const preCompactUser = user(
      '00000000-0000-4000-8000-000000000007',
      `old question ${'x'.repeat(5 * 1024 * 1024)}`,
    );
    const compactBoundary: SystemMessage = {
      type: 'system',
      uuid: '00000000-0000-4000-8000-000000000008',
      timestamp: '2026-07-10T00:00:02.000Z',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      level: 'info',
    };
    const compactSummary = user(
      '00000000-0000-4000-8000-000000000009',
      'summary after compact',
    );
    compactSummary.isCompactSummary = true;

    await handle.recordMessages([
      preCompactUser,
      compactBoundary,
      compactSummary,
    ]);
    await handle.close();

    const resumed = await store.repository().resolveSession(options.filePath);
    expect(resumed?.messages.map((message) => message.uuid)).toEqual([
      compactBoundary.uuid,
      compactSummary.uuid,
    ]);

    const resumedHandle = await store.acquireSessionWriter(options);
    expect(resumedHandle.hasMessageUuid(preCompactUser.uuid)).toBe(true);
    expect(resumedHandle.hasMessageUuid(compactSummary.uuid)).toBe(true);
    await resumedHandle.close();
    await store.close();
  });

  it('persists a rewound turn on the retained branch for restart recovery', async () => {
    const options = await createOptions();
    const store = new TranscriptStore({
      stateSource: emptyStateSource(),
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    const retainedUser = user(
      '00000000-0000-4000-8000-000000000010',
      'retained question',
    );
    const retainedAssistant = assistant(
      '00000000-0000-4000-8000-000000000011',
      'retained answer',
    );
    const removedUser = user(
      '00000000-0000-4000-8000-000000000012',
      'removed question',
    );
    const removedAssistant = assistant(
      '00000000-0000-4000-8000-000000000013',
      'removed answer',
    );
    const branchedUser = user(
      '00000000-0000-4000-8000-000000000014',
      'branched question',
    );
    const branchedAssistant = assistant(
      '00000000-0000-4000-8000-000000000015',
      'branched answer',
    );

    await handle.recordMessages([
      retainedUser,
      retainedAssistant,
      removedUser,
      removedAssistant,
    ]);
    await handle.recordMessages(
      [branchedUser, branchedAssistant],
      retainedAssistant.uuid,
    );
    await handle.close();

    const resumed = await new TranscriptRepository().resolveSession(
      options.filePath,
    );
    expect(resumed?.messages.map((message) => message.uuid)).toEqual([
      retainedUser.uuid,
      retainedAssistant.uuid,
      branchedUser.uuid,
      branchedAssistant.uuid,
    ]);
    expect(
      resumed?.messages.some(({ uuid }) => uuid === removedUser.uuid),
    ).toBe(false);
    await store.close();
  });

  it('keeps the selected branch across two real store restarts without deleting old branches', async () => {
    const options = await createOptions();
    const firstStore = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const firstHandle = await firstStore.acquireSessionWriter(options);
    const aUser = user('00000000-0000-4000-8000-000000000040', 'question A');
    const aAssistant = assistant(
      '00000000-0000-4000-8000-000000000041',
      'answer A',
    );
    const bUser = user('00000000-0000-4000-8000-000000000042', 'question B');
    const bAssistant = assistant(
      '00000000-0000-4000-8000-000000000043',
      'answer B',
    );
    const cUser = user('00000000-0000-4000-8000-000000000044', 'question C');
    const cAssistant = assistant(
      '00000000-0000-4000-8000-000000000045',
      'answer C',
    );

    await firstHandle.recordMessages([
      aUser,
      aAssistant,
      bUser,
      bAssistant,
      cUser,
      cAssistant,
    ]);
    await firstHandle.recordActiveLeaf(aAssistant.uuid, {
      explicit: true,
      rewound: true,
      durable: true,
    });
    await firstHandle.close();
    await firstStore.close();

    const firstRestartRepository = new TranscriptRepository();
    const afterRewind = await firstRestartRepository.resolveSession(
      options.filePath,
      { sessionId: options.sessionId },
    );
    expect(afterRewind?.messages.map(({ uuid }) => uuid)).toEqual([
      aUser.uuid,
      aAssistant.uuid,
    ]);

    const secondStore = new TranscriptStore({
      repository: firstRestartRepository,
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const secondHandle = await secondStore.acquireSessionWriter(options);
    const dUser = user('00000000-0000-4000-8000-000000000046', 'question D');
    const dAssistant = assistant(
      '00000000-0000-4000-8000-000000000047',
      'answer D',
    );
    await secondHandle.recordMessages([dUser, dAssistant]);
    await secondHandle.close();
    await secondStore.close();

    const secondRestartRepository = new TranscriptRepository();
    const afterNewBranch = await secondRestartRepository.resolveSession(
      options.filePath,
      { sessionId: options.sessionId },
    );
    expect(afterNewBranch?.messages.map(({ uuid }) => uuid)).toEqual([
      aUser.uuid,
      aAssistant.uuid,
      dUser.uuid,
      dAssistant.uuid,
    ]);

    const physicalMessages = await readMessageEntries(options.filePath);
    expect(physicalMessages.map(({ uuid }) => uuid)).toEqual(
      expect.arrayContaining([
        bUser.uuid,
        bAssistant.uuid,
        cUser.uuid,
        cAssistant.uuid,
      ]),
    );
  });

  it('persists an explicit null active leaf across restart', async () => {
    const options = await createOptions();
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    await handle.recordMessages([
      user('00000000-0000-4000-8000-000000000035', 'removed root'),
    ]);

    await handle.recordActiveLeaf(null, {
      explicit: true,
      rewound: true,
      durable: true,
    });
    await handle.close();

    const resumed = await store.repository().resolveSession(options.filePath, {
      sessionId: options.sessionId,
    });
    expect(resumed?.messages).toEqual([]);
    await store.close();
  });

  it('hydrates a resumed writer from the session active leaf marker', async () => {
    const options = await createOptions();
    const retainedUser = user(
      '00000000-0000-4000-8000-000000000020',
      'retained question',
    );
    const retainedAssistant = assistant(
      '00000000-0000-4000-8000-000000000021',
      'retained answer',
    );
    const removedUser = user(
      '00000000-0000-4000-8000-000000000022',
      'removed question',
    );
    const removedAssistant = assistant(
      '00000000-0000-4000-8000-000000000023',
      'removed answer',
    );
    const marker: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: options.sessionId,
      leafUuid: retainedAssistant.uuid,
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    await fs.writeFile(
      options.filePath,
      [
        persisted(retainedUser, null),
        persisted(retainedAssistant, retainedUser.uuid),
        persisted(removedUser, retainedAssistant.uuid),
        persisted(removedAssistant, removedUser.uuid),
        marker,
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf8',
    );
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    const branchedUser = user(
      '00000000-0000-4000-8000-000000000024',
      'branched question',
    );

    await handle.recordMessages([branchedUser]);
    await handle.close();

    expect(await readMessageEntries(options.filePath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: branchedUser.uuid,
          parentUuid: retainedAssistant.uuid,
        }),
      ]),
    );
    await store.close();
  });

  it('hydrates an explicit null active leaf as a root writer cursor', async () => {
    const options = await createOptions();
    const existing = user(
      '00000000-0000-4000-8000-000000000025',
      'existing question',
    );
    const marker: ActiveLeafEntry = {
      type: 'active-leaf',
      sessionId: options.sessionId,
      leafUuid: null,
      explicit: true,
      rewound: true,
      timestamp: 1_754_300_000_000,
    };
    await fs.writeFile(
      options.filePath,
      `${JSON.stringify(persisted(existing, null))}\n${JSON.stringify(marker)}\n`,
      'utf8',
    );
    const store = new TranscriptStore({
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    const newRoot = user('00000000-0000-4000-8000-000000000026', 'new root');

    await handle.recordMessages([newRoot]);
    await handle.close();

    expect(await readMessageEntries(options.filePath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uuid: newRoot.uuid, parentUuid: null }),
      ]),
    );
    await store.close();
  });

  it('closes active writer state before deleting a transcript', async () => {
    const options = await createOptions();
    const store = new TranscriptStore({ stateSource: emptyStateSource() });
    const handle = await store.acquireSessionWriter(options);
    await handle.recordMessages([
      user('00000000-0000-4000-8000-000000000005', 'before delete'),
    ]);

    await store.deleteTranscript(options.filePath);

    await expect(fs.access(options.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      handle.recordMessages([
        user('00000000-0000-4000-8000-000000000006', 'after delete'),
      ]),
    ).rejects.toThrow('SessionTranscriptWriter is closed');
    await handle.close();
    await store.close();
  });

  it('moves an active transcript and stamps later messages with the new worktree context', async () => {
    const options = await createOptions();
    const targetPath = path.join(
      path.dirname(options.filePath),
      'worktree',
      'session.jsonl',
    );
    const store = new TranscriptStore({
      stateSource: emptyStateSource(),
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    await handle.recordMessages([
      user('00000000-0000-4000-8000-000000000030', 'enter worktree'),
    ]);

    await handle.relocate({
      filePath: targetPath,
      cwd: '/workspace/project/.qwen/worktrees/feature',
      gitBranch: 'worktree-feature',
      worktreeSession: {
        originalCwd: '/workspace/project',
        preEnterOriginalCwd: '/workspace/project',
        worktreePath: '/workspace/project/.qwen/worktrees/feature',
        worktreeName: 'feature',
        worktreeBranch: 'worktree-feature',
        originalBranch: 'main',
        originalHeadCommit: 'abc123',
        sessionId: options.sessionId,
        lifecycle: 'owner',
      },
    });
    await handle.recordMessages([
      assistant('00000000-0000-4000-8000-000000000031', 'inside worktree'),
    ]);
    await handle.close();

    await expect(fs.access(options.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const entries = (await fs.readFile(targetPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const relocatedIndex = entries.findIndex(
      (entry) => entry['type'] === 'relocated',
    );
    const stateIndex = entries.findIndex(
      (entry) => entry['type'] === 'worktree-state',
    );
    const assistantIndex = entries.findIndex(
      (entry) => entry['uuid'] === '00000000-0000-4000-8000-000000000031',
    );
    expect(relocatedIndex).toBeGreaterThanOrEqual(0);
    expect(stateIndex).toBe(relocatedIndex + 1);
    expect(assistantIndex).toBeGreaterThan(stateIndex);
    expect(entries[assistantIndex]).toMatchObject({
      cwd: '/workspace/project/.qwen/worktrees/feature',
      gitBranch: 'worktree-feature',
    });
    expect(handle.getSessionFilePath()).toBe(await fs.realpath(targetPath));
    await store.close();
  });

  it.each([undefined, 0, Number.MAX_SAFE_INTEGER + 1])(
    'preserves both transcripts on relocation conflict with inode %s',
    async (unreliableInode) => {
      const options = await createOptions();
      const targetPath = path.join(
        path.dirname(options.filePath),
        'occupied.jsonl',
      );
      await fs.writeFile(targetPath, '{"sentinel":true}\n', 'utf8');
      const store = new TranscriptStore({
        stateSource: emptyStateSource(),
        coordinatorOptions: { flushIntervalMs: 0 },
      });
      const handle = await store.acquireSessionWriter(options);
      await handle.recordMessages([
        user('00000000-0000-4000-8000-000000000032', 'do not lose me'),
      ]);

      if (unreliableInode !== undefined) {
        const actualStat = fs.stat;
        const canonicalPaths = new Set(
          await Promise.all([
            fs.realpath(options.filePath),
            fs.realpath(targetPath),
          ]),
        );
        vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
          const stat = await actualStat(...args);
          if (canonicalPaths.has(String(args[0]))) {
            stat.dev = 1;
            stat.ino = unreliableInode;
          }
          return stat;
        });
      }

      try {
        await expect(
          handle.relocate({
            filePath: targetPath,
            cwd: '/workspace/occupied',
            worktreeSession: null,
          }),
        ).rejects.toMatchObject({ code: 'EEXIST' });
        await handle.recordMessages([
          assistant('00000000-0000-4000-8000-000000000033', 'still writable'),
        ]);

        expect(await fs.readFile(targetPath, 'utf8')).toBe(
          '{"sentinel":true}\n',
        );
        expect(await readMessageEntries(options.filePath)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              uuid: '00000000-0000-4000-8000-000000000032',
            }),
            expect.objectContaining({
              uuid: '00000000-0000-4000-8000-000000000033',
            }),
          ]),
        );
      } finally {
        await handle.close();
        await store.close();
      }
    },
  );

  it('finishes a relocation left between hard-link and source unlink', async () => {
    const options = await createOptions();
    const targetPath = path.join(
      path.dirname(options.filePath),
      'crash-recovery',
      'session.jsonl',
    );
    const store = new TranscriptStore({
      stateSource: emptyStateSource(),
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    await handle.recordMessages([
      user('00000000-0000-4000-8000-000000000036', 'before crash window'),
    ]);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.link(options.filePath, targetPath);

    await handle.relocate({
      filePath: targetPath,
      cwd: '/workspace/recovered-worktree',
      worktreeSession: null,
    });
    await handle.recordMessages([
      assistant(
        '00000000-0000-4000-8000-000000000037',
        'continued after recovery',
      ),
    ]);
    await handle.close();

    await expect(fs.access(options.filePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readMessageEntries(targetPath)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uuid: '00000000-0000-4000-8000-000000000036',
        }),
        expect.objectContaining({
          uuid: '00000000-0000-4000-8000-000000000037',
        }),
      ]),
    );
    await store.close();
  });

  it('re-keys the active writer when marker append fails after the file move', async () => {
    const options = await createOptions();
    const targetPath = path.join(
      path.dirname(options.filePath),
      'marker-failure',
      'session.jsonl',
    );
    const markerFailure = new Error('injected marker append failure');
    let failTargetAppend = false;
    const store = new TranscriptStore({
      stateSource: emptyStateSource(),
      coordinatorOptions: {
        flushIntervalMs: 0,
        fileSystem: {
          realpath: (filePath) => fs.realpath(filePath),
          mkdir: (directoryPath, mkdirOptions) =>
            fs.mkdir(directoryPath, mkdirOptions),
          open: (filePath, flags, mode) => fs.open(filePath, flags, mode),
          appendFile: (filePath, data, appendOptions) => {
            if (
              failTargetAppend &&
              filePath.endsWith(path.join('marker-failure', 'session.jsonl'))
            ) {
              return Promise.reject(markerFailure);
            }
            return fs.appendFile(filePath, data, appendOptions);
          },
          rm: (filePath, rmOptions) => fs.rm(filePath, rmOptions),
        },
      },
    });
    const handle = await store.acquireSessionWriter(options);
    await handle.recordMessages([
      user('00000000-0000-4000-8000-000000000038', 'move before markers'),
    ]);
    failTargetAppend = true;

    await expect(
      handle.relocate({
        filePath: targetPath,
        cwd: '/workspace/marker-failure-worktree',
        worktreeSession: null,
      }),
    ).rejects.toBe(markerFailure);

    expect(handle.getSessionFilePath()).toBe(await fs.realpath(targetPath));
    await expect(
      store.acquireExistingSessionWriter({
        filePath: options.filePath,
        sessionId: options.sessionId,
      }),
    ).resolves.toBeUndefined();
    const targetHandle = await store.acquireExistingSessionWriter({
      filePath: targetPath,
      sessionId: options.sessionId,
    });
    expect(targetHandle?.getSessionFilePath()).toBe(
      await fs.realpath(targetPath),
    );

    await Promise.allSettled([handle.close(), targetHandle?.close()]);
    await store.close().catch(() => undefined);
  });

  it('persists startup worktree state before the first real message', async () => {
    const options = await createOptions();
    const store = new TranscriptStore({
      stateSource: emptyStateSource(),
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    await handle.recordWorktreeState({
      originalCwd: '/workspace/project',
      preEnterOriginalCwd: '/workspace/project',
      worktreePath: '/workspace/project/.qwen/worktrees/start',
      worktreeName: 'start',
      sessionId: options.sessionId,
    });
    await handle.recordMessages([
      user('00000000-0000-4000-8000-000000000034', 'first prompt'),
    ]);
    await handle.close();

    const entries = (await fs.readFile(options.filePath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries[0]).toMatchObject({
      type: 'worktree-state',
      sessionId: options.sessionId,
    });
    expect(
      entries.findIndex((entry) => entry['type'] === 'user'),
    ).toBeGreaterThan(0);
    await store.close();
  });

  it('keeps the latest worktree state in the original writer file', async () => {
    const options = await createOptions();
    const store = new TranscriptStore({
      stateSource: emptyStateSource(),
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    const originalFilePath = handle.getSessionFilePath();

    await handle.recordWorktreeState({
      originalCwd: '/workspace/project',
      preEnterOriginalCwd: '/workspace/project',
      worktreePath: '/workspace/project/.qwen/worktrees/first',
      worktreeCwd: '/workspace/project/.qwen/worktrees/first',
      worktreeName: 'first',
      sessionId: options.sessionId,
    });
    await handle.recordWorktreeState(null);
    await handle.recordWorktreeState({
      originalCwd: '/workspace/project',
      preEnterOriginalCwd: '/workspace/project',
      worktreePath: '/workspace/project/.qwen/worktrees/second',
      worktreeCwd: '/workspace/project/.qwen/worktrees/second/apps/desktop',
      worktreeName: 'second',
      sessionId: options.sessionId,
    });

    expect(handle.getSessionFilePath()).toBe(originalFilePath);
    await handle.flush();
    await handle.close();

    const resolved = await new TranscriptRepository().resolveSession(
      options.filePath,
    );
    expect(
      resolved?.index.metadata.worktreeSessions.get(options.sessionId),
    ).toEqual(
      expect.objectContaining({
        worktreePath: '/workspace/project/.qwen/worktrees/second',
        worktreeCwd: '/workspace/project/.qwen/worktrees/second/apps/desktop',
      }),
    );
    await store.close();
  });

  it('keeps buffered startup metadata when the host relocates before the first prompt', async () => {
    const options = await createOptions();
    const targetPath = path.join(
      path.dirname(options.filePath),
      'preflight-worktree',
      'session.jsonl',
    );
    const store = new TranscriptStore({
      stateSource: emptyStateSource(),
      coordinatorOptions: { flushIntervalMs: 0 },
    });
    const handle = await store.acquireSessionWriter(options);
    await handle.recordRuntimeConfig({ model: 'startup-model' });

    await handle.relocate({
      filePath: targetPath,
      cwd: '/workspace/preflight-worktree',
      worktreeSession: {
        originalCwd: '/workspace/project',
        preEnterOriginalCwd: '/workspace/project',
        worktreePath: '/workspace/preflight-worktree',
        worktreeName: 'preflight',
        sessionId: options.sessionId,
      },
    });
    await handle.recordMessages([
      user('00000000-0000-4000-8000-000000000035', 'first prompt'),
    ]);
    await handle.close();

    const entryTypes = (await fs.readFile(targetPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as Record<string, unknown>)['type']);
    expect(entryTypes).toEqual(
      expect.arrayContaining([
        'runtime-config',
        'relocated',
        'worktree-state',
        'user',
      ]),
    );
    expect(entryTypes.indexOf('runtime-config')).toBeLessThan(
      entryTypes.indexOf('relocated'),
    );
    await store.close();
  });
});
