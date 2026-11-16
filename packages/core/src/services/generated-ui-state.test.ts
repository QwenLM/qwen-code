/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ApprovalMode } from '../config/approval-mode.js';
import { prepareTranscriptRecords } from '../utils/transcript-records.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import { SessionWriterLease } from './session-writer-lease.js';
import { selectActiveSideArtifactRecordUuids } from './session-artifact-persistence.js';
import {
  GENERATED_UI_STATE_MAX_BYTES,
  GENERATED_UI_STATE_MAX_CARDS,
  GeneratedUiStateError,
  GeneratedUiStateService,
  restoreGeneratedUiStates,
  selectActiveGeneratedUiStateRecordUuids,
  type GeneratedUiStateRecordPayload,
  type GeneratedUiStateRestore,
} from './generated-ui-state.js';

const CARD = 'gc_aaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'gc_bbbbbbbbbbbbbbbbbbbbbb';

function service(initial: GeneratedUiStateRestore = {}) {
  let restore = initial;
  let generation = 0;
  const persisted: GeneratedUiStateRecordPayload[] = [];
  const persist = vi.fn(async (payload: GeneratedUiStateRecordPayload) => {
    persisted.push(payload);
  });
  const load = vi.fn(async () => restore);
  const state = new GeneratedUiStateService({
    load,
    persist,
    branchGeneration: () => generation,
  });
  return {
    state,
    persisted,
    persist,
    load,
    replaceBranch(next: GeneratedUiStateRestore) {
      restore = next;
      generation += 1;
    },
  };
}

describe('GeneratedUiStateService', () => {
  it('reports a never-saved card as revision 0 with a null value', async () => {
    const { state } = service();
    await expect(state.get(CARD)).resolves.toEqual({
      cardId: CARD,
      revision: 0,
      value: null,
    });
  });

  it('saves against the current revision and rejects a stale writer with the current value', async () => {
    const { state, persisted } = service();
    await expect(state.set(CARD, 0, { items: ['a'] })).resolves.toEqual({
      outcome: 'saved',
      cardId: CARD,
      revision: 1,
    });
    await expect(state.set(CARD, 0, { items: ['b'] })).resolves.toEqual({
      outcome: 'stale',
      cardId: CARD,
      revision: 1,
      value: { items: ['a'] },
    });
    await expect(state.get(CARD)).resolves.toEqual({
      cardId: CARD,
      revision: 1,
      value: { items: ['a'] },
    });
    expect(persisted).toEqual([
      { version: 1, cardId: CARD, revision: 1, value: { items: ['a'] } },
    ]);
  });

  it('acknowledges an unchanged value without appending a record', async () => {
    const { state, persist } = service();
    await state.set(CARD, 0, { n: 1 });
    await expect(state.set(CARD, 1, { n: 1 })).resolves.toEqual({
      outcome: 'saved',
      cardId: CARD,
      revision: 1,
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('reports an oversized value without persisting it', async () => {
    const { state, persist } = service();
    const value = 'x'.repeat(GENERATED_UI_STATE_MAX_BYTES);
    await expect(state.set(CARD, 0, value)).resolves.toEqual({
      outcome: 'too_large',
      cardId: CARD,
      limitBytes: GENERATED_UI_STATE_MAX_BYTES,
    });
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects malformed card ids, revisions and non-JSON values', async () => {
    const { state } = service();
    for (const call of [
      () => state.get('card-1'),
      () => state.set('gc_short', 0, 1),
      () => state.set(CARD, -1, 1),
      () => state.set(CARD, 0.5, 1),
      () => state.set(CARD, 0, undefined),
      () => state.set(CARD, 0, () => 1),
    ]) {
      expect(call).toThrow(GeneratedUiStateError);
    }
  });

  it('limits how many cards one session can save', async () => {
    const states = new Map(
      Array.from({ length: GENERATED_UI_STATE_MAX_CARDS }, (_, index) => [
        `gc_${String(index).padStart(22, '0')}`,
        { revision: 1, value: index },
      ]),
    );
    const { state } = service({ states });
    await expect(state.set(CARD, 0, 1)).rejects.toMatchObject({
      code: 'state_card_limit',
    });
    // An existing card can still be updated.
    await expect(
      state.set(`gc_${'0'.repeat(22)}`, 1, 'updated'),
    ).resolves.toMatchObject({ outcome: 'saved', revision: 2 });
  });

  it('never treats an unreadable transcript as empty state', async () => {
    const { state } = service({ unavailable: true });
    await expect(state.get(CARD)).rejects.toMatchObject({
      code: 'state_unavailable',
    });
  });

  it('reloads after a failed save and after the active branch is replaced', async () => {
    const harness = service({
      states: new Map([[CARD, { revision: 3, value: 'before' }]]),
    });
    harness.persist.mockRejectedValueOnce(new Error('disk full'));
    await expect(harness.state.set(CARD, 3, 'lost')).rejects.toMatchObject({
      code: 'state_unavailable',
    });
    await expect(harness.state.get(CARD)).resolves.toMatchObject({
      revision: 3,
      value: 'before',
    });
    expect(harness.load).toHaveBeenCalledTimes(2);

    harness.replaceBranch({
      states: new Map([[CARD, { revision: 1, value: 'rewound' }]]),
    });
    await expect(harness.state.get(CARD)).resolves.toMatchObject({
      revision: 1,
      value: 'rewound',
    });
    await expect(harness.state.get(OTHER)).resolves.toMatchObject({
      revision: 0,
    });
    expect(harness.load).toHaveBeenCalledTimes(3);
  });
});

describe('Generated UI state in a recorded transcript', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function recording() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-ui-state-'));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const transcriptPath = path.join(root, 'chats', 'session.jsonl');
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: root,
      sessionId: 'session',
      transcriptPath,
    });
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
    let turn = 0;
    const save = (cardId: string, revision: number, value: unknown) =>
      recorder.recordGeneratedUiState({ version: 1, cardId, revision, value });
    const prompt = (text: string) =>
      recorder.recordUserMessage(
        text,
        undefined,
        undefined,
        `prompt-${turn}`,
        `daemon-${turn++}`,
      );
    const reply = (text: string) =>
      recorder.recordAssistantTurn({ model: 'model', message: text });
    const read = async () => {
      await recorder.flush();
      const records = (await fs.readFile(transcriptPath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ChatRecord);
      const active = prepareTranscriptRecords(records).records.map(
        (record) => record.uuid,
      );
      const selected = new Set(
        selectActiveGeneratedUiStateRecordUuids(records, active),
      );
      return {
        records,
        active,
        states: restoreGeneratedUiStates(
          records.filter((record) => selected.has(record.uuid)),
        ),
      };
    };
    return { recorder, save, prompt, reply, read };
  }

  it('reads back every acknowledged save, at an idle tail, mid-turn and between side records', async () => {
    const { recorder, save, prompt, reply, read } = await recording();
    prompt('show a checklist');
    reply('here it is');
    await save(CARD, 1, 'idle');
    await save(CARD, 2, 'idle again');
    prompt('add an item');
    await save(OTHER, 1, 'mid-turn');
    recorder.recordFileHistorySnapshot({
      promptId: 'prompt-1',
      trackedFileBackups: {},
      timestamp: new Date(),
    });
    await recorder.recordSessionArtifactEvent({
      version: 1,
      sessionId: 'session',
      sequence: 1,
      changes: [],
    } as never);
    await save(CARD, 3, 'after side records');
    reply('added');
    const { states } = await read();
    expect(Object.fromEntries(states)).toEqual({
      [CARD]: { revision: 3, value: 'after side records' },
      [OTHER]: { revision: 1, value: 'mid-turn' },
    });
  });

  it('drops saves made on a branch that a rewind abandons', async () => {
    const { recorder, save, prompt, reply, read } = await recording();
    prompt('first');
    reply('one');
    await save(CARD, 1, 'kept');
    prompt('second');
    reply('two');
    await save(CARD, 2, 'abandoned');
    const before = recorder.getBranchGeneration();
    recorder.rewindRecording(1, { truncatedCount: 2 });
    expect(recorder.getBranchGeneration()).not.toBe(before);
    expect(Object.fromEntries((await read()).states)).toEqual({
      [CARD]: { revision: 1, value: 'kept' },
    });
    // A save right after the rewind, before any new prompt, stays.
    await save(CARD, 2, 'after rewind');
    expect(Object.fromEntries((await read()).states)).toEqual({
      [CARD]: { revision: 2, value: 'after rewind' },
    });
    prompt('third');
    reply('three');
    expect((await read()).states.get(CARD)?.value).toBe('after rewind');
  });

  it('refuses a save before there is any conversation to attach it to', async () => {
    const { save, prompt, reply, read } = await recording();
    await expect(save(CARD, 1, 'orphan')).rejects.toThrow();
    prompt('first');
    reply('one');
    await save(CARD, 1, 'anchored');
    expect((await read()).states.get(CARD)?.value).toBe('anchored');
  });

  it('keeps saves when the messages they were made after are deleted', async () => {
    const { recorder, save, prompt, reply, read } = await recording();
    prompt('first');
    reply('one');
    await save(CARD, 1, 'during first');
    prompt('second');
    reply('two');
    await save(CARD, 2, 'during second');
    const groups = await recorder.getMessageGroups();
    expect(groups.groups).toHaveLength(2);
    await recorder.deleteMessageGroups({
      snapshot: groups.snapshot,
      groupIds: [groups.groups[1]!.id],
    });
    expect(Object.fromEntries((await read()).states)).toEqual({
      [CARD]: { revision: 2, value: 'during second' },
    });
  });

  it('leaves artifact selection unchanged when state saves sit between artifact records', async () => {
    const { recorder, save, prompt, reply, read } = await recording();
    prompt('first');
    reply('one');
    await save(CARD, 1, 'a');
    await recorder.recordSessionArtifactEvent({
      version: 1,
      sessionId: 'session',
      sequence: 1,
      changes: [],
    } as never);
    await save(CARD, 2, 'b');
    prompt('second');
    reply('two');
    const { records, active } = await read();
    const artifactUuids = records
      .filter((record) => record.subtype === 'session_artifact_event')
      .map((record) => record.uuid);
    expect(selectActiveSideArtifactRecordUuids(records, active)).toEqual(
      artifactUuids,
    );
  });
});
