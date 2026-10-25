/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { computeInitialTurnFromHistory } from '../services/session-turn-state.js';
import type { Content } from '@google/genai';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { SessionFileHistoryAccumulator } from '../services/session-file-history-state.js';
import { CompressionStatus } from '../core/turn.js';
import { detectTurnInterruption } from '../core/turn-interruption.js';
import { buildApiHistoryFromConversation } from '../services/session-api-history.js';
import { prepareTranscriptRecords } from './transcript-records.js';
import {
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
