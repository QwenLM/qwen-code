import { describe, expect, it } from 'vitest';
import type {
  DaemonTranscriptBlock,
  DaemonTranscriptState,
} from '@qwen-code/sdk/daemon';
import {
  buildTurnLocator,
  TranscriptPageLedger,
  type TranscriptPageLedgerEntryInput,
} from './transcriptPageLedger.js';

function makeBlock(id: string, recordId?: string): DaemonTranscriptBlock {
  return {
    id,
    kind: 'user',
    text: `text-${id}`,
    ...(recordId !== undefined ? { sourceRecordIds: [recordId] } : {}),
    clientReceivedAt: 0,
    updatedAt: 0,
  } as DaemonTranscriptBlock;
}

function makeState(blocks: DaemonTranscriptBlock[]): DaemonTranscriptState {
  const blockIndexById: Record<string, number> = {};
  blocks.forEach((block, index) => {
    blockIndexById[block.id] = index;
  });
  return { blocks, blockIndexById } as unknown as DaemonTranscriptState;
}

function pageInput(
  overrides: Partial<TranscriptPageLedgerEntryInput> & {
    firstBlockId: string;
    lastBlockId: string;
  },
): TranscriptPageLedgerEntryInput {
  return {
    source: 'prepend',
    byteSize: 100,
    turnIds: [],
    ...overrides,
  };
}

describe('TranscriptPageLedger', () => {
  it('records the initial load as the first ledger entry with no gaps', () => {
    const ledger = new TranscriptPageLedger();
    ledger.recordInitialLoad(
      pageInput({
        source: 'load',
        firstBlockId: 'b-1',
        lastBlockId: 'b-10',
        firstRecordId: 'r-1',
        lastRecordId: 'r-10',
      }),
    );
    const entries = ledger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'load',
      firstBlockId: 'b-1',
      lastBlockId: 'b-10',
      firstRecordId: 'r-1',
      lastRecordId: 'r-10',
    });
    expect(ledger.getGaps()).toEqual([{}, {}]);
  });

  it('records prepends in order, butt-joined, carrying the remaining older gap', () => {
    const ledger = new TranscriptPageLedger();
    ledger.recordInitialLoad(
      pageInput({ source: 'load', firstBlockId: 'b-11', lastBlockId: 'b-20' }),
    );
    ledger.setOlderGap({ older: { beforeRecordId: 'r-11' } });
    ledger.recordPrepend(
      pageInput({ firstBlockId: 'b-1', lastBlockId: 'b-10' }),
      { older: { beforeRecordId: 'r-1' } },
    );
    const entries = ledger.getEntries();
    expect(entries.map((entry) => entry.firstBlockId)).toEqual(['b-1', 'b-11']);
    // Gap before the new oldest entry is the remaining older range; the
    // prepend butts against the previous oldest entry with an empty gap.
    expect(ledger.getGaps()).toEqual([
      { older: { beforeRecordId: 'r-1' } },
      {},
      {},
    ]);
  });

  it('records a closed older gap when the prepend reaches the transcript start', () => {
    const ledger = new TranscriptPageLedger();
    ledger.recordInitialLoad(
      pageInput({ source: 'load', firstBlockId: 'b-11', lastBlockId: 'b-20' }),
    );
    ledger.setOlderGap({ older: { beforeRecordId: 'r-11' } });
    ledger.recordPrepend(
      pageInput({ firstBlockId: 'b-1', lastBlockId: 'b-10' }),
    );
    expect(ledger.getGaps()[0]).toEqual({});
  });

  describe('applyPrefixTrim', () => {
    it('drops fully evicted entries and records an older gap', () => {
      const ledger = new TranscriptPageLedger();
      const preTrim = makeState([
        makeBlock('b-0a', 'r-0a'),
        makeBlock('b-0b', 'r-0b'),
        makeBlock('b-1', 'r-1'),
        makeBlock('b-2', 'r-2'),
        makeBlock('b-3', 'r-3'),
        makeBlock('b-4', 'r-4'),
      ]);
      ledger.recordInitialLoad(
        pageInput({
          source: 'load',
          firstBlockId: 'b-1',
          lastBlockId: 'b-4',
          firstRecordId: 'r-1',
          lastRecordId: 'r-4',
        }),
      );
      ledger.recordPrepend(
        pageInput({ firstBlockId: 'b-0a', lastBlockId: 'b-0b' }),
      );
      // Trim evicts the two oldest blocks (the whole prepend page).
      ledger.applyPrefixTrim(preTrim, {
        blockCount: 4,
        oldestRetainedRecordId: 'r-1',
      });
      const entries = ledger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.firstBlockId).toBe('b-1');
      expect(ledger.getGaps()[0]).toEqual({
        older: { beforeRecordId: 'r-1' },
      });
    });

    it('shrinks a straddling entry to the oldest retained block', () => {
      const ledger = new TranscriptPageLedger();
      const preTrim = makeState([
        makeBlock('b-1', 'r-1'),
        makeBlock('b-2', 'r-2'),
        makeBlock('b-3', 'r-3'),
        makeBlock('b-4', 'r-4'),
      ]);
      ledger.recordInitialLoad(
        pageInput({
          source: 'load',
          firstBlockId: 'b-1',
          lastBlockId: 'b-3',
          firstRecordId: 'r-1',
          lastRecordId: 'r-3',
          nextCursor: 'cursor-fwd',
          byteSize: 1,
        }),
      );
      // Evict b-1 only: the load page straddles the cut.
      ledger.applyPrefixTrim(preTrim, {
        blockCount: 3,
        oldestRetainedRecordId: 'r-2',
      });
      const entry = ledger.getEntries()[0];
      expect(entry?.firstBlockId).toBe('b-2');
      expect(entry?.firstRecordId).toBe('r-2');
      expect(entry?.lastBlockId).toBe('b-3');
      // The forward cursor pointed past evicted content and must not survive.
      expect(entry?.nextCursor).toBeUndefined();
      // byteSize was recomputed over the retained slice, not the stale 1.
      expect(entry?.byteSize).toBeGreaterThan(1);
      expect(ledger.getGaps()[0]).toEqual({
        older: { beforeRecordId: 'r-2' },
      });
      // The gaps array always has entries.length + 1 elements: the older
      // gap plus the trailing gap toward the live tail.
      expect(ledger.getGaps()).toHaveLength(2);
    });

    it('preserves the previous gap snapshot on the re-anchored older gap', () => {
      const ledger = new TranscriptPageLedger();
      const preTrim = makeState([makeBlock('b-1', 'r-1'), makeBlock('b-2')]);
      ledger.recordInitialLoad(
        pageInput({
          source: 'load',
          firstBlockId: 'b-1',
          lastBlockId: 'b-2',
        }),
      );
      ledger.setOlderGap({
        older: { beforeRecordId: 'r-1', snapshot: 'snap-1' },
      });
      ledger.applyPrefixTrim(preTrim, {
        blockCount: 1,
        oldestRetainedRecordId: 'r-1',
      });
      expect(ledger.getGaps()[0]).toEqual({
        older: { beforeRecordId: 'r-1', snapshot: 'snap-1' },
      });
    });

    it('closes the older gap empty when no retained record carries an id', () => {
      const ledger = new TranscriptPageLedger();
      const preTrim = makeState([makeBlock('b-1', 'r-1'), makeBlock('b-2')]);
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-1' }),
      );
      ledger.setOlderGap({ older: { beforeRecordId: 'r-1' } });
      ledger.applyPrefixTrim(preTrim, { blockCount: 1 });
      expect(ledger.getGaps()[0]).toEqual({});
    });

    it('is a no-op when the trim does not reach the oldest entry', () => {
      const ledger = new TranscriptPageLedger();
      const preTrim = makeState([
        makeBlock('b-1', 'r-1'),
        makeBlock('b-2', 'r-2'),
        makeBlock('b-3'),
      ]);
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-2' }),
      );
      // Only the tail block b-3 is evicted — impossible for oldest-first
      // trim while pages exist, so cut=1 would straddle; use cut=0 shape:
      ledger.applyPrefixTrim(preTrim, { blockCount: 3 });
      expect(ledger.getEntries()).toHaveLength(1);
      expect(ledger.getGaps()).toEqual([{}, {}]);
    });
  });

  describe('applyRewind', () => {
    it('drops entries past the rewind point and closes trailing gaps', () => {
      const ledger = new TranscriptPageLedger();
      const preRewind = makeState([
        makeBlock('b-1', 'r-1'),
        makeBlock('b-2', 'r-2'),
        makeBlock('b-3', 'r-3'),
        makeBlock('b-4', 'r-4'),
      ]);
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-2' }),
      );
      ledger.recordPrepend(
        pageInput({ firstBlockId: 'b-3', lastBlockId: 'b-4' }),
      );
      // Order entries oldest-first manually: initial load is b-1..b-2, and
      // the "prepend" here actually represents a newer page for the test.
      ledger.clear();
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-2' }),
      );
      ledger.insertEntry(
        pageInput({
          source: 'continuation',
          firstBlockId: 'b-3',
          lastBlockId: 'b-4',
          nextCursor: 'cursor-fwd',
        }),
        1,
      );
      ledger.applyRewind(preRewind, { blockCount: 2 });
      const entries = ledger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.lastBlockId).toBe('b-2');
      expect(ledger.getGaps()).toEqual([{}, {}]);
    });

    it('shrinks a straddling newest entry and clears its forward cursor', () => {
      const ledger = new TranscriptPageLedger();
      const preRewind = makeState([
        makeBlock('b-1', 'r-1'),
        makeBlock('b-2', 'r-2'),
        makeBlock('b-3', 'r-3'),
      ]);
      ledger.recordInitialLoad(
        pageInput({
          source: 'load',
          firstBlockId: 'b-1',
          lastBlockId: 'b-3',
          lastRecordId: 'r-3',
          nextCursor: 'cursor-fwd',
          byteSize: 1,
        }),
      );
      ledger.applyRewind(preRewind, { blockCount: 2 });
      const entry = ledger.getEntries()[0];
      expect(entry?.lastBlockId).toBe('b-2');
      expect(entry?.lastRecordId).toBe('r-2');
      expect(entry?.nextCursor).toBeUndefined();
      expect(entry?.byteSize).toBeGreaterThan(1);
    });

    it('is a no-op when the rewind stays inside the live tail', () => {
      const ledger = new TranscriptPageLedger();
      const preRewind = makeState([
        makeBlock('b-1', 'r-1'),
        makeBlock('b-2'),
        makeBlock('b-3'),
      ]);
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-1' }),
      );
      ledger.applyRewind(preRewind, { blockCount: 2 });
      const entries = ledger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.lastBlockId).toBe('b-1');
    });
  });

  describe('insertEntry / updateEntry', () => {
    it('inserts an anchored page between entries with explicit side gaps', () => {
      const ledger = new TranscriptPageLedger();
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-2' }),
      );
      const entry = ledger.insertEntry(
        pageInput({
          source: 'anchored',
          firstBlockId: 'b-9',
          lastBlockId: 'b-10',
          snapshot: 'snap-1',
        }),
        1,
        { older: { beforeRecordId: 'r-9', snapshot: 'snap-1' } },
        { newer: { cursor: 'cursor-fwd' } },
      );
      expect(entry.source).toBe('anchored');
      expect(ledger.getEntries().map((item) => item.firstBlockId)).toEqual([
        'b-1',
        'b-9',
      ]);
      expect(ledger.getGaps()).toEqual([
        {},
        { older: { beforeRecordId: 'r-9', snapshot: 'snap-1' } },
        { newer: { cursor: 'cursor-fwd' } },
      ]);
    });

    it('preserves the displaced gap when no explicit gapAfter is given', () => {
      const ledger = new TranscriptPageLedger();
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-2' }),
      );
      ledger.setOlderGap({ older: { beforeRecordId: 'r-1' } });
      // An anchored page landing above everything: the previous older gap
      // now describes the range between the anchored page and the load
      // page — its locator must survive the insertion.
      ledger.insertEntry(
        pageInput({
          source: 'anchored',
          firstBlockId: 'b-9',
          lastBlockId: 'b-10',
        }),
        0,
        { older: { beforeRecordId: 'r-9' } },
      );
      expect(ledger.getGaps()).toEqual([
        { older: { beforeRecordId: 'r-9' } },
        { older: { beforeRecordId: 'r-1' } },
        {},
      ]);
    });

    it('patches an entry in place', () => {
      const ledger = new TranscriptPageLedger();
      ledger.recordInitialLoad(
        pageInput({ source: 'load', firstBlockId: 'b-1', lastBlockId: 'b-2' }),
      );
      const id = ledger.getEntries()[0]!.id;
      ledger.updateEntry(id, { nextCursor: 'cursor-fwd' });
      expect(ledger.getEntry(id)?.nextCursor).toBe('cursor-fwd');
      ledger.updateEntry('missing', { nextCursor: 'nope' });
      expect(ledger.getEntries()).toHaveLength(1);
    });
  });
});

describe('buildTurnLocator', () => {
  it('maps known turn ids to the first block carrying them', () => {
    const blocks = [
      makeBlock('b-1', 'r-1'),
      makeBlock('b-2', 'r-2'),
      makeBlock('b-3', 'r-2'),
    ];
    const locator = buildTurnLocator(blocks, new Set(['r-1', 'r-2']));
    expect(locator.get('r-1')).toBe('b-1');
    // First carrier wins; later blocks repeating the record are ignored.
    expect(locator.get('r-2')).toBe('b-2');
    expect(locator.size).toBe(2);
  });

  it('ignores record ids the index does not know', () => {
    const blocks = [makeBlock('b-1', 'r-1'), makeBlock('b-2', 'r-2')];
    const locator = buildTurnLocator(blocks, new Set(['r-2']));
    expect(locator.has('r-1')).toBe(false);
    expect(locator.get('r-2')).toBe('b-2');
  });

  it('picks the index-known id among several source records of one block', () => {
    const block = {
      ...makeBlock('b-1', 'r-not-a-turn'),
      sourceRecordIds: ['r-not-a-turn', 'r-turn'],
    } as DaemonTranscriptBlock;
    const locator = buildTurnLocator([block], new Set(['r-turn']));
    expect(locator.get('r-turn')).toBe('b-1');
    expect(locator.has('r-not-a-turn')).toBe(false);
  });
});
