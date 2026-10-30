/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Content } from '@google/genai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  openManagedSession,
  type ManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import { LocalManagedSessionResourceStore } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-resources.js';
import { CompressionStatus } from '@qwen-code/qwen-code-core/core/turn.js';
import {
  ChatCompressionService,
  type ChatCompressionCandidate,
} from '@qwen-code/qwen-code-core/services/chatCompressionService.js';
import { loadCliConfig } from '../config/config.js';
import { HostedContextCompression } from './hosted-context-compression.js';

vi.mock('../config/settings.js', () => ({
  loadSettings: () => ({ merged: {} }),
}));
vi.mock('../config/config.js', () => ({ loadCliConfig: vi.fn() }));

const chat = {
  setHistory:
    vi.fn<(history: Content[], completed?: readonly string[]) => void>(),
  getLastPromptTokenCount: () => 0,
};
const config = {
  initialize: vi.fn(),
  shutdown: vi.fn(),
  setUserMemory: vi.fn(),
  getAllConfiguredModels: () => [],
  getContentGeneratorConfig: () => ({ model: 'model' }),
  getChatCompression: () => undefined,
  getCompactionModel: () => undefined,
  getFastModel: () => undefined,
  getModelsConfig: () => ({ getCurrentAuthType: () => 'openai' }),
  refreshAuth: vi.fn(),
  getLlmClient: () => ({ getChat: () => chat }),
  getHookSystem: () => undefined,
};
let root: string;
let session: ManagedSession;
let compression: HostedContextCompression;
let busy = false;
let pendingHooks = false;

const candidate: ChatCompressionCandidate = {
  newHistory: [
    { role: 'user', parts: [{ text: 'remember: blue' }] },
    { role: 'model', parts: [{ text: 'Understood.' }] },
  ],
  summary: 'remember: blue',
  info: {
    compressionStatus: CompressionStatus.COMPRESSED,
    originalTokenCount: 1000,
    newTokenCount: 20,
    newTokenCountIsEstimated: true,
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  busy = false;
  pendingHooks = false;
  vi.mocked(loadCliConfig).mockResolvedValue(config as never);
  root = await mkdtemp(path.join(os.tmpdir(), 'qwen-hosted-compression-'));
  const sessionKey = {
    tenantId: 'tenant',
    workspaceId: 'workspace',
    sessionId: randomUUID(),
  };
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const ref = await resources.publish('definition', Buffer.from('{}'));
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'worker',
    activationLeaseDurationMs: 60_000,
    create: { definitionRef: ref, rootSnapshotRef: ref, createdBy: 'test' },
  });
  const promptId = randomUUID();
  for (const type of ['user', 'assistant'] as const)
    await session.sink.write({
      uuid: randomUUID(),
      parentUuid: null,
      sessionId: sessionKey.sessionId,
      timestamp: new Date().toISOString(),
      cwd: root,
      version: 'test',
      type,
      daemonPromptId: promptId,
      message: {
        role: type === 'user' ? 'user' : 'model',
        parts: [{ text: 'original blue history' }],
      },
    });
  await session.sink.write({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: sessionKey.sessionId,
    timestamp: new Date().toISOString(),
    cwd: root,
    version: 'test',
    type: 'system',
    subtype: 'turn_result',
    systemPayload: {
      promptId,
      state: 'completed',
      stopReason: 'end_turn',
      endedAt: Date.now(),
    },
  });
  compression = new HostedContextCompression({
    session,
    cwd: root,
    instructions: async () => 'instructions',
    busy: () => busy,
    hasPendingHooks: () => pendingHooks,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await compression?.wait();
  await session?.close();
  await rm(root, { recursive: true, force: true });
});

function engine(prepared = candidate) {
  return vi
    .spyOn(ChatCompressionService.prototype, 'compress')
    .mockImplementation(async (_chat, options) => {
      expect(options.restoreRecentFiles).toBe(false);
      expect(options.originalTokenCount).toBeGreaterThan(0);
      await options.onPreparedCompaction?.(structuredClone(prepared));
      return { newHistory: prepared.newHistory, info: prepared.info };
    });
}

const intent = () => ({
  operationId: randomUUID(),
  expectedCompactionRevision: 0,
});

async function reopen() {
  const sessionKey = session.authority.sessionHeader.sessionKey;
  await session.close();
  session = await openManagedSession({
    runtimeBaseDir: root,
    cwd: root,
    transcriptPath: path.join(root, 'transcript.jsonl'),
    sessionId: sessionKey.sessionId,
    sessionKey,
    version: 'test',
    workerId: 'replacement',
    activationLeaseDurationMs: 60_000,
  });
  compression = new HostedContextCompression({
    session,
    cwd: root,
    instructions: async () => 'instructions',
    busy: () => busy,
    hasPendingHooks: () => pendingHooks,
  });
}

describe('Hosted context compression', () => {
  it('durably compresses without a user Turn and replays the exact operation', async () => {
    const summarize = engine();
    const request = intent();
    const before = session.authority.committedSequence;
    await compression.admit(request);
    await compression.wait();
    expect(vi.mocked(loadCliConfig).mock.calls[0]?.[1]).toMatchObject({
      sessionId: session.authority.sessionHeader.sessionKey.sessionId,
      sessionIdGenerated: true,
      chatRecording: false,
    });
    const result = compression.status(request.operationId)!;
    expect(result).toMatchObject({
      status: 'completed',
      outcome: 'compressed',
    });
    expect(result.compactionRevision).toBeGreaterThan(before);
    expect(compression.busy).toBe(false);
    const events = session.authority.eventsInSequenceRange(
      before + 1,
      session.authority.committedSequence,
    );
    expect(
      events.filter((event) => event.kind === 'context.compacted'),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.kind === 'input.accepted' || event.kind === 'turn.settled',
      ),
    ).toBe(false);
    expect((await session.sink.projectModelHistory()).apiHistory).toEqual(
      candidate.newHistory,
    );
    expect(
      (await session.sink.project()).filter(
        (record) => record.type === 'user' || record.type === 'assistant',
      ),
    ).toHaveLength(2);
    busy = true;
    expect(await compression.admit(request)).toEqual(result);
    await compression.wait();
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('refuses busy and stale requests before invoking the model', async () => {
    const summarize = engine();
    busy = true;
    await expect(compression.admit(intent())).rejects.toMatchObject({
      code: 'session_context_busy',
    });
    busy = false;
    await expect(
      compression.admit({ ...intent(), expectedCompactionRevision: 1 }),
    ).rejects.toMatchObject({ code: 'compaction_revision_conflict' });
    expect(summarize).not.toHaveBeenCalled();
  });

  it('persists generation before a hook can leave compression blocked', async () => {
    const summarize = engine();
    summarize.mockImplementationOnce(async () => {
      expect(session.authority.activeHistoryMaintenance).toMatchObject({
        phase: 'generating',
        attempt: 1,
        candidateRef: null,
        run: { state: 'running' },
      });
      pendingHooks = true;
      throw new Error('PreCompact outcome unknown');
    });
    const request = intent();
    await compression.admit(request);
    await compression.wait();
    expect(compression.status(request.operationId)?.status).toBe(
      'recovery_blocked',
    );
    expect(session.authority.activeHistoryMaintenance).toMatchObject({
      phase: 'generating',
      candidateRef: null,
      run: { state: 'recovery_blocked' },
    });
    expect(compression.busy).toBe(true);
  });

  it('reads the terminal evidence after a lost final reply without committing history twice', async () => {
    const summarize = engine();
    const commit = session.authority.commitHistoryMaintenance.bind(
      session.authority,
    );
    vi.spyOn(session.authority, 'commitHistoryMaintenance').mockImplementation(
      async (...args) => {
        const receipt = await commit(...args);
        if (args[1].compaction) throw new Error('final reply lost');
        return receipt;
      },
    );
    const request = intent();
    await compression.admit(request);
    await compression.wait();
    expect(compression.status(request.operationId)?.outcome).toBe('compressed');
    await compression.admit(request);
    expect(summarize).toHaveBeenCalledOnce();
    expect(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'context.compacted'),
    ).toHaveLength(1);
  });

  it('refuses a known configuration failure without leaving an admission barrier', async () => {
    vi.mocked(loadCliConfig).mockRejectedValueOnce(new Error('missing model'));
    await expect(compression.admit(intent())).rejects.toMatchObject({
      code: 'context_compression_configuration_unavailable',
    });
    expect(compression.busy).toBe(false);
    expect(session.authority.activeHistoryMaintenance).toBeUndefined();
  });

  it('proves a source-resource failure happened before native admission', async () => {
    vi.spyOn(session.resources, 'publish').mockRejectedValueOnce(
      new Error('resource store unavailable'),
    );
    await expect(compression.admit(intent())).rejects.toMatchObject({
      code: 'context_compression_preparation_failed',
    });
    expect(compression.busy).toBe(false);
    expect(session.authority.activeHistoryMaintenance).toBeUndefined();
  });

  it.each([false, true])(
    'excludes cancelled input from the fixed source, including a prior snapshot tail (%s)',
    async (snapshot) => {
      const promptId = randomUUID();
      const envelope = {
        parentUuid: null,
        sessionId: session.authority.sessionHeader.sessionKey.sessionId,
        timestamp: new Date().toISOString(),
        cwd: root,
        version: 'test',
      };
      await session.sink.write({
        ...envelope,
        uuid: randomUUID(),
        type: 'user',
        daemonPromptId: promptId,
        promptId,
        message: { role: 'user', parts: [{ text: 'cancelled secret input' }] },
      });
      await session.sink.write({
        ...envelope,
        uuid: randomUUID(),
        type: 'system',
        subtype: 'turn_result',
        systemPayload: {
          promptId,
          state: 'cancelled',
          stopReason: 'cancelled',
          endedAt: Date.now(),
        },
      });
      if (snapshot)
        await session.sink.write({
          ...envelope,
          uuid: randomUUID(),
          type: 'system',
          subtype: 'chat_compression',
          systemPayload: {
            info: candidate.info,
            compressedHistory: [
              ...candidate.newHistory,
              { role: 'user', parts: [{ text: 'cancelled secret input' }] },
            ],
            summaryPrefixLength: 2,
            promptIds: [null, null, promptId],
          },
        });
      engine();
      await compression.admit({
        ...intent(),
        expectedCompactionRevision: compression.revision,
      });
      await compression.wait();
      const source = chat.setHistory.mock.calls[0]![0];
      expect(JSON.stringify(source)).not.toContain('cancelled secret input');
      expect(source).toHaveLength(2);
    },
  );

  it('does not confuse changed content under an existing operation with a retry', async () => {
    engine();
    const request = intent();
    await compression.admit(request);
    await compression.wait();
    await expect(
      compression.admit({ ...request, expectedCompactionRevision: 1 }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('persists noop and known failure without rewriting history', async () => {
    const summarize = vi
      .spyOn(ChatCompressionService.prototype, 'compress')
      .mockResolvedValue({
        newHistory: null,
        info: {
          compressionStatus: CompressionStatus.NOOP,
          originalTokenCount: 1,
          newTokenCount: 1,
        },
      });
    const request = intent();
    await compression.admit(request);
    await compression.wait();
    expect(compression.status(request.operationId)).toMatchObject({
      status: 'completed',
      outcome: 'noop',
      compactionRevision: 0,
    });
    summarize.mockRejectedValueOnce(new Error('provider unavailable'));
    const failed = intent();
    await compression.admit(failed);
    await compression.wait();
    expect(compression.status(failed.operationId)).toMatchObject({
      status: 'failed',
      failureCode: 'context_compression_failed',
    });
    expect(compression.revision).toBe(0);
    expect(compression.busy).toBe(false);
  });

  it('stores a large snapshot through chunks and restores it for the next model input', async () => {
    const large = structuredClone(candidate);
    large.newHistory[0]!.parts![0]!.text = '中文记录'.repeat(25_000);
    engine(large);
    const request = intent();
    await compression.admit(request);
    await compression.wait();
    expect(compression.status(request.operationId)?.status).toBe('completed');
    const event = session.authority
      .eventsInSequenceRange(1, session.authority.committedSequence)
      .findLast((event) => event.kind === 'context.compacted')!;
    expect(event.payload['summaryRef']).toMatchObject({
      kind: 'managed-message-chunks',
    });
    expect((await session.sink.projectModelHistory()).apiHistory).toEqual(
      large.newHistory,
    );
  });

  it('resumes a saved candidate after reopening without generating the summary again', async () => {
    const commits = vi.spyOn(session.authority, 'commitHistoryMaintenance');
    const summarize = engine();
    summarize.mockImplementationOnce(async (_chat, options) => {
      await options.onPreparedCompaction?.(structuredClone(candidate));
      pendingHooks = true;
      throw new Error('PostCompact delivery unknown');
    });
    const request = intent();
    await compression.admit(request);
    await compression.wait();
    for (const result of commits.mock.results) await result.value;
    expect(compression.status(request.operationId)?.status).toBe(
      'recovery_blocked',
    );
    expect(compression.busy).toBe(true);
    pendingHooks = false;
    await reopen();
    compression.resume();
    await compression.wait();
    expect(compression.status(request.operationId)?.outcome).toBe('compressed');
    expect(summarize).toHaveBeenCalledOnce();
  });

  it('replaces an interrupted summary after writer takeover and fences its late candidate', async () => {
    let finishOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => {
      finishOld = resolve;
    });
    let oldPostCompact = false;
    const summarize = engine().mockImplementationOnce(
      async (_chat, options) => {
        await oldResponse;
        await options.onPreparedCompaction?.(structuredClone(candidate));
        oldPostCompact = true;
        return { newHistory: candidate.newHistory, info: candidate.info };
      },
    );
    const request = intent();
    await compression.admit(request);
    await vi.waitFor(() => expect(summarize).toHaveBeenCalledOnce());
    const old = compression;
    try {
      await reopen();
      compression.resume();
      await compression.wait();
      expect(compression.status(request.operationId)?.outcome).toBe(
        'compressed',
      );
    } finally {
      finishOld();
      await old.wait();
    }
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(oldPostCompact).toBe(false);
    expect(
      session.authority
        .eventsInSequenceRange(1, session.authority.committedSequence)
        .filter((event) => event.kind === 'context.compacted'),
    ).toHaveLength(1);
    expect((await session.sink.projectModelHistory()).apiHistory).toEqual(
      candidate.newHistory,
    );
  });
});
