/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config/config.js';
import type { SessionWriterLease } from '../services/session-writer-lease.js';
import { computeInitialTurnFromHistory } from '../services/session-turn-state.js';
import type { Content } from '@google/genai';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { SessionFileHistoryAccumulator } from '../services/session-file-history-state.js';
import {
  deserializeSnapshots,
  FileHistoryService,
  type SerializedFileHistorySnapshot,
} from '../services/fileHistoryService.js';
import {
  deletionDropsRequiredEndpoint,
  removeFileHistorySnapshots,
} from './file-history-snapshots.js';
import { CompressionStatus } from '../core/turn.js';
import { detectTurnInterruption } from '../core/turn-interruption.js';
import { buildApiHistoryFromConversation } from '../services/session-api-history.js';
import {
  prepareTranscriptRecords,
  selectActiveGeneratedUiStateRecordUuids,
  selectActiveSideArtifactRecordUuids,
} from './transcript-records.js';
import {
  MessageGroupDeletionError,
  deleteTranscriptMessageGroups,
  getTranscriptMessageGroups,
  messageGroupsSnapshot,
  parseMessageGroupTranscript,
} from './message-group-deletion.js';

function record(
  uuid: string,
  parentUuid: string | null,
  type: ChatRecord['type'] = 'system',
  extra: Partial<ChatRecord> = {},
): ChatRecord {
  return {
    uuid,
    parentUuid,
    type,
    sessionId: 'session',
    timestamp: '2026-10-15T00:00:00Z',
    cwd: '/project',
    version: '1',
    ...(type !== 'system'
      ? {
          message: {
            role: type === 'assistant' ? 'model' : 'user',
            parts: [{ text: uuid }],
          },
        }
      : {}),
    ...extra,
  };
}

function user(id: string, parent: string | null): ChatRecord {
  return record(id, parent, 'user', {
    promptId: `api-${id}`,
    daemonPromptId: `daemon-${id}`,
  });
}

const anchor = record('anchor', null);

/** The system record `recordMemoryCatalogSnapshot` writes. */
function snapshot(id: string, parent: string | null, text: string): ChatRecord {
  return record(id, parent, 'system', {
    subtype: 'memory_catalog_snapshot',
    message: {
      role: 'user',
      parts: [
        { text, partMetadata: { 'qwen-code:memory-catalog-snapshot': true } },
      ],
    },
  });
}

describe('message group deletion', () => {
  it('deletes nonconsecutive complete turns and repairs only removed edges', () => {
    const records = [
      user('u1', null),
      record('a1', 'u1', 'assistant'),
      user('u2', 'a1'),
      record('a2', 'u2', 'assistant'),
      user('u3', 'a2'),
      record('a3', 'u3', 'assistant'),
    ];
    const { records: kept, result } = deleteTranscriptMessageGroups(
      records,
      ['u1', 'u3'],
      anchor,
    );
    expect(kept.map((item) => [item.uuid, item.parentUuid])).toEqual([
      ['u2', null],
      ['a2', 'u2'],
      ['anchor', 'a2'],
    ]);
    expect(result).toEqual({
      deletedGroupIds: ['u1', 'u3'],
      deletedPromptIds: ['daemon-u1', 'daemon-u3'],
      removedApiPromptIds: ['api-u1', 'api-u3'],
    });
    expect(
      buildApiHistoryFromConversation({ messages: kept }).map(
        (content) => content.parts?.[0]?.text,
      ),
    ).toEqual(['u2', 'a2']);
  });

  it('retains the active empty branch instead of reviving abandoned history', () => {
    const records = [
      user('old', null),
      record('old-reply', 'old', 'assistant'),
      record('rewind', null, 'system', {
        subtype: 'rewind',
        systemPayload: { truncatedCount: 2 },
      }),
      user('new', 'rewind'),
      record('new-reply', 'new', 'assistant'),
    ];
    const { records: kept } = deleteTranscriptMessageGroups(
      records,
      ['new'],
      anchor,
    );
    expect(kept.find((item) => item.uuid === 'old-reply')?.parentUuid).toBe(
      'old',
    );
    const active = prepareTranscriptRecords(kept).records;
    expect(active.map((item) => item.uuid)).toEqual(['rewind', 'anchor']);
    expect(
      buildApiHistoryFromConversation({ messages: active as ChatRecord[] }),
    ).toEqual([]);
  });

  it('keeps an empty session loadable after deleting its only turn', () => {
    const { records: kept } = deleteTranscriptMessageGroups(
      [user('only', null), record('reply', 'only', 'assistant')],
      ['only'],
      anchor,
    );
    expect(kept).toEqual([anchor]);
    expect(getTranscriptMessageGroups(kept)).toEqual([]);
  });

  it('preserves workspace ownership and active artifacts when saved state needs a new root', () => {
    const artifact = (id: string, parent: string | null) =>
      record(id, parent, 'system', {
        subtype: 'session_artifact_event',
        gitBranch: 'original-branch',
      });
    const records = [
      artifact('abandoned-artifact', null),
      user('abandoned', null),
      record('abandoned-reply', 'abandoned', 'assistant'),
      artifact('before-turn', null),
      user('u1', null),
      record('a1', 'u1', 'assistant'),
      artifact('after-turn', 'a1'),
      artifact('artifact-child', 'after-turn'),
      record('card-save', 'a1', 'system', { subtype: 'generated_ui_state' }),
      user('u2', 'a1'),
      record('a2', 'u2', 'assistant'),
    ];
    const { records: kept } = deleteTranscriptMessageGroups(records, ['u1'], {
      ...anchor,
      cwd: '/project/subdirectory',
      gitBranch: 'nested-branch',
    });
    const root = kept[0]!;
    const active = prepareTranscriptRecords(kept).records.map(
      ({ uuid }) => uuid,
    );
    expect(root).toMatchObject({
      cwd: '/project',
      gitBranch: 'original-branch',
    });
    expect(active).toEqual([root.uuid, 'u2', 'a2', anchor.uuid]);
    expect(selectActiveGeneratedUiStateRecordUuids(kept, active)).toEqual([
      'card-save',
    ]);
    expect(selectActiveSideArtifactRecordUuids(kept, active)).toEqual([
      'before-turn',
      'after-turn',
      'artifact-child',
    ]);
  });

  it('remaps directory context identities across a deleted checkpoint turn', () => {
    const u1 = user('u1', null);
    const a1 = record('a1', 'u1', 'assistant');
    const u2 = user('u2', 'a1');
    const a2 = record('a2', 'u2', 'assistant');
    const u3 = user('u3', 'a2');
    const a3 = record('a3', 'u3', 'assistant');
    const firstContext: Content = {
      role: 'user',
      parts: [{ text: 'Directory changed.' }],
    };
    const lastContext: Content = {
      role: 'user',
      parts: [{ text: 'Directory structure.' }],
    };
    const compression = record('compressed', 'a3', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          compressionStatus: CompressionStatus.COMPRESSED,
          originalTokenCount: 100,
          newTokenCount: 50,
        },
        compressedHistory: [
          u1.message!,
          a1.message!,
          firstContext,
          u2.message!,
          a2.message!,
          u3.message!,
          a3.message!,
          lastContext,
        ],
        promptIds: ['api-u1', null, null, 'api-u2', null, 'api-u3', null, null],
        directoryContextIndices: [2, 7],
      },
    });
    const { records: kept } = deleteTranscriptMessageGroups(
      [u1, a1, u2, a2, u3, a3, compression],
      ['u2'],
      anchor,
    );
    expect(
      kept.find((entry) => entry.uuid === 'compressed')?.systemPayload,
    ).toMatchObject({ directoryContextIndices: [2, 5] });
    const restored = buildApiHistoryFromConversation({ messages: kept });
    expect(JSON.stringify(restored)).toBe(
      JSON.stringify([
        u1.message,
        a1.message,
        firstContext,
        u3.message,
        a3.message,
        lastContext,
      ]),
    );
    expect(detectTurnInterruption(restored).kind).toBe('none');
  });

  it('preserves the summary and prunes raw copies and tools from every compression checkpoint', () => {
    const summary: Content = {
      role: 'user',
      parts: [{ text: 'unchanged summary remembers u1' }],
    };
    const ack: Content = { role: 'model', parts: [{ text: 'Acknowledged' }] };
    const u1 = user('u1', null);
    const a1 = record('a1', 'u1', 'assistant');
    const u2 = user('u2', 'a1');
    const a2 = record('a2', 'u2', 'assistant');
    const compression = record('compressed', 'a2', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 100,
          newTokenCount: 20,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [
          summary,
          ack,
          u1.message!,
          a1.message!,
          u2.message!,
          a2.message!,
        ],
        promptIds: [null, null, 'api-u1', null, 'api-u2', null],
      },
    });
    const records = [
      u1,
      a1,
      u2,
      a2,
      compression,
      user('u3', 'compressed'),
      record('a3', 'u3', 'assistant'),
    ];
    const { records: kept } = deleteTranscriptMessageGroups(
      records,
      ['u1', 'u3'],
      anchor,
    );
    const payload = kept.find(
      (item) => item.uuid === 'compressed',
    )!.systemPayload;
    expect(payload).toEqual({
      ...compression.systemPayload,
      compressedHistory: [summary, ack, u2.message, a2.message],
      promptIds: [null, null, 'api-u2', null],
    });
    expect(
      buildApiHistoryFromConversation({ messages: kept }).map(
        (content) => content.parts?.[0]?.text,
      ),
    ).toEqual(['unchanged summary remembers u1', 'Acknowledged', 'u2', 'a2']);
  });

  it('deletes compressed-away original history without changing model input', () => {
    const compression = record('compression', 'a1', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [
          { role: 'user', parts: [{ text: 'summary remembers u1' }] },
        ],
        summaryPrefixLength: 1,
      },
    });
    const records = [
      user('u1', null),
      record('a1', 'u1', 'assistant'),
      compression,
    ];
    const before = buildApiHistoryFromConversation({ messages: records });
    const { records: kept } = deleteTranscriptMessageGroups(
      records,
      ['u1'],
      anchor,
    );
    expect(buildApiHistoryFromConversation({ messages: kept })).toEqual(before);
    expect(kept[0]?.systemPayload).toBe(compression.systemPayload);
  });

  it('groups slash command results and preserves their settings and compression effects', () => {
    const records = [
      user('command', null),
      record('model', 'command', 'system', {
        subtype: 'session_model',
        systemPayload: { modelId: 'new-model', authType: 'openai' },
      }),
      record('result', 'model', 'system', {
        subtype: 'slash_command',
        systemPayload: {
          phase: 'result',
          rawCommand: 'command',
          outputHistoryItems: [{ type: 'assistant', text: 'done' }],
        },
      }),
      user('next', 'result'),
    ];
    expect(getTranscriptMessageGroups(records)[0]?.recordIds).toEqual([
      'command',
      'result',
    ]);
    const { records: kept } = deleteTranscriptMessageGroups(
      records,
      ['command'],
      anchor,
    );
    expect(kept.map((item) => item.uuid)).toEqual(['model', 'next', 'anchor']);
    expect(kept[0]?.systemPayload).toEqual({
      modelId: 'new-model',
      authType: 'openai',
    });
  });

  it('joins turn admission metadata to its persisted user group', () => {
    const records = [
      record('attempt', null, 'system', {
        subtype: 'turn_attempt',
        promptId: 'api-user',
        daemonPromptId: 'daemon-user',
      }),
      user('user', 'attempt'),
      record('reply', 'user', 'assistant'),
    ];
    expect(getTranscriptMessageGroups(records)).toEqual([
      {
        id: 'user',
        promptId: 'daemon-user',
        promptIds: ['daemon-user'],
        recordIds: ['attempt', 'user', 'reply'],
      },
    ]);
  });

  it('keeps retries and continuations in their original group', () => {
    const records = [
      user('user', null),
      record('reply', 'user', 'assistant'),
      record('retry', 'reply', 'system', {
        subtype: 'turn_attempt',
        promptId: 'api-user',
        daemonPromptId: 'daemon-retry',
      }),
      record('continued-reply', 'retry', 'assistant'),
    ];
    expect(getTranscriptMessageGroups(records)).toEqual([
      {
        id: 'user',
        promptId: 'daemon-user',
        promptIds: ['daemon-user', 'daemon-retry'],
        recordIds: ['user', 'reply', 'retry', 'continued-reply'],
      },
    ]);
    const { records: kept, result } = deleteTranscriptMessageGroups(
      records,
      ['user'],
      anchor,
    );
    expect(kept).toEqual([anchor]);
    expect(result.deletedPromptIds).toEqual(['daemon-user', 'daemon-retry']);
  });

  it('keeps injected notices but deletes all replies and tools of the interrupted ordinary group', () => {
    const records = [
      user('user', null),
      record('tool-call', 'user', 'assistant'),
      record('cold-notice', 'tool-call', 'user', { subtype: 'notification' }),
      record('tool-result', 'cold-notice', 'tool_result'),
      record('reply', 'tool-result', 'assistant'),
      record('delivered-notice', 'reply', 'user', {
        subtype: 'notification',
        deliveredTurn: true,
      }),
      record('background-reply', 'delivered-notice', 'assistant'),
    ];
    expect(getTranscriptMessageGroups(records)[0]?.recordIds).toEqual([
      'user',
      'tool-call',
      'tool-result',
      'reply',
    ]);
    const { records: kept } = deleteTranscriptMessageGroups(
      records,
      ['user'],
      anchor,
    );
    expect(kept.map((item) => item.uuid)).toEqual([
      'cold-notice',
      'delivered-notice',
      'background-reply',
      'anchor',
    ]);
    expect(prepareTranscriptRecords(kept).gaps).toEqual([]);
  });

  it('rejects compressed input with ambiguous injected-turn ownership', () => {
    const prompt = user('user', null);
    const compression = record('compression', 'user', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 10,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [
          prompt.message!,
          { role: 'user', parts: [{ text: 'injected input' }] },
          { role: 'model', parts: [{ text: 'ambiguous reply' }] },
        ],
        promptIds: ['api-user', null, null],
      },
    });
    expect(() =>
      deleteTranscriptMessageGroups([prompt, compression], ['user'], anchor),
    ).toThrow('injected input ownership');
  });

  it('persists original diff endpoints without retaining deleted rewind identities', () => {
    const snapshot = (promptId: string, version: number) => ({
      promptId,
      timestamp: '2026-10-15T00:00:00Z',
      trackedFileBackups: {
        'a.txt': {
          backupFileName: `a@v${version}`,
          version,
          backupTime: '2026-10-15T00:00:00Z',
        },
      },
    });
    const history = ['a', 'b', 'c'].flatMap((id, index) => [
      user(id, [null, 'fa', 'fb'][index]!),
      record(`f${id}`, id, 'system', {
        subtype: 'file_history_snapshot',
        systemPayload: { snapshots: [snapshot(`api-${id}`, index + 1)] },
      }),
    ]);
    const deleted = deleteTranscriptMessageGroups(
      history,
      ['b'],
      anchor,
    ).records;
    const restored = new SessionFileHistoryAccumulator();
    for (const entry of deleted) restored.add(entry);
    expect(restored.finish()?.map((entry) => entry.promptId)).toEqual([
      'api-a',
      'api-c',
    ]);
    expect(restored.finish()?.[0]?.diffAfterBackups?.['a.txt']?.version).toBe(
      2,
    );
    const again = deleteTranscriptMessageGroups(deleted, ['c'], {
      ...anchor,
      uuid: 'anchor2',
    }).records;
    const restoredAgain = new SessionFileHistoryAccumulator();
    for (const entry of again) restoredAgain.add(entry);
    expect(restoredAgain.finish()?.map((entry) => entry.promptId)).toEqual([
      'api-a',
    ]);
    expect(
      restoredAgain.finish()?.[0]?.diffAfterBackups?.['a.txt']?.version,
    ).toBe(2);
  });

  // R1-3: a legacy survivor (no recorded cwd) whose next checkpoint is
  // cwd-labeled cannot prove the fold is same-root, so the deletion helper
  // drops the fold and the survivor silently loses its only diff endpoint —
  // a later rewind then restores nothing for those files without even a
  // filesFailed entry. The deletion must be refused before anything is
  // rewritten instead.
  it('refuses a deletion that would drop a required recovery endpoint of a legacy survivor', () => {
    const snapshot = (promptId: string, version: number, cwd?: string) => ({
      promptId,
      timestamp: '2026-10-15T00:00:00Z',
      trackedFileBackups: {
        'a.txt': {
          backupFileName: `a@v${version}`,
          version,
          backupTime: '2026-10-15T00:00:00Z',
        },
      },
      ...(cwd === undefined ? {} : { cwd }),
    });
    const turn = (
      id: string,
      parent: string | null,
      snap: ReturnType<typeof snapshot>,
    ) => [
      user(id, parent),
      record(`f${id}`, id, 'system', {
        subtype: 'file_history_snapshot',
        systemPayload: { snapshots: [snap] },
      }),
    ];
    // Same real root, but only the second turn's checkpoint carries the cwd
    // label: exactly the upgraded-mixed-history shape.
    const history = [
      ...turn('a', null, snapshot('api-a', 1)),
      ...turn('b', 'fa', snapshot('api-b', 2, '/project')),
    ];

    let caught: unknown;
    try {
      deleteTranscriptMessageGroups(history, ['b'], anchor);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MessageGroupDeletionError);
    expect((caught as MessageGroupDeletionError).code).toBe('invalid_history');
    expect((caught as MessageGroupDeletionError).message).toMatch(
      /capture directory/,
    );

    // Contrast: when the survivor itself is labeled with the same root, the
    // fold keeps the endpoint and the same deletion stays allowed.
    const labeled = [
      ...turn('a2', null, snapshot('api-a2', 1, '/project')),
      ...turn('b2', 'fa2', snapshot('api-b2', 2, '/project')),
    ];
    const keptLabeled = deleteTranscriptMessageGroups(
      labeled,
      ['b2'],
      anchor,
    ).records;
    const survived = keptLabeled.flatMap((entry) =>
      entry.subtype === 'file_history_snapshot'
        ? (entry.systemPayload as { snapshots: unknown[] }).snapshots
        : [],
    );
    expect(survived).toEqual([
      expect.objectContaining({
        promptId: 'api-a2',
        diffAfterBackups: snapshot('api-b2', 2, '/project').trackedFileBackups,
      }),
    ]);
  });

  // R15 matrix A: deletion refusal and fold permission are two independent
  // decisions. `deletionDropsRequiredEndpoint` answers only whether deleting
  // the endpoint must be refused (a confirmed capture whose fold cannot prove
  // a shared root); whether the records may fold into the survivor is a
  // separate same-root question. A foreign failed record is deletable (no
  // restorable data) yet still not graftable into the survivor's identity.
  describe('endpoint deletion vs fold permission matrix (R15)', () => {
    const failedRecord = (key: string, version = 1) => ({
      [key]: {
        backupFileName: null,
        version,
        failed: true,
        backupTime: '2026-11-17T00:00:00Z',
      },
    });
    const confirmedRecord = (key: string, version = 1) => ({
      [key]: {
        backupFileName: `f@v${version}`,
        version,
        backupTime: '2026-11-17T00:00:00Z',
      },
    });
    const snapshot = (
      promptId: string,
      cwd: string | undefined,
      trackedFileBackups: SerializedFileHistorySnapshot['trackedFileBackups'] = {},
      diffAfterBackups?: SerializedFileHistorySnapshot['diffAfterBackups'],
    ): SerializedFileHistorySnapshot => ({
      promptId,
      cwd,
      timestamp: '2026-11-17T00:00:00Z',
      trackedFileBackups,
      ...(diffAfterBackups ? { diffAfterBackups } : {}),
    });
    const history = (
      survivor: SerializedFileHistorySnapshot,
      deleted: SerializedFileHistorySnapshot,
    ) => [
      user('a', null),
      record('fa', 'a', 'system', {
        subtype: 'file_history_snapshot',
        systemPayload: { snapshots: [survivor] },
      }),
      user('b', 'fa'),
      record('fb', 'b', 'system', {
        subtype: 'file_history_snapshot',
        systemPayload: { snapshots: [deleted] },
      }),
    ];
    const survivingSnapshots = (records: ChatRecord[]) =>
      records.flatMap((entry) =>
        entry.subtype === 'file_history_snapshot'
          ? (
              entry.systemPayload as {
                snapshots: SerializedFileHistorySnapshot[];
              }
            ).snapshots
          : [],
      );
    /** Deletes turn b and returns the persisted survivor snapshots. */
    const deleteLastTurn = (
      survivor: SerializedFileHistorySnapshot,
      deleted: SerializedFileHistorySnapshot,
    ) =>
      deleteTranscriptMessageGroups(history(survivor, deleted), ['b'], anchor)
        .records;
    /** The survivor kept its captured state and gained no diff endpoint. */
    const noFold = (records: ChatRecord[]) => {
      const [kept] = survivingSnapshots(records);
      expect(kept).not.toHaveProperty('diffAfterBackups');
      expect(kept.trackedFileBackups).toEqual({});
    };
    /** The survivor folded the deleted endpoint's records verbatim. */
    const folded = (
      records: ChatRecord[],
      expected: SerializedFileHistorySnapshot['trackedFileBackups'],
    ) => {
      const [kept] = survivingSnapshots(records);
      expect(kept.diffAfterBackups).toEqual(expected);
    };
    const refused = (
      survivor: SerializedFileHistorySnapshot,
      deleted: SerializedFileHistorySnapshot,
    ) => {
      let caught: unknown;
      try {
        deleteLastTurn(survivor, deleted);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MessageGroupDeletionError);
      expect((caught as MessageGroupDeletionError).code).toBe(
        'invalid_history',
      );
    };

    // A1: nothing captured at all — deletion succeeds, nothing to graft.
    it('A1 empty cross-root endpoint deletes without grafting', () => {
      noFold(deleteLastTurn(snapshot('api-a', '/A'), snapshot('api-b', '/B')));
    });

    // A2: same-root failed markers keep their diagnostic value.
    it('A2 same-root failed-only endpoint folds its failure markers', () => {
      folded(
        deleteLastTurn(
          snapshot('api-a', '/A'),
          snapshot('api-b', '/A', failedRecord('d.txt')),
        ),
        failedRecord('d.txt'),
      );
    });

    // A3 (R14 blocking ②): a foreign failed record is deletable, but folding
    // it would reassign the failure to an identity the survivor never
    // captured — reloading in /A would report filesFailed=['/A/d.txt'].
    it('A3 foreign failed-only endpoint deletes without folding', () => {
      noFold(
        deleteLastTurn(
          snapshot('api-a', '/A'),
          snapshot('api-b', '/B', failedRecord('d.txt')),
        ),
      );
    });

    // A4: unlabeled (legacy) deleted data keeps folding as before.
    it('A4 unlabeled failed-only endpoint still folds', () => {
      folded(
        deleteLastTurn(
          snapshot('api-a', '/A'),
          snapshot('api-b', undefined, failedRecord('d.txt')),
        ),
        failedRecord('d.txt'),
      );
    });

    // A5: an unlabeled survivor cannot prove a shared root either.
    it('A5 labeled failed-only endpoint does not fold into an unlabeled survivor', () => {
      noFold(
        deleteLastTurn(
          snapshot('api-a', undefined),
          snapshot('api-b', '/B', failedRecord('d.txt')),
        ),
      );
    });

    // A6: confirmed same-root data is exactly what the fold exists for.
    it('A6 same-root confirmed endpoint folds', () => {
      folded(
        deleteLastTurn(
          snapshot('api-a', '/A'),
          snapshot('api-b', '/A', confirmedRecord('f.txt')),
        ),
        confirmedRecord('f.txt'),
      );
    });

    // A7 (kept from R13): confirmed foreign data must refuse the deletion.
    it('A7 foreign confirmed endpoint refuses the deletion', () => {
      refused(
        snapshot('api-a', '/A'),
        snapshot('api-b', '/B', confirmedRecord('f.txt')),
      );
    });

    // A8: an unlabeled survivor cannot prove the root of confirmed data.
    it('A8 confirmed endpoint into an unlabeled survivor refuses', () => {
      refused(
        snapshot('api-a', undefined),
        snapshot('api-b', '/B', confirmedRecord('f.txt')),
      );
    });

    // A9: unlabeled (legacy) confirmed data keeps folding as before.
    it('A9 unlabeled confirmed endpoint still folds', () => {
      folded(
        deleteLastTurn(
          snapshot('api-a', '/A'),
          snapshot('api-b', undefined, confirmedRecord('f.txt')),
        ),
        confirmedRecord('f.txt'),
      );
    });

    // A10: a survivor holding its own diff endpoint loses nothing and keeps
    // its original endpoint — never a deleted turn's rewind identity.
    it('A10 survivor with its own diff endpoint neither refuses nor folds', () => {
      const records = deleteLastTurn(
        snapshot('api-a', '/A', {}, confirmedRecord('own.txt')),
        snapshot('api-b', '/B', confirmedRecord('f.txt')),
      );
      const [kept] = survivingSnapshots(records);
      expect(kept.diffAfterBackups).toEqual(confirmedRecord('own.txt'));
    });

    // A11: Win32 roots without a drive letter never prove a shared root.
    it('A11 unknown-drive confirmed endpoint refuses the deletion', () => {
      refused(
        snapshot('api-a', '\\A'),
        snapshot('api-b', '\\B', confirmedRecord('f.txt')),
      );
    });

    // A12: the Win32 unknown-drive form of A3.
    it('A12 unknown-drive failed-only endpoint deletes without folding', () => {
      noFold(
        deleteLastTurn(
          snapshot('api-a', '\\A'),
          snapshot('api-b', '\\B', failedRecord('d.txt')),
        ),
      );
    });

    // A13: one confirmed record anywhere makes the endpoint required.
    it('A13 mixed confirmed+failed foreign endpoint refuses the deletion', () => {
      refused(
        snapshot('api-a', '/A'),
        snapshot('api-b', '/B', {
          ...confirmedRecord('ok.txt'),
          ...failedRecord('bad.txt'),
        }),
      );
    });

    // A14: same-root folds preserve the whole map, failures included.
    it('A14 mixed confirmed+failed same-root endpoint folds the whole map', () => {
      const mixed = {
        ...confirmedRecord('ok.txt'),
        ...failedRecord('bad.txt'),
      };
      folded(
        deleteLastTurn(snapshot('api-a', '/A'), snapshot('api-b', '/A', mixed)),
        mixed,
      );
    });

    // A15 (R21 medium ①): a deleted endpoint whose LABEL spells a
    // refused Win32 capture root deletes — its records are inert for
    // execution — but must not fold. `areSnapshotOriginsEqual`
    // normalizes the refused root onto the survivor's ordinary root
    // (`C:\w\C:f\..` → `C:\w`), so the same-root check alone cannot see
    // the refusal, and the folded records would execute after reload
    // under a root the record-time policy refuses (rewind dispatching
    // unlink on a file the pre-fold timeline correctly left untouched).
    // Fold admission now applies the same raw-root policy: the records
    // go with the deleted checkpoint, exactly like cross-root records.
    it.each([
      ['dot-canceled', 'C:\\w\\C:f\\..'],
      ['forward-slash', 'C:/w/C:f/..'],
      ['lower-drive', 'c:\\w\\d:x\\..'],
    ])(
      'A15 deletes a %s refused-root endpoint without folding it (%s)',
      (_kind, root) => {
        noFold(
          deleteLastTurn(
            snapshot('api-a', 'C:\\w'),
            snapshot('api-b', root, confirmedRecord('victim')),
          ),
        );
      },
    );

    // A16: both sides spell the same refused root — still no grafting.
    it('A16 same refused-root endpoints delete without folding', () => {
      noFold(
        deleteLastTurn(
          snapshot('api-a', 'C:\\w\\C:f\\..'),
          snapshot('api-b', 'C:\\w\\C:f\\..', confirmedRecord('victim')),
        ),
      );
    });

    // A17 (control): namespace labels never normalize onto the ordinary
    // root, so their confirmed endpoints keep refusing the deletion.
    it('A17 namespace-root endpoint keeps refusing the deletion', () => {
      refused(
        snapshot('api-a', 'C:\\w'),
        snapshot('api-b', '\\\\?\\C:\\w', confirmedRecord('f.txt')),
      );
    });
  });

  describe('transitive endpoint retention', () => {
    const backup = (version = 1, failed = false) => ({
      backupFileName: null,
      version,
      backupTime: '2026-11-17T00:00:00.000Z',
      ...(failed ? { failed: true } : {}),
    });
    const checkpoint = (
      promptId: string,
      cwd: string | undefined,
      trackedFileBackups: SerializedFileHistorySnapshot['trackedFileBackups'] = {},
      diffAfterBackups?: SerializedFileHistorySnapshot['diffAfterBackups'],
    ): SerializedFileHistorySnapshot => ({
      promptId,
      cwd,
      timestamp: '2026-11-17T00:00:00.000Z',
      trackedFileBackups,
      ...(diffAfterBackups ? { diffAfterBackups } : {}),
    });
    const transcript = (snapshots: SerializedFileHistorySnapshot[]) =>
      snapshots.flatMap((snap, index) => [
        user(snap.promptId.slice(4), index === 0 ? null : `f${index - 1}`),
        record(`f${index}`, snap.promptId.slice(4), 'system', {
          subtype: 'file_history_snapshot',
          systemPayload: { snapshots: [snap] },
        }),
      ]);
    const checkpoints = (records: ChatRecord[]) =>
      records.flatMap((entry) =>
        entry.subtype === 'file_history_snapshot'
          ? (
              entry.systemPayload as {
                snapshots: SerializedFileHistorySnapshot[];
              }
            ).snapshots
          : [],
      );

    // Storage × deletion schedule × representation. Null means the target
    // did not exist before the edit; both schedules must still delete it
    // after a serialized reload, rather than forget its only baseline.
    it.each(
      (['tracked', 'diff', 'both'] as const).flatMap((location) =>
        (['together', 'sequential'] as const).map((schedule) => ({
          location,
          schedule,
        })),
      ),
    )(
      'retains $location endpoints when deleted $schedule',
      async ({ location, schedule }) => {
        const cwd = await mkdtemp(join(tmpdir(), 'history-fold-'));
        try {
          const entries = { 'later.txt': backup() };
          const snapshots = [
            checkpoint('api-a', cwd),
            checkpoint('api-b', cwd),
            checkpoint(
              'api-c',
              cwd,
              location === 'diff' ? {} : entries,
              location === 'tracked'
                ? undefined
                : { 'after.txt': backup(), ...entries },
            ),
          ];
          let records = transcript(snapshots);
          if (schedule === 'sequential') {
            records = deleteTranscriptMessageGroups(
              records,
              ['c'],
              record('anchor-c', null),
            ).records;
            records = deleteTranscriptMessageGroups(
              records,
              ['b'],
              anchor,
            ).records;
          } else {
            records = deleteTranscriptMessageGroups(
              records,
              ['b', 'c'],
              anchor,
            ).records;
          }
          const kept = checkpoints(records);
          const expected =
            location === 'tracked'
              ? entries
              : { 'after.txt': backup(), ...entries };
          expect(kept).toHaveLength(1);
          expect(kept[0]!.diffAfterBackups).toEqual(expected);
          // The standalone in-memory consumer must produce the same records
          // for both Date-valued and serialized representations.
          for (const input of [snapshots, deserializeSnapshots(snapshots)]) {
            const result = removeFileHistorySnapshots<(typeof input)[number]>(
              input,
              new Set(['api-b', 'api-c']),
            );
            expect(
              Object.keys(result[0]!.diffAfterBackups ?? {}).sort(),
            ).toEqual(Object.keys(expected).sort());
          }
          const service = new FileHistoryService('fold-reload', true, cwd);
          service.restoreFromSnapshots(
            deserializeSnapshots(JSON.parse(JSON.stringify(kept))),
          );
          for (const name of Object.keys(expected))
            await writeFile(join(cwd, name), 'created after baseline');
          const restored = await service.rewind('api-a');
          expect(restored.filesFailed).toEqual([]);
          expect(restored.filesChanged.sort()).toEqual(
            Object.keys(expected)
              .map((name) => join(cwd, name))
              .sort(),
          );
          for (const name of Object.keys(expected))
            await expect(readFile(join(cwd, name))).rejects.toMatchObject({
              code: 'ENOENT',
            });
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      },
    );

    it.each(['tracked', 'diff'] as const)(
      'refuses a required cross-root %s endpoint behind an empty deleted checkpoint',
      (location) => {
        const entries = { 'later.txt': backup() };
        const snapshots = [
          checkpoint('api-a', '/A'),
          checkpoint('api-b', '/A'),
          checkpoint(
            'api-c',
            '/B',
            location === 'tracked' ? entries : {},
            location === 'diff' ? entries : undefined,
          ),
        ];
        const records = transcript(snapshots);
        const before = JSON.stringify(records);
        expect(() =>
          deleteTranscriptMessageGroups(records, ['b', 'c'], anchor),
        ).toThrow(/capture directory/);
        expect(JSON.stringify(records)).toBe(before);
        expect(
          deletionDropsRequiredEndpoint(snapshots[0]!, snapshots[2]!),
        ).toBe(true);
      },
    );

    // Root permission × capture state × endpoint location, mirrored:
    // ordinary pairs fold; a refused label on EITHER side never grafts.
    it.each(
      [
        'ordinary',
        'survivor-refused',
        'deleted-refused',
        'both-refused',
        'legacy',
      ].flatMap((roots) =>
        ['tracked', 'diff'].flatMap((location) =>
          [false, true].map((failed) => ({ roots, location, failed })),
        ),
      ),
    )(
      'admits $roots / $location / failed=$failed',
      ({ roots, location, failed }) => {
        const left =
          roots === 'survivor-refused' || roots === 'both-refused'
            ? 'C:\\w\\C:f\\..'
            : 'C:\\w';
        const right =
          roots === 'deleted-refused' || roots === 'both-refused'
            ? 'C:\\w\\C:f\\..'
            : roots === 'legacy'
              ? undefined
              : 'C:\\w';
        const entries = { f: backup(1, failed) };
        const records = deleteTranscriptMessageGroups(
          transcript([
            checkpoint('api-a', left),
            checkpoint(
              'api-b',
              right,
              location === 'tracked' ? entries : {},
              location === 'diff' ? entries : undefined,
            ),
          ]),
          ['b'],
          anchor,
        ).records;
        expect(checkpoints(records)[0]!.diffAfterBackups).toEqual(
          roots === 'ordinary' || roots === 'legacy' ? entries : undefined,
        );
      },
    );

    it('keeps the earlier tracked baseline when endpoint maps overlap', () => {
      const first = backup(1);
      const later = backup(2);
      const [kept] = removeFileHistorySnapshots(
        [
          checkpoint('api-a', '/A'),
          checkpoint('api-b', '/A', { f: first }, { f: later, g: first }),
          checkpoint('api-c', '/A', { f: later, h: first }),
        ],
        new Set(['api-b', 'api-c']),
      );
      expect(kept!.diffAfterBackups).toEqual({ f: first, g: first, h: first });
    });
  });

  it.each([false, true])(
    'R11 refuses cross-grammar endpoint deletion with a Win32 reader (reverse=%s)',
    async (reverse) => {
      vi.resetModules();
      vi.doMock('node:path', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:path')>();
        return {
          ...actual,
          ...actual.win32,
          resolve: (...args: string[]) =>
            actual.win32.resolve('C:\\reader', ...args),
        };
      });
      try {
        const {
          deleteTranscriptMessageGroups: remove,
          MessageGroupDeletionError: DeletionError,
        } = await import('./message-group-deletion.js');
        const roots = reverse
          ? ['/workspace', 'C:\\workspace']
          : ['C:\\workspace', '/workspace'];
        const history = ['a', 'b'].flatMap((id, i) => [
          user(id, i === 0 ? null : 'fa'),
          record(`f${id}`, id, 'system', {
            subtype: 'file_history_snapshot',
            systemPayload: {
              snapshots: [
                {
                  promptId: `api-${id}`,
                  cwd: roots[i],
                  timestamp: '2026-10-15T00:00:00Z',
                  trackedFileBackups: {
                    f: {
                      backupFileName: null,
                      version: 1,
                      backupTime: '2026-10-15T00:00:00Z',
                    },
                  },
                },
              ],
            },
          }),
        ]);
        const before = JSON.stringify(history);
        let caught: unknown;
        try {
          remove(history, ['b'], anchor);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(DeletionError);
        expect((caught as MessageGroupDeletionError).code).toBe(
          'invalid_history',
        );
        expect(JSON.stringify(history)).toBe(before);

        const { ChatRecordingService } = await import(
          '../services/chatRecordingService.js'
        );
        const directory = await mkdtemp(join(tmpdir(), 'r11-deletion-'));
        const transcriptPath = join(directory, 'session.jsonl');
        const config = {
          getSessionId: () => 'session',
          getResumedSessionData: () => undefined,
          getProjectRoot: () => directory,
          getCliVersion: () => 'test',
        } as unknown as Config;
        const lease = {
          sessionId: 'session',
          ownerId: 'test-owner',
          assertOwnedAndUnchanged: vi.fn(async () => {}),
          readTranscript: vi.fn(async () => readFile(transcriptPath, 'utf8')),
          replaceTranscript: vi.fn(async (updated: string) =>
            writeFile(transcriptPath, updated),
          ),
          release: vi.fn(async () => {}),
        } as unknown as SessionWriterLease;
        const recorder = new ChatRecordingService(config, undefined, true);
        recorder.activate(lease);
        try {
          const bytes =
            history.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
          await writeFile(transcriptPath, bytes);
          const groups = await recorder.getMessageGroups();
          expect(groups.groups.map((group) => group.id)).toEqual(['a', 'b']);
          await expect(
            recorder.deleteMessageGroups({
              snapshot: groups.snapshot,
              groupIds: ['b'],
            }),
          ).rejects.toMatchObject({ code: 'invalid_history' });
          expect(lease.replaceTranscript).not.toHaveBeenCalled();
          expect(await readFile(transcriptPath, 'utf8')).toBe(bytes);
          expect((await recorder.getMessageGroups()).groups).toHaveLength(2);
        } finally {
          await recorder.close();
          await rm(directory, { recursive: true, force: true });
        }
      } finally {
        vi.doUnmock('node:path');
        vi.resetModules();
      }
    },
  );

  it('accepts complete fragments and deletes every selected physical fragment', () => {
    const question = user('u', null);
    const first = record('a', 'u', 'assistant', {
      message: { role: 'model', parts: [{ text: 'thought', thought: true }] },
    });
    const second = record('a', 'u', 'assistant', {
      message: { role: 'model', parts: [{ text: 'answer' }] },
    });
    const next = user('next', 'a');
    const records = parseMessageGroupTranscript(
      [question, first, second, next]
        .map((item) => JSON.stringify(item))
        .join('\n') + '\n',
    );
    expect(
      getTranscriptMessageGroups(records).map((group) => group.id),
    ).toEqual(['u', 'next']);
    const kept = deleteTranscriptMessageGroups(
      records,
      ['next'],
      anchor,
    ).records;
    expect(kept.filter((item) => item.uuid === 'a')).toEqual([first, second]);
    const deleted = deleteTranscriptMessageGroups(
      records,
      ['u'],
      anchor,
    ).records;
    expect(deleted.map((item) => [item.uuid, item.parentUuid])).toEqual([
      ['next', null],
      ['anchor', 'next'],
    ]);
    expect(() =>
      parseMessageGroupTranscript(
        [question, first, { ...second, parentUuid: null }]
          .map((item) => JSON.stringify(item))
          .join('\n') + '\n',
      ),
    ).toThrow('incomplete');
  });

  it('rejects unknown groups and incomplete or cyclic history', () => {
    expect(() =>
      deleteTranscriptMessageGroups([user('u1', null)], ['missing'], anchor),
    ).toThrow('existing message groups');
    expect(() =>
      parseMessageGroupTranscript(JSON.stringify(user('u1', null))),
    ).toThrow('incomplete');
    expect(() =>
      parseMessageGroupTranscript(`${JSON.stringify(user('u1', 'missing'))}\n`),
    ).toThrow('incomplete');
    expect(() =>
      parseMessageGroupTranscript(`${JSON.stringify(user('u1', 'u1'))}\n`),
    ).toThrow('incomplete');
    expect(messageGroupsSnapshot([user('a', null)])).not.toBe(
      messageGroupsSnapshot([user('b', null)]),
    );
  });

  it('ignores background metrics and automatic titles in snapshots while retaining conversation and control changes', () => {
    const first = user('first', null);
    const telemetry = record('metrics', 'first', 'system', {
      subtype: 'ui_telemetry',
    });
    const before = messageGroupsSnapshot([first]);
    expect(messageGroupsSnapshot([first, telemetry])).toBe(before);
    const title = record('title', 'metrics', 'system', {
      subtype: 'custom_title',
      systemPayload: { customTitle: 'Background title', titleSource: 'auto' },
    });
    expect(messageGroupsSnapshot([first, telemetry, title])).toBe(before);
    expect(
      messageGroupsSnapshot([
        first,
        {
          ...title,
          systemPayload: { customTitle: 'Renamed', titleSource: 'manual' },
        },
      ]),
    ).not.toBe(before);
    expect(
      messageGroupsSnapshot([first, telemetry, user('next', 'metrics')]),
    ).not.toBe(before);
    expect(
      messageGroupsSnapshot([
        first,
        record('compression', 'first', 'system', {
          subtype: 'chat_compression',
        }),
      ]),
    ).not.toBe(before);
    expect(
      messageGroupsSnapshot([
        first,
        record('rewind', null, 'system', { subtype: 'rewind' }),
      ]),
    ).not.toBe(before);
  });

  it('rejects identity-less raw checkpoints after JSON history restoration', () => {
    const original = user('original', null);
    const compression = record('compression', 'original', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [original.message!],
        summaryPrefixLength: 0,
      },
    });
    expect(() =>
      deleteTranscriptMessageGroups(
        [original, compression],
        ['original'],
        anchor,
      ),
    ).toThrow('no reliable raw input identities');
    delete (compression.systemPayload as { summaryPrefixLength?: number })
      .summaryPrefixLength;
    expect(() =>
      deleteTranscriptMessageGroups(
        [original, compression],
        ['original'],
        anchor,
      ),
    ).toThrow('no reliable raw input identities');
  });

  it('rejects partial identities that hide a restored raw prefix', () => {
    const old = user('old', null);
    const fresh = user('fresh', 'old');
    const compression = record('compression', 'fresh', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [old.message!, fresh.message!],
        promptIds: [null, fresh.promptId!],
      },
    });
    expect(() =>
      deleteTranscriptMessageGroups([old, fresh, compression], ['old'], anchor),
    ).toThrow('ownership');
    expect(() =>
      deleteTranscriptMessageGroups(
        [old, fresh, compression],
        ['fresh'],
        anchor,
      ),
    ).not.toThrow();
  });

  it('rejects selected raw tools copied into the generated summary prefix', () => {
    const original = user('original', null);
    const call = record('call', 'original', 'assistant', {
      message: {
        role: 'model',
        parts: [
          { functionCall: { id: 'call-id', name: 'read_file', args: {} } },
        ],
      },
    });
    const compression = record('compression', 'call', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          call.message!,
        ],
        summaryPrefixLength: 2,
      },
    });
    expect(() =>
      deleteTranscriptMessageGroups(
        [original, call, compression],
        ['original'],
        anchor,
      ),
    ).toThrow('tool call retained');
  });

  it('allows deleting display-only commands before identity-less checkpoints', () => {
    const command = user('command', null);
    const result = record('result', 'command', 'system', {
      subtype: 'slash_command',
      systemPayload: {
        phase: 'result',
        rawCommand: 'command',
        outputHistoryItems: [],
      },
    });
    const compression = record('compression', 'result', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
      },
    });
    expect(() =>
      deleteTranscriptMessageGroups(
        [command, result, compression],
        ['command'],
        anchor,
      ),
    ).not.toThrow();
  });

  it('rejects unidentified removed ancestors of abandoned compression checkpoints', () => {
    const legacy = record('legacy', null, 'user');
    const compression = record('compression', 'legacy', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [legacy.message!],
      },
    });
    const tail = user('tail', 'legacy');
    expect(() =>
      deleteTranscriptMessageGroups(
        [legacy, compression, tail],
        ['legacy'],
        anchor,
      ),
    ).toThrow('legacy turn');
  });

  it('rejects a legacy turn whose compression ownership is unknown', () => {
    const legacy = record('legacy', null, 'user');
    const compression = record('compression', 'legacy', 'system', {
      subtype: 'chat_compression',
      systemPayload: {
        info: {
          originalTokenCount: 20,
          newTokenCount: 5,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
        compressedHistory: [legacy.message!],
      },
    });
    expect(() =>
      deleteTranscriptMessageGroups([legacy, compression], ['legacy'], anchor),
    ).toThrow('legacy turn');
  });
  it('deletes a turn together with the catalog snapshot it appended', () => {
    // The snapshot is written during the turn whose durable request appended
    // it to the model history. Keeping the record after the turn is gone
    // would replay it onto an earlier turn on restore.
    const records = [
      user('u1', null),
      record('a1', 'u1', 'assistant'),
      snapshot('s1', 'a1', 'catalog A'),
      user('u2', 's1'),
      record('a2', 'u2', 'assistant'),
    ];
    const groups = getTranscriptMessageGroups(records);
    expect(groups.find((group) => group.id === 'u1')!.recordIds).toContain(
      's1',
    );

    const { records: kept } = deleteTranscriptMessageGroups(
      records,
      ['u1'],
      anchor,
    );

    expect(kept.map((item) => item.uuid)).toEqual(['u2', 'a2', 'anchor']);
    expect(
      JSON.stringify(buildApiHistoryFromConversation({ messages: kept })),
    ).not.toContain('catalog A');
  });

  it('keeps an earlier turn’s catalog snapshot when a later turn is deleted', () => {
    const records = [
      user('u1', null),
      snapshot('s1', 'u1', 'catalog A'),
      record('a1', 's1', 'assistant'),
      user('u2', 'a1'),
      snapshot('s2', 'u2', 'catalog B'),
      record('a2', 's2', 'assistant'),
    ];
    const groups = getTranscriptMessageGroups(records);
    expect(groups.find((group) => group.id === 'u1')!.recordIds).toContain(
      's1',
    );
    expect(groups.find((group) => group.id === 'u2')!.recordIds).toContain(
      's2',
    );

    const { records: kept } = deleteTranscriptMessageGroups(
      records,
      ['u2'],
      anchor,
    );

    expect(kept.map((item) => item.uuid)).toEqual(['u1', 's1', 'a1', 'anchor']);
  });
});

it('preserves the prompt counter after deleting all groups and restarting', () => {
  const first = user('first', null);
  first.promptId = `${first.sessionId}########41`;
  const last = user('last', first.uuid);
  last.promptId = `${first.sessionId}########42`;
  const { records } = deleteTranscriptMessageGroups(
    [first, last],
    ['first', 'last'],
    {
      ...anchor,
      sessionId: first.sessionId,
      promptId: `${first.sessionId}########42`,
    },
  );
  expect(computeInitialTurnFromHistory(records, first.sessionId)).toBe(42);
  expect(records.some((record) => record.type === 'user')).toBe(false);
});
