/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Content, Part } from '@google/genai';
import type { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { createUserContent } from '../core/genai-compat.js';
import { CompressionStatus } from '../core/turn.js';
import { ToolNames } from '../tools/tool-names.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import { SessionNotesService } from './session-notes-service.js';
import { SessionTranscriptReader } from './session-transcript-reader.js';
import { SessionService } from './sessionService.js';
import { type SessionWriterLease } from './session-writer-lease.js';
import * as jsonl from '../utils/jsonl-utils.js';

describe('Nov5 notes regressions', () => {
  let runtime: string;
  let workspace: string;
  let sessionId: string;
  let config: Config;
  let recorder: ChatRecordingService;
  let notes: SessionNotesService;
  let reader: SessionTranscriptReader;
  let sessions: SessionService;
  let transcriptPath: string;
  const signal = new AbortController().signal;

  beforeEach(async () => {
    runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-notes-unit-'));
    workspace = path.join(runtime, 'workspace');
    await fs.mkdir(workspace);
    sessionId = randomUUID();
    const storage = new Storage(workspace, runtime);
    sessions = new SessionService(workspace, { runtimeBaseDir: runtime });
    reader = new SessionTranscriptReader(workspace, undefined, runtime);
    config = {
      storage,
      getSessionId: () => sessionId,
      getProjectRoot: () => workspace,
      getCliVersion: () => 'test',
      getModel: () => 'test',
      getAuthType: () => undefined,
      getApprovalMode: () => 'default',
      getResumedSessionData: () => undefined,
      getSessionService: () => sessions,
      getChatCompression: () => ({ strategy: 'notes' }),
      getToolRegistry: () => ({
        getFunctionDeclarations: () =>
          [
            'session_notes',
            'session_history',
            'get_context_remaining',
            'new_context',
          ].map((name) => ({ name })),
      }),
      getContentGeneratorConfig: () => ({ contextWindowSize: 128000 }),
    } as unknown as Config;
    recorder = new ChatRecordingService(config, undefined, false);
    notes = new SessionNotesService(config, recorder);
    transcriptPath = path.join(
      storage.getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
  });

  afterEach(async () => {
    await recorder.flush().catch(() => undefined);
    vi.restoreAllMocks();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  function respond(
    name: string,
    input = 'keep the constraint',
    extra: Part[] = [],
  ) {
    notes.beginResponse(recorder.observeNotesInput(createUserContent(input)));
    const parts: Part[] = [
      { functionCall: { id: randomUUID(), name, args: {} } },
      ...extra,
    ];
    recorder.recordAssistantTurn({ model: 'test', message: parts });
    notes.finishResponse(parts);
    return notes.captureResponse();
  }

  async function write(
    text = '# Goal\nKeep the constraint. Next: inspect evidence.',
  ) {
    return notes.write(text, respond(ToolNames.SESSION_NOTES), signal);
  }

  function makeCheckpoint(compressedHistory: Content[]) {
    return {
      info: {
        originalTokenCount: 10000,
        newTokenCount: 100,
        compressionStatus: CompressionStatus.COMPRESSED,
        strategy: 'notes' as const,
      },
      compressedHistory,
    };
  }

  it('R2-4 releases a tool-result batch while retaining unmatched pending user input', async () => {
    recorder.recordUserMessage('keep the constraint');
    await write();
    const results: Part[] = ['read-a', 'read-b'].map((id) => ({
      functionResponse: { id, name: 'read_file', response: { output: id } },
    }));
    for (const result of results) recorder.recordToolResult([result]);
    recorder.recordUserMessage('new steering must remain pending');
    recorder.releaseNotesInputs(createUserContent(results));
    expect(() => recorder.getNotesHandoffState()).toThrow(
      'pending session input',
    );
    expect(
      recorder.observeNotesInput(createUserContent('unrelated input')),
    ).toBeUndefined();
    const observed = recorder.observeNotesInput(
      createUserContent('new steering must remain pending'),
    );
    expect(observed).toBeDefined();
    expect(observed?.latestUser?.text).toBe('new steering must remain pending');
    await expect(
      notes.write(
        'Preserve the new steering.',
        respond(ToolNames.SESSION_NOTES, ''),
        signal,
      ),
    ).resolves.toMatchObject({ text: 'Preserve the new steering.' });
  });

  it('R2-18 does not accumulate inputs while notes tools are unavailable', async () => {
    const { LlmChat } = await import('../core/llm-chat.js');
    Object.assign(config, {
      getDebugLogger: () => ({ warn: vi.fn() }),
      getToolRegistry: () => ({
        getFunctionDeclarations: () => [{ name: 'session_notes' }],
      }),
    });
    const chat = new LlmChat(config, {}, [], recorder);
    expect(chat.getSessionNotesService()).toBeUndefined();
    for (let i = 0; i < 50; i++) recorder.recordUserMessage('pending ' + i);
    const count = (recorder as unknown as { unobservedNotesInputs: unknown[] })
      .unobservedNotesInputs.length;
    expect(count).toBe(0);
  });
  it('R2-5 rejects resurrected notes with a missing covered source during rebuild', async () => {
    recorder.recordUserMessage(
      'keep the constraint',
      undefined,
      undefined,
      'first',
    );
    await write();
    await recorder.recordChatCompressionStrict(
      makeCheckpoint([createUserContent('checkpoint')]),
      undefined,
      signal,
      recorder.getSessionNotesState(),
    );
    recorder.recordUserMessage('second source', undefined, undefined, 'second');
    const revision = await notes.write(
      'checkpoint describing deleted second source',
      respond(ToolNames.SESSION_NOTES, 'second source'),
      signal,
    );
    recorder.recordUserMessage(
      'surviving request',
      undefined,
      undefined,
      'third',
    );
    await recorder.flush();
    const records = await jsonl.read<ChatRecord>(transcriptPath);
    expect(revision.windowId).not.toBe(revision.sourceLeafUuid);
    const surviving = records.filter((r) => r.uuid !== revision.sourceLeafUuid);
    recorder.rebuildTurnBoundaries(surviving);
    console.log('R2-5 rebuilt notes', recorder.getSessionNotesState().notes);
    expect(recorder.getSessionNotesState().notes).toBeUndefined();
    const userTurns = surviving.filter((record) => record.type === 'user');
    const target = userTurns.findIndex((record) =>
      record.message?.parts?.some((part) => part.text === 'surviving request'),
    );
    expect(target).toBe(1);
    recorder.rewindRecording(target, { truncatedCount: 1 });
    expect(recorder.getSessionNotesState().notes).toBeUndefined();
  });
  it('R2-12 retains canonical notes when the Markdown sidecar is unwritable', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    const projection = transcriptPath.replace(/\.jsonl$/, '.notes.md');
    await fs.rm(projection);
    await fs.mkdir(projection);
    notes = new SessionNotesService(config, recorder);
    await expect(notes.getNotesForHandoff()).resolves.toMatchObject({
      notes: { revision: revision.revision },
    });
  });
  it('R2-7 a queued notes read does not poison the writer when close begins', async () => {
    recorder.recordUserMessage('keep the constraint');
    await write();
    const restored = (await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    }))!;
    const lease = {
      sessionId,
      assertOwnedAndUnchanged: vi.fn().mockResolvedValue(undefined),
      sealForHandoff: vi.fn().mockResolvedValue(undefined),
      release: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionWriterLease;
    recorder = new ChatRecordingService(config, undefined, true);
    recorder.activate(lease, undefined, undefined, restored.runtime.recording);
    notes = new SessionNotesService(config, recorder);
    const original = recorder.runWithWriteBarrier.bind(recorder);
    let resume!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => (entered = r));
    const paused = new Promise<void>((r) => (resume = r));
    vi.spyOn(recorder, 'runWithWriteBarrier').mockImplementation((operation) =>
      original(async () => {
        entered();
        await paused;
        return operation();
      }),
    );
    const reading = notes.read().then(
      () => 'read ok',
      (e) => String(e),
    );
    await ready;
    const closing = recorder.close({ handoff: true }).then(
      () => 'close ok',
      (e) => String(e),
    );
    resume();
    const results = await Promise.all([reading, closing]);
    console.log('R2-7 results', results);
    await expect(recorder.flush()).resolves.toBeUndefined();
  });
  it('R2-23 source deletion is independently detected after a compression', async () => {
    recorder.recordUserMessage(
      'keep the constraint',
      undefined,
      undefined,
      'first',
    );
    await write();
    await recorder.recordChatCompressionStrict(
      makeCheckpoint([createUserContent('checkpoint')]),
      undefined,
      signal,
      recorder.getSessionNotesState(),
    );
    recorder.recordUserMessage('second source', undefined, undefined, 'second');
    const revision = await notes.write(
      'checkpoint with distinct source and window',
      respond(ToolNames.SESSION_NOTES, 'second source'),
      signal,
    );
    await recorder.flush();
    const records = await jsonl.read<ChatRecord>(transcriptPath);
    expect(revision.windowId).not.toBe(revision.sourceLeafUuid);
    const kept = records.filter((r) => r.uuid !== revision.sourceLeafUuid);
    for (const r of kept)
      if (r.parentUuid === revision.sourceLeafUuid)
        r.parentUuid = records.find(
          (v) => v.uuid === revision.sourceLeafUuid,
        )!.parentUuid;
    await fs.writeFile(
      transcriptPath,
      kept.map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    expect((await reader.readNotesState(sessionId)).notes).toBeUndefined();
  });
});
