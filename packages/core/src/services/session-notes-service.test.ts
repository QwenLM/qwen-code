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
import {
  SessionWriterLostError,
  type SessionWriterLease,
} from './session-writer-lease.js';
import * as jsonl from '../utils/jsonl-utils.js';

describe('local session notes', () => {
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
      getResumedSessionData: () => undefined,
      getSessionService: () => sessions,
      getChatCompression: () => ({ strategy: 'notes' }),
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

  it('persists a bounded canonical revision before projecting Markdown and restores it cold', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    expect(revision.sourceLeafUuid).toBe(revision.windowId);
    expect((await jsonl.read<ChatRecord>(transcriptPath)).at(-1)).toMatchObject(
      {
        uuid: revision.revision,
        subtype: 'session_notes',
        systemPayload: {
          text: revision.text,
          sourceLeafUuid: revision.sourceLeafUuid,
        },
      },
    );
    const projection = transcriptPath.replace(/\.jsonl$/, '.notes.md');
    expect(await fs.readFile(projection, 'utf8')).toContain(revision.text);
    expect((await fs.stat(projection)).mode & 0o777).toBe(0o600);
    const restored = await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    });
    expect(restored?.runtime.recording.sessionNotes?.notes).toEqual(revision);
    const cold = new ChatRecordingService(
      config,
      undefined,
      false,
      restored!.runtime.recording,
    );
    await cold.recordCustomTitle('cold title');
    expect(cold.getSessionNotesState().notes).toEqual(revision);
    await fs.rm(projection);
    expect(await new SessionNotesService(config, cold).read()).toEqual(
      revision,
    );
    expect(await fs.readFile(projection, 'utf8')).toContain(revision.text);
  });

  it('waits for a complete response, then rejects mixed tools and visible assistant text', async () => {
    recorder.recordUserMessage('keep the constraint');
    notes.beginResponse(
      recorder.observeNotesInput(createUserContent('keep the constraint')),
    );
    const pending = notes.write('checkpoint', notes.captureResponse(), signal);
    let finished = false;
    void pending.finally(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    notes.finishResponse([{ functionCall: { name: ToolNames.SESSION_NOTES } }]);
    await expect(pending).resolves.toMatchObject({ text: 'checkpoint' });
    for (const extra of [
      { functionCall: { name: ToolNames.READ_FILE } },
      { text: 'ordinary assistant work' },
    ]) {
      await expect(
        notes.write(
          'bad checkpoint',
          respond(ToolNames.SESSION_NOTES, '', [extra]),
          signal,
        ),
      ).rejects.toThrow('tool-only');
    }
  });

  it('does not cover merely recorded user input, and does not consume equal input twice', async () => {
    recorder.recordUserMessage('keep the constraint');
    const response = respond(ToolNames.SESSION_NOTES);
    recorder.recordUserMessage('new instruction');
    await expect(
      notes.write('old observation', response, signal),
    ).rejects.toThrow('stale');
    expect(
      recorder.observeNotesInput(createUserContent('keep the constraint')),
    ).toBeUndefined();
    expect(
      recorder.observeNotesInput(createUserContent('new instruction'))
        ?.latestUser?.text,
    ).toBe('new instruction');
    recorder.recordUserMessage('same');
    recorder.recordUserMessage('same');
    expect(
      recorder.observeNotesInput(createUserContent('same')),
    ).toBeUndefined();
    expect(
      recorder.observeNotesInput(createUserContent('same'))?.latestUser?.text,
    ).toBe('same');
  });

  it('binds expanded ACP input to its record and releases handled local commands', async () => {
    const recordId = recorder.recordUserMessage('image-only display text')!;
    const input = createUserContent([
      { inlineData: { mimeType: 'image/png', data: 'image' } },
    ]);
    expect(recorder.observeNotesInput(input)).toBeUndefined();
    recorder.bindNotesInput(recordId, input);
    expect(recorder.observeNotesInput(input)?.latestUser?.text).toBe(
      'image-only display text',
    );
    const localCommand = recorder.recordUserMessage('/status')!;
    recorder.releaseNotesInput(localCommand);
    recorder.recordUserMessage('continue');
    expect(
      recorder.observeNotesInput(createUserContent('continue'))?.latestUser
        ?.text,
    ).toBe('continue');
  });

  it('accepts consumed, guarded tool results by call identity and ignores maintenance traffic', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    recorder.recordToolResult([
      {
        functionResponse: {
          id: 'ordinary',
          name: ToolNames.READ_FILE,
          response: { output: 'large recorded evidence' },
        },
      },
    ]);
    expect(await notes.getNotesForHandoff()).toBeUndefined();
    const pending = createUserContent([
      {
        functionResponse: {
          id: 'ordinary',
          name: ToolNames.READ_FILE,
          response: { output: 'guarded evidence' },
        },
      },
    ]);
    expect((await notes.getNotesForHandoff(pending))?.notes).toEqual(revision);
    expect(await notes.getNotesForHandoff()).toBeUndefined();
    expect(recorder.observeNotesInput(pending)).toBeDefined();
    recorder.recordToolResult([
      {
        functionResponse: {
          id: 'meta',
          name: ToolNames.SESSION_HISTORY,
          response: { output: 'retrieved evidence' },
        },
      },
    ]);
    expect((await notes.getNotesForHandoff())?.notes).toEqual(revision);
    await notes.requestReset(
      revision.revision,
      respond(ToolNames.NEW_CONTEXT, ''),
      signal,
    );
    expect(notes.takePendingReset()).toBe(revision.revision);
  });

  it('reuses saved notes after ordinary assistant progress without changing their coverage', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    recorder.recordAssistantTurn({
      model: 'test',
      message: [{ text: 'Completed the next step.' }],
    });
    expect(recorder.getSessionNotesState().sourceLeafUuid).not.toBe(
      revision.sourceLeafUuid,
    );
    expect((await notes.getNotesForHandoff())?.notes).toEqual(revision);
    await notes.requestReset(
      revision.revision,
      respond(ToolNames.NEW_CONTEXT, ''),
      signal,
    );
    expect(notes.takePendingReset()).toBe(revision.revision);
  });

  it('requires all pending input in the actual checkpoint without consuming it or duplicating the latest user', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    recorder.recordUserMessage('new steering');
    const pending = createUserContent('new steering');
    const state = recorder.getSessionNotesState();
    expect(await notes.getNotesForHandoff()).toBeUndefined();
    expect(await notes.getNotesForHandoff(pending)).toEqual({
      notes: revision,
      latestUser: undefined,
    });
    expect(await notes.getNotesForHandoff()).toBeUndefined();
    await expect(
      recorder.recordChatCompressionStrict(
        makeCheckpoint([
          createUserContent('checkpoint'),
          { role: 'model', parts: [{ text: 'ack' }] },
        ]),
        revision,
        signal,
        state,
      ),
    ).rejects.toThrow('pending session input');
    await recorder.recordChatCompressionStrict(
      makeCheckpoint([
        createUserContent('checkpoint'),
        { role: 'model', parts: [{ text: 'ack' }] },
        pending,
      ]),
      revision,
      signal,
      state,
    );
    const restored = await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    });
    expect(
      JSON.stringify(restored?.runtime.apiHistory).match(/new steering/gu),
    ).toHaveLength(1);
    expect(await notes.getNotesForHandoff()).toBeUndefined();
    expect(recorder.observeNotesInput(pending)?.latestUser?.text).toBe(
      'new steering',
    );
    expect((await notes.getNotesForHandoff())?.notes).toEqual(revision);
    recorder.recordUserMessage('same');
    recorder.recordUserMessage('same');
    expect(
      await notes.getNotesForHandoff(createUserContent('same')),
    ).toBeUndefined();
    expect(
      (
        await notes.getNotesForHandoff(
          createUserContent([{ text: 'same' }, { text: 'same' }]),
        )
      )?.notes,
    ).toEqual(revision);
  });

  it('rejects concurrent input during handoff and does not revive a superseded revision', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    const state = recorder.getSessionNotesState();
    recorder.recordUserMessage('steering during compression');
    await expect(
      recorder.recordChatCompressionStrict(
        makeCheckpoint([createUserContent('checkpoint')]),
        revision,
        signal,
        state,
      ),
    ).rejects.toThrow('New session input arrived');
    recorder.observeNotesInput(
      createUserContent('steering during compression'),
    );
    await write('updated task');
    await expect(
      recorder.recordChatCompressionStrict(
        makeCheckpoint([createUserContent('checkpoint')]),
        revision,
        signal,
        recorder.getSessionNotesState(),
      ),
    ).rejects.toThrow('revision changed');
    await expect(
      notes.requestReset(
        revision.revision,
        respond(ToolNames.NEW_CONTEXT, ''),
        signal,
      ),
    ).rejects.toThrow('missing or changed');
  });

  it('rechecks the reset observation after reading notes', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    const response = respond(ToolNames.NEW_CONTEXT, '');
    const read = notes.read.bind(notes);
    vi.spyOn(notes, 'read').mockImplementationOnce(async () => {
      const result = await read();
      recorder.recordUserMessage('arrived during reset');
      recorder.observeNotesInput(createUserContent('arrived during reset'));
      return result;
    });
    await expect(
      notes.requestReset(revision.revision, response, signal),
    ).rejects.toThrow('observation is stale');
    expect(notes.takePendingReset()).toBeUndefined();
  });

  it('rejects oversized ASCII and CJK notes, and cancels a pending reset on new input or abort', async () => {
    recorder.recordUserMessage('keep the constraint');
    const response = respond(ToolNames.SESSION_NOTES);
    for (const text of ['x'.repeat(16385), '汉'.repeat(1400), ' ']) {
      await expect(notes.write(text, response, signal)).rejects.toThrow(
        'Notes must be nonempty',
      );
    }
    const revision = await write();
    await notes.requestReset(
      revision.revision,
      respond(ToolNames.NEW_CONTEXT, ''),
      signal,
    );
    recorder.recordUserMessage('steering');
    expect(notes.takePendingReset()).toBeUndefined();
    await notes.write(
      'new task',
      respond(ToolNames.SESSION_NOTES, 'steering'),
      signal,
    );
    const current = (await notes.read())!;
    const controller = new AbortController();
    await notes.requestReset(
      current.revision,
      respond(ToolNames.NEW_CONTEXT, ''),
      controller.signal,
    );
    controller.abort();
    expect(notes.takePendingReset()).toBeUndefined();
  });

  it('keeps notes readable after switching to a smaller model but requires shortening before reset', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write('Preserve user constraints.\n'.repeat(200));
    const generatorConfig = config.getContentGeneratorConfig()!;
    vi.spyOn(config, 'getContentGeneratorConfig').mockReturnValue({
      ...generatorConfig,
      contextWindowSize: 8192,
    });

    expect(await notes.read()).toEqual(revision);
    await expect(notes.getNotesForHandoff()).rejects.toThrow(
      '819 estimated tokens',
    );
    await expect(
      notes.requestReset(
        revision.revision,
        respond(ToolNames.NEW_CONTEXT, ''),
        signal,
      ),
    ).rejects.toThrow('819 estimated tokens');
    expect(notes.takePendingReset()).toBeUndefined();

    const shortened = await write(
      'Keep the constraint. Next: inspect evidence.',
    );
    expect((await notes.getNotesForHandoff())?.notes).toEqual(shortened);
    await notes.requestReset(
      shortened.revision,
      respond(ToolNames.NEW_CONTEXT, ''),
      signal,
    );
    expect(notes.takePendingReset()).toBe(shortened.revision);
  });

  it('does not authorize a failed canonical write and repairs a failed Markdown projection', async () => {
    recorder.recordUserMessage('keep the constraint');
    const response = respond(ToolNames.SESSION_NOTES);
    await recorder.flush();
    const projection = transcriptPath.replace(/\.jsonl$/, '.notes.md');
    await fs.mkdir(projection);
    await expect(
      notes.write('durable note', response, signal),
    ).rejects.toThrow();
    await fs.rm(projection, { recursive: true });
    const recovered = await notes.read();
    expect(recovered?.text).toBe('durable note');
    expect(
      await fs.readFile(
        transcriptPath.replace(/\.jsonl$/, '.notes.md'),
        'utf8',
      ),
    ).toContain('durable note');
    vi.spyOn(jsonl, 'writeLine').mockRejectedValueOnce(
      new Error('sync failed'),
    );
    await expect(write('not committed')).rejects.toThrow('sync failed');
    await expect(notes.getNotesForHandoff()).rejects.toThrow('sync failed');
    expect((await reader.readNotesState(sessionId)).notes?.revision).toBe(
      recovered?.revision,
    );
  });

  it('rebuilds notes across a selective-restore rewind without resurrecting the abandoned branch', async () => {
    recorder.recordUserMessage('keep the constraint');
    const first = await write('first branch checkpoint');
    recorder.recordUserMessage('second user task');
    const abandoned = await notes.write(
      'abandoned checkpoint',
      respond(ToolNames.SESSION_NOTES, 'second user task'),
      signal,
    );
    await recorder.flush();
    const restored = (await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    }))!;
    recorder = new ChatRecordingService(
      config,
      undefined,
      false,
      restored.runtime.recording,
    );
    notes = new SessionNotesService(config, recorder);
    recorder.rewindRecording(1, { truncatedCount: 2 });
    expect((await notes.read())?.revision).toBe(first.revision);
    expect(recorder.getSessionNotesState().latestUser?.text).toBe(
      'keep the constraint',
    );
    const again = await reader.readNotesState(sessionId);
    expect(again.notes?.revision).toBe(first.revision);
    expect((await notes.getNotesForHandoff())?.notes.revision).toBe(
      first.revision,
    );
    await expect(
      notes.requestReset(
        abandoned.revision,
        respond(ToolNames.NEW_CONTEXT, ''),
        signal,
      ),
    ).rejects.toThrow('missing or changed');
  });

  it('does not overwrite a newer owner projection after losing the writer lease', async () => {
    recorder.recordUserMessage('keep the constraint');
    await write('old owner checkpoint');
    const restored = (await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    }))!;
    const failure = new SessionWriterLostError();
    const lease = {
      sessionId,
      assertOwnedAndUnchanged: vi.fn().mockRejectedValue(failure),
    } as unknown as SessionWriterLease;
    recorder = new ChatRecordingService(config, undefined, true);
    recorder.activate(lease, undefined, undefined, restored.runtime.recording);
    notes = new SessionNotesService(config, recorder);
    const projection = transcriptPath.replace(/\.jsonl$/, '.notes.md');
    await fs.writeFile(projection, 'new owner checkpoint');

    await expect(notes.read()).rejects.toBe(failure);
    expect(await fs.readFile(projection, 'utf8')).toBe('new owner checkpoint');
  });

  it('reuses the same notes across windows and cold replay while recording the actual preceding window', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    const pending = createUserContent([
      {
        functionResponse: {
          id: 'reset',
          name: ToolNames.NEW_CONTEXT,
          response: { status: 'pending' },
        },
      },
    ]);
    recorder.recordToolResult(pending.parts!);
    const checkpoint = [
      createUserContent('Resume the prior task: checkpoint'),
      {
        role: 'model',
        parts: [{ text: 'Got it. Thanks for the additional context!' }],
      },
      pending,
    ];
    const window = await recorder.recordChatCompressionStrict(
      {
        info: {
          originalTokenCount: 10000,
          newTokenCount: 100,
          compressionStatus: CompressionStatus.COMPRESSED,
          strategy: 'notes',
        },
        compressedHistory: checkpoint,
      },
      revision,
      signal,
      recorder.getSessionNotesState(),
    );
    const restored = (await reader.readRestoreProjection(sessionId, {
      replay: { kind: 'none' },
    }))!;
    expect(restored.runtime.recording.sessionNotes?.windowId).toBe(window);
    expect(
      JSON.stringify(restored.runtime.apiHistory).match(/"id":"reset"/gu),
    ).toHaveLength(1);
    recorder = new ChatRecordingService(
      config,
      undefined,
      false,
      restored.runtime.recording,
    );
    notes = new SessionNotesService(config, recorder);
    expect((await notes.getNotesForHandoff())?.notes).toEqual(revision);
    await notes.requestReset(
      revision.revision,
      respond(ToolNames.NEW_CONTEXT, ''),
      signal,
    );
    expect(notes.takePendingReset()).toBe(revision.revision);
    const payload = makeCheckpoint([createUserContent('checkpoint')]);
    const next = await recorder.recordChatCompressionStrict(
      payload,
      revision,
      signal,
      recorder.getSessionNotesState(),
    );
    const records = await jsonl.read<ChatRecord>(transcriptPath);
    expect(records.at(-1)?.systemPayload).toMatchObject({
      notes: {
        revision: revision.revision,
        sourceLeafUuid: revision.sourceLeafUuid,
        previousWindowId: window,
        windowId: next,
      },
    });
    expect((await notes.getNotesForHandoff())?.notes).toEqual(revision);
  });

  it('forks independent projections and moves/removes them with session lifecycle', async () => {
    recorder.recordUserMessage('keep the constraint');
    const revision = await write();
    const forkId = randomUUID();
    const fork = await sessions.forkSession(sessionId, forkId);
    const forkNotes = fork.filePath.replace(/\.jsonl$/, '.notes.md');
    expect(await fs.readFile(forkNotes, 'utf8')).toContain(revision.text);
    expect((await reader.readNotesState(forkId)).notes?.revision).toBe(
      revision.revision,
    );
    await write('parent changed');
    expect(await fs.readFile(forkNotes, 'utf8')).not.toContain(
      'parent changed',
    );
    expect((await sessions.archiveSessions([forkId])).errors).toEqual([]);
    await expect(fs.stat(forkNotes)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await sessions.unarchiveSessions([forkId])).errors).toEqual([]);
    expect(await fs.readFile(forkNotes, 'utf8')).toContain(revision.text);
    await sessions.removeSession(forkId);
    await expect(fs.stat(forkNotes)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
