/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { ApiResponseEvent } from '../telemetry/types.js';
import { EVENT_API_RESPONSE } from '../telemetry/constants.js';
import type { UiEvent } from '../telemetry/uiTelemetry.js';
import { LlmChat } from '../core/llm-chat.js';
import { CompressionStatus } from '../core/turn.js';
import { markApiHistoryPrompt } from './session-api-history.js';
import type { Content } from '@google/genai';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import {
  SessionWriterLease,
  SessionTranscriptChangedError,
  SessionWriterUnavailableError,
} from './session-writer-lease.js';
import { parseMessageGroupTranscript } from '../utils/message-group-deletion.js';
import { prepareTranscriptRecords } from '../utils/transcript-records.js';
import { computeInitialTurnFromHistory } from './session-turn-state.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-delete-messages-'),
  );
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const transcriptPath = path.join(root, 'chats', 'session.jsonl');
  const options = {
    runtimeBaseDir: root,
    sessionId: 'session',
    transcriptPath,
  };
  const lease = await SessionWriterLease.acquire(options);
  cleanups.push(() => lease.release());
  const config = {
    getSessionId: () => 'session',
    getResumedSessionData: () => undefined,
    getProjectRoot: () => root,
    getCliVersion: () => 'test',
    getModel: () => 'model',
    getAuthType: () => undefined,
    getApprovalMode: () => ApprovalMode.DEFAULT,
  } as unknown as Config;
  const recorder = new ChatRecordingService(config, undefined, true);
  recorder.activate(lease);
  cleanups.push(() => recorder.close().catch(() => undefined));
  recorder.recordUserMessage(
    'delete-me',
    undefined,
    undefined,
    'api-first',
    'daemon-first',
  );
  await recorder.flush();
  return { root, transcriptPath, options, lease, recorder, config };
}

describe('recorded message deletion', () => {
  it('upgrades a default legacy recorder to a writer lease, deletes, appends and releases ownership', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-delete-default-'),
    );
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const transcriptPath = path.join(root, 'chats', 'session.jsonl');
    const config = {
      storage: { getProjectDir: () => root, getRuntimeBaseDir: () => root },
      isSessionWriterLeaseEnabled: () => false,
      getSessionId: () => 'session',
      getResumedSessionData: () => undefined,
      getProjectRoot: () => root,
      getCliVersion: () => 'test',
      getModel: () => 'model',
      getAuthType: () => undefined,
      getApprovalMode: () => ApprovalMode.DEFAULT,
    } as unknown as Config;
    const recorder = new ChatRecordingService(config);
    cleanups.push(() => recorder.close().catch(() => undefined));
    expect(recorder.supportsMessageGroupDeletion()).toBe(true);
    recorder.recordUserMessage(
      'default delete',
      undefined,
      undefined,
      'api-first',
      'daemon-first',
    );
    const before = await recorder.getMessageGroups();
    expect(recorder.hasWriteOwnership()).toBe(false);
    await recorder.deleteMessageGroups({
      snapshot: before.snapshot,
      groupIds: [before.groups[0]!.id],
    });
    expect(await fs.readFile(transcriptPath, 'utf8')).not.toContain(
      'default delete',
    );
    expect(recorder.hasWriteOwnership()).toBe(true);
    recorder.recordUserMessage(
      'default next',
      undefined,
      undefined,
      'api-next',
      'daemon-next',
    );
    await recorder.flush();
    expect((await recorder.getMessageGroups()).groups).toHaveLength(1);
    expect(await fs.readFile(transcriptPath, 'utf8')).toContain('default next');
    await recorder.close();
    const successor = await SessionWriterLease.acquire({
      runtimeBaseDir: root,
      sessionId: 'session',
      transcriptPath,
    });
    cleanups.push(() => successor.release());
    await expect(successor.assertOwnedAndUnchanged()).resolves.toBeUndefined();
  });

  it('physically removes the only turn and permits appends and a successor writer', async () => {
    const { transcriptPath, options, lease, recorder } = await fixture();
    const before = await recorder.getMessageGroups();
    const result = await recorder.deleteMessageGroups({
      snapshot: before.snapshot,
      groupIds: before.groups.map((group) => group.id),
    });
    expect(result.deletedPromptIds).toEqual(['daemon-first']);
    expect(await fs.readFile(transcriptPath, 'utf8')).not.toContain(
      '"text":"delete-me"',
    );
    expect((await recorder.getMessageGroups()).groups).toEqual([]);
    recorder.recordUserMessage(
      'next',
      undefined,
      undefined,
      'api-next',
      'daemon-next',
    );
    await recorder.flush();
    const records = parseMessageGroupTranscript(
      await fs.readFile(transcriptPath, 'utf8'),
    );
    expect(records).toHaveLength(2);
    expect(records[1]?.parentUuid).toBe(records[0]?.uuid);
    expect(prepareTranscriptRecords(records).gaps).toEqual([]);
    await recorder.close();
    expect(lease.isReleased).toBe(true);
    const next = await SessionWriterLease.acquire(options);
    cleanups.push(() => next.release());
    await expect(next.assertOwnedAndUnchanged()).resolves.toBeUndefined();
    await next.appendJsonLine({
      ...records[0],
      uuid: 'later',
      parentUuid: records[1]!.uuid,
    });
  });

  it('rejects a stale snapshot without poisoning the writer or deleting messages', async () => {
    const { transcriptPath, recorder } = await fixture();
    const before = await recorder.getMessageGroups();
    recorder.recordUserMessage(
      'keep-me',
      undefined,
      undefined,
      'api-second',
      'daemon-second',
    );
    await recorder.flush();
    const unchanged = await fs.readFile(transcriptPath, 'utf8');
    await expect(
      recorder.deleteMessageGroups({
        snapshot: before.snapshot,
        groupIds: [before.groups[0]!.id],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe(unchanged);
    expect((await recorder.getMessageGroups()).groups).toHaveLength(2);
  });

  it('accepts a selection after late telemetry and automatic title updates and retains the latest unselected history', async () => {
    const { transcriptPath, recorder } = await fixture();
    recorder.recordUserMessage(
      'keep-me',
      undefined,
      undefined,
      'api-kept',
      'daemon-kept',
    );
    const before = await recorder.getMessageGroups();
    for (const executionId of ['late-1', 'late-2']) {
      recorder.recordUiTelemetryEvent({
        v: 1,
        kind: 'request',
        executionId,
        sessionId: 'session',
        promptId: 'api-kept',
        model: 'model',
        startedAt: 1,
        phase: 'ended',
        endedAt: 2,
        durationMs: 1,
        outcome: 'success',
        'event.name': 'request_lifecycle',
      });
    }
    await recorder.recordCustomTitle('Background title', 'auto');
    await recorder.flush();
    expect((await recorder.getMessageGroups()).snapshot).toBe(before.snapshot);
    await recorder.deleteMessageGroups({
      snapshot: before.snapshot,
      groupIds: [before.groups[0]!.id],
    });
    const kept = parseMessageGroupTranscript(
      await fs.readFile(transcriptPath, 'utf8'),
    );
    expect(
      kept.some((record) => record.daemonPromptId === 'daemon-first'),
    ).toBe(false);
    expect(kept.some((record) => record.daemonPromptId === 'daemon-kept')).toBe(
      true,
    );
    expect(
      kept.filter((record) => record.subtype === 'ui_telemetry'),
    ).toHaveLength(2);
    expect(
      kept.find((record) => record.subtype === 'custom_title')?.systemPayload,
    ).toEqual({ customTitle: 'Background title', titleSource: 'auto' });
    recorder.recordUserMessage(
      'next',
      undefined,
      undefined,
      'api-next',
      'daemon-next',
    );
    await recorder.flush();
    expect((await recorder.getMessageGroups()).groups).toHaveLength(2);
    expect(
      prepareTranscriptRecords(
        parseMessageGroupTranscript(await fs.readFile(transcriptPath, 'utf8')),
      ).gaps,
    ).toEqual([]);
  });

  it('does not alter the original file when atomic replacement fails', async () => {
    const { transcriptPath, recorder } = await fixture();
    const before = await recorder.getMessageGroups();
    const unchanged = await fs.readFile(transcriptPath, 'utf8');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename failed'));
    await expect(
      recorder.deleteMessageGroups({
        snapshot: before.snapshot,
        groupIds: [before.groups[0]!.id],
      }),
    ).rejects.toThrow();
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe(unchanged);
    expect(recorder.supportsMessageGroupDeletion()).toBe(true);
    expect(recorder.hasWriteOwnership()).toBe(true);
    recorder.recordUserMessage(
      'next',
      undefined,
      undefined,
      'api-next',
      'daemon-next',
    );
    await recorder.flush();
    expect((await recorder.getMessageGroups()).groups).toHaveLength(
      before.groups.length + 1,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'preserves transcript permissions during replacement',
    async () => {
      const { transcriptPath, lease, options } = await fixture();
      await lease.release();
      await fs.chmod(transcriptPath, 0o640);
      const replacementLease = await SessionWriterLease.acquire(options);
      cleanups.push(() => replacementLease.release());
      const original = await replacementLease.readTranscript();
      await replacementLease.replaceTranscript(
        '{"retained":true}\n',
        createHash('sha256').update(original).digest('hex'),
      );
      expect((await fs.stat(transcriptPath)).mode & 0o777).toBe(0o640);
    },
  );

  it('fences an outside writer and serializes replacement with appends', async () => {
    const { transcriptPath, lease } = await fixture();
    const original = await lease.readTranscript();
    const records = parseMessageGroupTranscript(original);
    const replacement: ChatRecord = { ...records[0]!, uuid: 'replacement' };
    const text = `${JSON.stringify(replacement)}\n`;
    await Promise.all([
      lease.replaceTranscript(
        text,
        createHash('sha256').update(original).digest('hex'),
      ),
      lease.appendJsonLine({
        ...replacement,
        uuid: 'appended',
        parentUuid: 'replacement',
      }),
    ]);
    expect(
      parseMessageGroupTranscript(await lease.readTranscript()).map(
        (record) => record.uuid,
      ),
    ).toEqual(['replacement', 'appended']);
    await fs.appendFile(transcriptPath, '{"foreign":true}\n');
    const foreign = await fs.readFile(transcriptPath, 'utf8');
    await expect(
      lease.replaceTranscript(
        text,
        createHash('sha256').update(foreign).digest('hex'),
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
    expect(await fs.readFile(transcriptPath, 'utf8')).toBe(foreign);
  });
});

it.each(['before', 'read', 'replace', 'after'] as const)(
  'removes late telemetry owned by the deleted prompt arriving %s deletion',
  async (phase) => {
    const { recorder, lease, transcriptPath } = await fixture();
    recorder.recordUserMessage(
      'keep',
      undefined,
      undefined,
      'api-kept',
      'daemon-kept',
    );
    const catalog = await recorder.getMessageGroups();
    const late = () =>
      recorder.recordUiTelemetryEvent({
        ...new ApiResponseEvent(
          'response',
          'model',
          1,
          'api-first',
          undefined,
          undefined,
          'private deleted response',
        ),
        'event.name': EVENT_API_RESPONSE,
      } as UiEvent);
    if (phase === 'before') late();
    if (phase === 'read') {
      const read = lease.readTranscript.bind(lease);
      vi.spyOn(lease, 'readTranscript').mockImplementationOnce(async () => {
        late();
        return read();
      });
    }
    if (phase === 'replace') {
      const replace = lease.replaceTranscript.bind(lease);
      vi.spyOn(lease, 'replaceTranscript').mockImplementationOnce(
        async (...args) => {
          late();
          return replace(...args);
        },
      );
    }
    await recorder.deleteMessageGroups({
      snapshot: catalog.snapshot,
      groupIds: [catalog.groups[0]!.id],
    });
    if (phase === 'after') late();
    recorder.recordUiTelemetryEvent({
      ...new ApiResponseEvent(
        'kept',
        'model',
        1,
        'api-kept',
        undefined,
        undefined,
        'retained response',
      ),
      'event.name': EVENT_API_RESPONSE,
    } as UiEvent);
    await recorder.flush();
    const text = await fs.readFile(transcriptPath, 'utf8');
    expect(text).not.toContain('private deleted response');
    expect(text).toContain('retained response');
    expect(
      prepareTranscriptRecords(parseMessageGroupTranscript(text)).gaps,
    ).toEqual([]);
  },
);

it('keeps the existing summary boundary through actual fast compression', async () => {
  const { recorder, config, transcriptPath } = await fixture();
  Object.assign(config, {
    isInteractive: () => false,
    getExperimentalZedIntegration: () => false,
    getClearContextOnIdle: () => ({
      toolResultsThresholdMinutes: 30,
      toolResultsNumToKeep: 1,
    }),
    getUsageStatisticsEnabled: () => false,
    getToolRegistry: () => undefined,
  });
  const summary: Content[] = [
    { role: 'user', parts: [{ text: 'preserved summary' }] },
    { role: 'model', parts: [{ text: 'Acknowledged.' }] },
  ];
  recorder.recordChatCompression({
    info: {
      originalTokenCount: 100,
      newTokenCount: 10,
      compressionStatus: CompressionStatus.COMPRESSED,
    },
    compressedHistory: summary,
    summaryPrefixLength: 2,
  });
  const input: Content = { role: 'user', parts: [{ text: 'keep' }] };
  markApiHistoryPrompt(input, 'api-kept');
  const reply: Content = {
    role: 'model',
    parts: [
      { text: 'thought '.repeat(100), thought: true },
      { text: 'answer' },
    ],
  };
  recorder.recordUserMessage(
    'keep',
    undefined,
    undefined,
    'api-kept',
    'daemon-kept',
  );
  recorder.recordAssistantTurn({ model: 'model', message: reply.parts! });
  const chat = new LlmChat(config, {}, [...summary, input, reply], recorder);
  expect(chat.compressFast().info.compressionStatus).toBe(
    CompressionStatus.COMPRESSED,
  );
  const catalog = await recorder.getMessageGroups();
  await recorder.deleteMessageGroups({
    snapshot: catalog.snapshot,
    groupIds: [catalog.groups[0]!.id],
  });
  const checkpoints = parseMessageGroupTranscript(
    await fs.readFile(transcriptPath, 'utf8'),
  ).filter((record) => record.subtype === 'chat_compression');
  for (const record of checkpoints) {
    const payload = record.systemPayload as {
      summaryPrefixLength: number;
      compressedHistory: Content[];
    };
    expect(payload.summaryPrefixLength).toBe(2);
    expect(payload.compressedHistory.slice(0, 2)).toEqual(summary);
  }
});

it('does not acquire a lease or poison legacy recording on a failed listing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-delete-read-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const config = {
    storage: { getProjectDir: () => root, getRuntimeBaseDir: () => root },
    isSessionWriterLeaseEnabled: () => false,
    getSessionId: () => 'session',
    getResumedSessionData: () => undefined,
    getProjectRoot: () => root,
    getCliVersion: () => 'test',
    getModel: () => 'model',
    getAuthType: () => undefined,
    getApprovalMode: () => ApprovalMode.DEFAULT,
  } as unknown as Config;
  const failure = vi.fn();
  const recorder = new ChatRecordingService(config, failure);
  cleanups.push(() => recorder.close().catch(() => undefined));
  recorder.recordUserMessage('before');
  await recorder.flush();
  const acquire = vi.spyOn(SessionWriterLease, 'acquire');
  const read = vi
    .spyOn(nodeFs.promises, 'readFile')
    .mockRejectedValueOnce(new Error('read failed'));
  await expect(recorder.getMessageGroups()).rejects.toThrow('read failed');
  read.mockRestore();
  expect(recorder.supportsMessageGroupDeletion()).toBe(true);
  expect(recorder.hasWriteOwnership()).toBe(false);
  recorder.recordUserMessage('after');
  await recorder.flush();
  expect((await recorder.getMessageGroups()).groups).toHaveLength(2);
  expect(acquire).not.toHaveBeenCalled();
  const catalog = await recorder.getMessageGroups();
  acquire.mockRejectedValueOnce(new SessionWriterUnavailableError());
  await expect(
    recorder.deleteMessageGroups({
      snapshot: catalog.snapshot,
      groupIds: [catalog.groups[0]!.id],
    }),
  ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
  recorder.recordUserMessage('after rejected mutation');
  await recorder.flush();
  expect((await recorder.getMessageGroups()).groups).toHaveLength(3);
  expect(failure).not.toHaveBeenCalled();
});

it('retains a turn watermark after all originals are physically removed', async () => {
  const { recorder, transcriptPath } = await fixture();
  recorder.recordUserMessage(
    'last turn',
    undefined,
    undefined,
    'session########42',
    'daemon-last',
  );
  const before = await recorder.getMessageGroups();
  await recorder.deleteMessageGroups({
    snapshot: before.snapshot,
    groupIds: before.groups.map((group) => group.id),
  });
  const records = parseMessageGroupTranscript(
    await fs.readFile(transcriptPath, 'utf8'),
  );
  expect(computeInitialTurnFromHistory(records, 'session')).toBe(42);
  expect(records.some((record) => record.type === 'user')).toBe(false);
});
