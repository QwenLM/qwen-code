/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonEvent,
  DaemonSessionTranscriptPage,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { HistoricalTranscriptPageTable } from './transcript-page-table.js';

function event(recordId: string): DaemonEvent {
  return {
    type: 'user_message_chunk',
    data: { recordId },
  } as DaemonEvent;
}

function recordIdOf(event: DaemonEvent): string {
  return (event.data as { recordId: string }).recordId;
}

function block(recordId: string, ordinal: number): DaemonTranscriptBlock {
  return {
    id: `user-${ordinal}`,
    kind: 'user',
    text: recordId,
    sourceRecordIds: [recordId],
    clientReceivedAt: ordinal,
    createdAt: ordinal,
    updatedAt: ordinal,
  };
}

function response(
  recordIds: string[],
  options: Partial<DaemonSessionTranscriptPage> = {},
): DaemonSessionTranscriptPage {
  return {
    v: 1,
    sessionId: 'session-1',
    events: recordIds.map(event),
    hasMore: false,
    ...options,
  };
}

function createTable(options?: { maxPages?: number; maxBytes?: number }) {
  return new HistoricalTranscriptPageTable({
    maxPages: options?.maxPages ?? 5,
    maxRetainedBytes: options?.maxBytes ?? 1024 * 1024,
    materialize(events, nextBlockOrdinal, excludedRecordIds) {
      const encounteredRecordIds = events.map(recordIdOf);
      const retainedEvents = events.filter(
        (item) => !excludedRecordIds.has(recordIdOf(item)),
      );
      return {
        blocks: retainedEvents.map((item, index) =>
          block(recordIdOf(item), nextBlockOrdinal + index),
        ),
        nextBlockOrdinal: nextBlockOrdinal + retainedEvents.length,
        encounteredRecordIds,
      };
    },
  });
}

describe('HistoricalTranscriptPageTable', () => {
  it('admits an exact anchor with frozen older and newer boundaries', () => {
    const table = createTable();
    const target = table.admitAnchor(
      10,
      'turn-10',
      'snapshot-1',
      response(['turn-10', 'answer-10'], {
        targetRecordId: 'turn-10',
        hasOlder: true,
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );

    expect(target.blockId).toBe('history-page-1:user-1');
    expect(
      table.admitAnchor(
        10,
        'turn-10',
        'snapshot-1',
        response(['turn-10'], { targetRecordId: 'turn-10' }),
      ),
    ).toEqual(target);
    expect(table.getSnapshot().pages.size).toBe(1);
    expect(table.getSnapshot().ranges[0]).toMatchObject({
      anchorOrdinal: 10,
      older: {
        kind: 'loadable',
        request: {
          kind: 'older',
          beforeRecordId: 'turn-10',
          snapshot: 'snapshot-1',
        },
      },
      newer: {
        kind: 'loadable',
        request: { kind: 'cursor', cursor: 'next-1' },
      },
    });
  });

  it('rejects a wrong or unmaterialized target atomically', () => {
    const table = createTable();

    expect(() =>
      table.admitAnchor(
        1,
        'turn-1',
        'snapshot-1',
        response(['other'], { targetRecordId: 'other' }),
      ),
    ).toThrow('did not contain its target');
    expect(() =>
      table.admitAnchor(
        1,
        'turn-1',
        'snapshot-1',
        response(['other'], { targetRecordId: 'turn-1' }),
      ),
    ).toThrow('could not be materialized');
    expect(table.getSnapshot().ranges).toHaveLength(0);
  });

  it('marks the newer boundary live only after exact live overlap', () => {
    const isolated = createTable();
    isolated.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], { targetRecordId: 'turn-1' }),
    );
    expect(isolated.getSnapshot().ranges[0]?.newer).toEqual({ kind: 'end' });

    const overlapping = createTable();
    overlapping.setLiveRecordIds(['turn-2']);
    overlapping.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1', 'turn-2'], { targetRecordId: 'turn-1' }),
    );
    expect(overlapping.getSnapshot().ranges[0]?.newer).toEqual({
      kind: 'live',
    });
  });

  it('deduplicates exact record overlap during continuation', () => {
    const table = createTable();
    const target = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    expect(table.beginBoundaryLoad(target.rangeId, 'newer')).toEqual({
      kind: 'cursor',
      cursor: 'next-1',
    });

    table.admitBoundary(
      target.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-1', 'turn-2']),
    );

    const range = table.getSnapshot().ranges[0]!;
    expect(range.pageIds).toHaveLength(2);
    const continued = table.getSnapshot().pages.get(range.pageIds[1]!);
    expect([...continued!.recordIds]).toEqual(['turn-2']);
    expect(continued!.blocks[0]?.id).toBe('history-page-2:user-2');
  });

  it('advances a newer cursor when a page contains only known overlap', () => {
    const table = createTable();
    const target = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    table.beginBoundaryLoad(target.rangeId, 'newer');

    table.admitBoundary(
      target.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-1'], { hasMore: true, nextCursor: 'next-2' }),
    );

    expect(table.getSnapshot().ranges[0]?.newer).toEqual({
      kind: 'loadable',
      request: { kind: 'cursor', cursor: 'next-2' },
    });
  });

  it('advances a backward cursor when an older page has no new blocks', () => {
    const table = createTable();
    const target = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasOlder: true,
      }),
    );
    table.beginBoundaryLoad(target.rangeId, 'older');

    table.admitBoundary(
      target.rangeId,
      'older',
      'snapshot-1',
      response(['turn-1'], { hasMore: true, nextCursor: 'backward-2' }),
    );

    expect(table.getSnapshot().ranges[0]?.older).toEqual({
      kind: 'loadable',
      request: { kind: 'cursor', cursor: 'backward-2' },
    });
    expect(table.beginBoundaryLoad(target.rangeId, 'older')).toEqual({
      kind: 'cursor',
      cursor: 'backward-2',
    });
  });

  it('filters overlapping records before materialization can merge them', () => {
    const table = new HistoricalTranscriptPageTable({
      maxPages: 5,
      maxRetainedBytes: 1024 * 1024,
      materialize(events, nextBlockOrdinal, excludedRecordIds) {
        const encounteredRecordIds = events.map(recordIdOf);
        const retainedRecordIds = encounteredRecordIds.filter(
          (recordId) => !excludedRecordIds.has(recordId),
        );
        return {
          blocks:
            retainedRecordIds.length === 0
              ? []
              : [
                  {
                    ...block(retainedRecordIds[0]!, nextBlockOrdinal),
                    text: retainedRecordIds.join('+'),
                    sourceRecordIds: retainedRecordIds,
                  },
                ],
          nextBlockOrdinal:
            nextBlockOrdinal + (retainedRecordIds.length > 0 ? 1 : 0),
          encounteredRecordIds,
        };
      },
    });
    const target = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    table.beginBoundaryLoad(target.rangeId, 'newer');

    table.admitBoundary(
      target.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-1', 'turn-2']),
    );

    const range = table.getSnapshot().ranges[0]!;
    const continued = table.getSnapshot().pages.get(range.pageIds[1]!);
    expect(continued?.blocks[0]).toMatchObject({
      text: 'turn-2',
      sourceRecordIds: ['turn-2'],
    });
  });

  it('stops newer continuation when it reaches the live window', () => {
    const table = createTable();
    const target = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    table.setLiveRecordIds(['live-turn']);
    table.beginBoundaryLoad(target.rangeId, 'newer');

    table.admitBoundary(
      target.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-2', 'live-turn'], {
        hasMore: true,
        nextCursor: 'next-2',
      }),
    );

    const snapshot = table.getSnapshot();
    const range = snapshot.ranges[0]!;
    expect(range.newer).toEqual({ kind: 'live' });
    expect([...snapshot.pages.get(range.pageIds[1]!)!.recordIds]).toEqual([
      'turn-2',
    ]);
  });

  it('links an exact overlap to a separately cached range', () => {
    const table = createTable();
    const first = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    const second = table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      response(['turn-2'], { targetRecordId: 'turn-2' }),
    );
    table.beginBoundaryLoad(first.rangeId, 'newer');

    table.admitBoundary(
      first.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-2'], { hasMore: true, nextCursor: 'next-2' }),
    );

    expect(table.getSnapshot().ranges[0]?.newer).toEqual({
      kind: 'cached',
      rangeId: second.rangeId,
    });
  });

  it('does not link a continuation to the middle of a cached range', () => {
    const table = createTable();
    const first = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      response(['turn-2', 'answer-2'], { targetRecordId: 'turn-2' }),
    );
    table.beginBoundaryLoad(first.rangeId, 'newer');

    table.admitBoundary(
      first.rangeId,
      'newer',
      'snapshot-1',
      response(['answer-2']),
    );

    expect(table.getSnapshot().ranges[0]?.newer).toEqual({ kind: 'end' });
  });

  it('does not link when unknown records follow the cached edge overlap', () => {
    const table = createTable();
    const first = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      response(['turn-2'], { targetRecordId: 'turn-2' }),
    );
    table.beginBoundaryLoad(first.rangeId, 'newer');

    table.admitBoundary(
      first.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-2', 'turn-between']),
    );

    expect(table.getSnapshot().ranges[0]?.newer).toEqual({ kind: 'end' });
    expect(table.findTurn('turn-between')).toMatchObject({
      rangeId: first.rangeId,
    });
  });

  it('restores an incoming boundary when the cached range edge changes', () => {
    const table = createTable();
    const first = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    const second = table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      response(['turn-2'], {
        targetRecordId: 'turn-2',
        hasOlder: true,
      }),
    );
    table.beginBoundaryLoad(first.rangeId, 'newer');
    table.admitBoundary(
      first.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-2']),
    );
    expect(table.getSnapshot().ranges[0]?.newer.kind).toBe('cached');

    table.select(second.rangeId, second.pageId);
    table.beginBoundaryLoad(second.rangeId, 'older');
    table.admitBoundary(
      second.rangeId,
      'older',
      'snapshot-1',
      response(['turn-between']),
    );

    expect(table.getSnapshot().ranges[0]?.newer).toEqual({
      kind: 'loadable',
      request: { kind: 'cursor', cursor: 'next-1' },
    });
  });

  it('restores the fetch boundary when its cached range is evicted', () => {
    const table = createTable({ maxPages: 2 });
    const first = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      response(['turn-2'], { targetRecordId: 'turn-2' }),
    );
    table.beginBoundaryLoad(first.rangeId, 'newer');
    table.admitBoundary(
      first.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-2']),
    );

    table.admitAnchor(
      3,
      'turn-3',
      'snapshot-1',
      response(['turn-3'], { targetRecordId: 'turn-3' }),
    );

    expect(table.getSnapshot().ranges[0]?.newer).toEqual({
      kind: 'loadable',
      request: { kind: 'cursor', cursor: 'next-1' },
    });
  });

  it('evicts a cached link target when the link exceeds the byte budget', () => {
    const prepare = (table: HistoricalTranscriptPageTable) => {
      const first = table.admitAnchor(
        1,
        'turn-1',
        'snapshot-1',
        response(['turn-1'], {
          targetRecordId: 'turn-1',
          hasMore: true,
          nextCursor: 'next-1',
        }),
      );
      table.admitAnchor(
        2,
        'turn-2',
        'snapshot-1',
        response(['turn-2'], { targetRecordId: 'turn-2' }),
      );
      table.select(first.rangeId, first.pageId);
      table.beginBoundaryLoad(first.rangeId, 'newer');
      return first;
    };
    const probe = createTable();
    prepare(probe);
    const table = createTable({
      maxBytes: probe.getSnapshot().retainedBytes,
    });
    const first = prepare(table);

    table.admitBoundary(
      first.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-2']),
    );

    expect(table.getSnapshot().retainedBytes).toBeLessThanOrEqual(
      probe.getSnapshot().retainedBytes,
    );
    expect(table.getSnapshot().ranges).toHaveLength(1);
    expect(table.getSnapshot().ranges[0]?.newer).toEqual({
      kind: 'loadable',
      request: { kind: 'cursor', cursor: 'next-1' },
    });
  });

  it('evicts the least recently used inactive range', () => {
    const table = createTable({ maxPages: 2 });
    const first = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], { targetRecordId: 'turn-1' }),
    );
    table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      response(['turn-2'], { targetRecordId: 'turn-2' }),
    );
    table.admitAnchor(
      3,
      'turn-3',
      'snapshot-1',
      response(['turn-3'], { targetRecordId: 'turn-3' }),
    );

    expect(table.getSnapshot().ranges).toHaveLength(2);
    expect(
      table.getSnapshot().ranges.some((item) => item.id === first.rangeId),
    ).toBe(false);
  });

  it('keeps the selected range when an inactive continuation exceeds budget', () => {
    const table = createTable({ maxPages: 2 });
    const inactive = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    const selected = table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      response(['turn-2'], { targetRecordId: 'turn-2' }),
    );
    table.beginBoundaryLoad(inactive.rangeId, 'newer');

    table.admitBoundary(
      inactive.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-1-next']),
    );

    expect(table.getSnapshot().ranges.map((range) => range.id)).toEqual([
      selected.rangeId,
    ]);
    expect(table.findTurn('turn-2')).toEqual(selected);
  });

  it('restores the older boundary when a head page is evicted', () => {
    const table = createTable({ maxPages: 2 });
    const target = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    table.beginBoundaryLoad(target.rangeId, 'newer');
    table.admitBoundary(
      target.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-2'], { hasMore: true, nextCursor: 'next-2' }),
    );
    table.findTurn('turn-2');
    table.beginBoundaryLoad(target.rangeId, 'newer');
    table.admitBoundary(
      target.rangeId,
      'newer',
      'snapshot-1',
      response(['turn-3'], { hasMore: false }),
    );

    expect(table.getSnapshot().ranges[0]).toMatchObject({
      pageIds: ['history-page-2', 'history-page-3'],
      older: {
        kind: 'loadable',
        request: {
          kind: 'older',
          beforeRecordId: 'turn-2',
          snapshot: 'snapshot-1',
        },
      },
      newer: { kind: 'end' },
    });
  });

  it('rejects an over-budget page without changing readable state', () => {
    const table = createTable({ maxBytes: 1 });
    expect(() =>
      table.admitAnchor(
        1,
        'turn-1',
        'snapshot-1',
        response(['turn-1'], { targetRecordId: 'turn-1' }),
      ),
    ).toThrow('exceeds the cache budget');
    expect(table.getSnapshot()).toMatchObject({
      retainedBytes: 0,
      ranges: [],
    });
  });

  it('counts retained boundary tokens against the byte budget', () => {
    const table = createTable({ maxBytes: 1000 });

    expect(() =>
      table.admitAnchor(
        1,
        'turn-1',
        'snapshot-1',
        response(['turn-1'], {
          targetRecordId: 'turn-1',
          hasMore: true,
          nextCursor: 'x'.repeat(1000),
        }),
      ),
    ).toThrow('exceeds the cache budget');
    expect(table.getSnapshot()).toMatchObject({
      retainedBytes: 0,
      ranges: [],
    });
  });

  it('restores the prior boundary when an empty continuation token is too large', () => {
    const baseline = createTable();
    baseline.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    const maxBytes = baseline.getSnapshot().retainedBytes + 10;
    const table = createTable({ maxBytes });
    const target = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      response(['turn-1'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'next-1',
      }),
    );
    const request = table.beginBoundaryLoad(target.rangeId, 'newer')!;

    expect(() =>
      table.admitBoundary(
        target.rangeId,
        'newer',
        'snapshot-1',
        response(['turn-1'], {
          hasMore: true,
          nextCursor: 'x'.repeat(1000),
        }),
      ),
    ).toThrow('exceeds the cache budget');

    expect(table.getSnapshot().retainedBytes).toBeLessThanOrEqual(maxBytes);
    table.failBoundaryLoad(target.rangeId, 'newer', request, false);
    expect(table.getSnapshot().ranges[0]?.newer).toMatchObject({
      kind: 'error',
      retryable: false,
      request,
    });
  });

  it('preserves newer pages when an empty older cursor exceeds the budget', () => {
    const populate = (table: HistoricalTranscriptPageTable) => {
      const target = table.admitAnchor(
        3,
        'turn-3',
        'snapshot-1',
        response(['turn-3'], {
          targetRecordId: 'turn-3',
          hasOlder: true,
        }),
      );
      table.beginBoundaryLoad(target.rangeId, 'older');
      table.admitBoundary(
        target.rangeId,
        'older',
        'snapshot-1',
        response(['turn-2'], { hasMore: true, nextCursor: 'older-2' }),
      );
      return target;
    };
    const baseline = createTable();
    populate(baseline);
    const maxBytes = baseline.getSnapshot().retainedBytes + 10;
    const table = createTable({ maxBytes });
    const target = populate(table);
    table.select(target.rangeId, 'history-page-2');
    const request = table.beginBoundaryLoad(target.rangeId, 'older')!;

    expect(() =>
      table.admitBoundary(
        target.rangeId,
        'older',
        'snapshot-1',
        response([], {
          hasMore: true,
          nextCursor: 'x'.repeat(1000),
        }),
      ),
    ).toThrow('exceeds the cache budget');

    expect(table.getSnapshot().ranges[0]?.pageIds).toEqual([
      'history-page-2',
      'history-page-1',
    ]);
    expect(table.findTurn('turn-3')).toEqual(target);
    table.failBoundaryLoad(target.rangeId, 'older', request, false);
    expect(table.getSnapshot().ranges[0]?.older).toMatchObject({
      kind: 'error',
      retryable: false,
      request,
    });
  });
});
