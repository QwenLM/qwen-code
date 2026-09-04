/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  estimateDaemonTranscriptBlockBytes,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  clipLedgerToRetainedBlocks,
  createLedgerPageEntry,
  createTranscriptPageLedger,
  ledgerBlockCount,
  ledgerCoversBlockPrefix,
  ledgerForWindow,
  ledgerLiveTailFirstBlockId,
  ledgerPageEntries,
  recordLedgerLoadPage,
  recordLedgerPrependPage,
  type TranscriptPageLedger,
  type TranscriptPageLedgerEntry,
} from './transcriptPageLedger.js';

let clock = 1_700_000_000_000;

function block(
  id: string,
  overrides: { text?: string; sourceRecordIds?: string[] } = {},
): DaemonTranscriptBlock {
  clock += 1;
  return {
    id,
    kind: 'assistant',
    text: overrides.text ?? `text-${id}`,
    clientReceivedAt: clock,
    createdAt: clock,
    updatedAt: clock,
    ...(overrides.sourceRecordIds
      ? { sourceRecordIds: overrides.sourceRecordIds }
      : {}),
  };
}

function blocks(...ids: string[]): DaemonTranscriptBlock[] {
  return ids.map((id) => block(id));
}

function entry(
  id: string,
  pageBlocks: readonly DaemonTranscriptBlock[],
  source: TranscriptPageLedgerEntry['source'] = 'load',
): TranscriptPageLedgerEntry {
  const created = createLedgerPageEntry({ id, source }, pageBlocks);
  if (!created) throw new Error(`no entry for ${id}`);
  return created;
}

function pageIds(ledger: TranscriptPageLedger): string[] {
  return ledgerPageEntries(ledger).map((page) => page.id);
}

describe('createLedgerPageEntry', () => {
  it('derives block and record boundaries from the page', () => {
    const created = createLedgerPageEntry({ id: 'p1', source: 'load' }, [
      block('b1', { sourceRecordIds: ['r1'] }),
      block('b2'),
      block('b3', { sourceRecordIds: ['r2', 'r3'] }),
    ]);
    expect(created).toMatchObject({
      id: 'p1',
      source: 'load',
      firstBlockId: 'b1',
      lastBlockId: 'b3',
      blockCount: 3,
      firstRecordId: 'r1',
      lastRecordId: 'r3',
    });
    expect(created?.turnIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('keeps cursor and snapshot only when supplied', () => {
    const pageBlocks = blocks('b1');
    const bare = createLedgerPageEntry(
      { id: 'p1', source: 'load' },
      pageBlocks,
    );
    expect(bare).not.toHaveProperty('nextCursor');
    expect(bare).not.toHaveProperty('snapshot');
    expect(
      createLedgerPageEntry(
        { id: 'p2', source: 'anchored', nextCursor: 'c1', snapshot: 's1' },
        pageBlocks,
      ),
    ).toMatchObject({ nextCursor: 'c1', snapshot: 's1' });
  });

  it('deduplicates record identities without reordering them', () => {
    const created = createLedgerPageEntry({ id: 'p1', source: 'prepend' }, [
      block('b1', { sourceRecordIds: ['r1', 'r2'] }),
      block('b2', { sourceRecordIds: ['r2'] }),
      block('b3', { sourceRecordIds: ['r3', 'r1'] }),
    ]);
    expect(created?.turnIds).toEqual(['r1', 'r2', 'r3']);
  });

  it('sums the retained-byte estimate over the page', () => {
    const pageBlocks = blocks('b1', 'b2');
    const created = createLedgerPageEntry(
      { id: 'p1', source: 'load' },
      pageBlocks,
    );
    expect(created?.byteSize).toBe(
      pageBlocks.reduce(
        (total, item) => total + estimateDaemonTranscriptBlockBytes(item),
        0,
      ),
    );
  });

  it('returns undefined for an empty page', () => {
    expect(createLedgerPageEntry({ id: 'p1', source: 'load' }, [])).toBe(
      undefined,
    );
  });
});

describe('ledger span bookkeeping', () => {
  it('replaces every retained page when the replay commits', () => {
    let ledger = createTranscriptPageLedger('s1');
    ledger = recordLedgerPrependPage(ledger, entry('old', blocks('b0')));
    ledger = recordLedgerLoadPage(ledger, entry('load', blocks('b1', 'b2')));
    expect(pageIds(ledger)).toEqual(['load']);
    expect(ledger.sessionId).toBe('s1');
  });

  it('inserts a prepended page at the head', () => {
    let ledger = recordLedgerLoadPage(
      createTranscriptPageLedger(),
      entry('load', blocks('b3', 'b4')),
    );
    ledger = recordLedgerPrependPage(ledger, entry('pre1', blocks('b1', 'b2')));
    ledger = recordLedgerPrependPage(ledger, entry('pre2', blocks('b0')));
    expect(pageIds(ledger)).toEqual(['pre2', 'pre1', 'load']);
    expect(ledgerBlockCount(ledger)).toBe(5);
  });

  it('delimits the live tail at the newest page boundary', () => {
    const empty = createTranscriptPageLedger();
    expect(ledgerLiveTailFirstBlockId(empty)).toBeUndefined();
    let ledger = recordLedgerLoadPage(empty, entry('load', blocks('b1', 'b2')));
    expect(ledgerLiveTailFirstBlockId(ledger)).toBe('b2');
    ledger = recordLedgerPrependPage(ledger, entry('pre', blocks('b0')));
    expect(ledgerLiveTailFirstBlockId(ledger)).toBe('b2');
  });
});

describe('clipLedgerToRetainedBlocks', () => {
  const page = blocks('b1', 'b2');
  const prepended = blocks('b0');
  const tail = blocks('t1', 't2');

  function twoPageLedger() {
    let ledger = recordLedgerLoadPage(
      createTranscriptPageLedger(),
      entry('load', page),
    );
    ledger = recordLedgerPrependPage(ledger, entry('pre', prepended));
    return ledger;
  }

  it('is a no-op when nothing was evicted', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    expect(clipLedgerToRetainedBlocks(ledger, all, all.length, true)).toBe(
      ledger,
    );
  });

  it('drops a whole page evicted from the prefix', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    // The retention trim evicted the two oldest blocks: the whole prepended
    // page plus the load page's first block.
    const clipped = clipLedgerToRetainedBlocks(
      ledger,
      all,
      all.length - 2,
      true,
    );
    expect(pageIds(clipped)).toEqual(['load']);
    expect(ledgerPageEntries(clipped)[0]).toMatchObject({
      id: 'load',
      firstBlockId: 'b2',
      lastBlockId: 'b2',
      blockCount: 1,
    });
  });

  it('clips a partially evicted page and recomputes its bounds', () => {
    const wide = blocks('b1', 'b2', 'b3');
    const ledger = recordLedgerLoadPage(
      createTranscriptPageLedger(),
      entry('load', wide, 'load'),
    );
    const all = [...wide, ...tail];
    const clipped = clipLedgerToRetainedBlocks(
      ledger,
      all,
      all.length - 1,
      true,
    );
    const [kept] = ledgerPageEntries(clipped);
    expect(kept).toMatchObject({
      id: 'load',
      source: 'load',
      firstBlockId: 'b2',
      lastBlockId: 'b3',
      blockCount: 2,
    });
    expect(kept?.byteSize).toBe(
      estimateDaemonTranscriptBlockBytes(wide[1]!) +
        estimateDaemonTranscriptBlockBytes(wide[2]!),
    );
  });

  it('drops every page when the eviction reaches into the live tail', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    const clipped = clipLedgerToRetainedBlocks(ledger, all, 1, true);
    expect(pageIds(clipped)).toEqual([]);
    expect(ledgerLiveTailFirstBlockId(clipped)).toBeUndefined();
  });

  it('leaves the ledger alone when a rewind only drops live-tail blocks', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    const clipped = clipLedgerToRetainedBlocks(
      ledger,
      all,
      all.length - 2,
      false,
    );
    expect(pageIds(clipped)).toEqual(['pre', 'load']);
    expect(ledgerBlockCount(clipped)).toBe(3);
  });

  it('clips the newest page when a rewind reaches past the live tail', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    // Retain the prepended page plus the load page's first block only.
    const clipped = clipLedgerToRetainedBlocks(ledger, all, 2, false);
    expect(pageIds(clipped)).toEqual(['pre', 'load']);
    expect(ledgerPageEntries(clipped)[1]).toMatchObject({
      firstBlockId: 'b1',
      lastBlockId: 'b1',
      blockCount: 1,
    });
  });

  it('empties the ledger when a rewind drops everything', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    expect(pageIds(clipLedgerToRetainedBlocks(ledger, all, 0, false))).toEqual(
      [],
    );
  });

  it('discards a ledger that no longer matches the store instead of clipping', () => {
    const ledger = twoPageLedger();
    // An external `store.reset()` wiped the window and unrelated live blocks
    // accumulated afterwards. The ledger's offsets describe blocks that are
    // gone, so clipping against them would invent boundaries.
    const unrelated = blocks('x1', 'x2', 'x3', 'x4', 'x5');
    expect(
      pageIds(clipLedgerToRetainedBlocks(ledger, unrelated, 3, true)),
    ).toEqual([]);
  });
});

describe('ledgerCoversBlockPrefix', () => {
  const page = blocks('b1', 'b2');
  const tail = blocks('t1');

  function loadedLedger() {
    return recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', page),
    );
  }

  it('accepts an empty ledger for any window', () => {
    expect(ledgerCoversBlockPrefix(createTranscriptPageLedger(), tail)).toBe(
      true,
    );
    expect(ledgerCoversBlockPrefix(createTranscriptPageLedger(), [])).toBe(
      true,
    );
  });

  it('accepts a ledger covering the window prefix ahead of the live tail', () => {
    expect(ledgerCoversBlockPrefix(loadedLedger(), [...page, ...tail])).toBe(
      true,
    );
    expect(ledgerCoversBlockPrefix(loadedLedger(), page)).toBe(true);
  });

  it('rejects a ledger describing more blocks than the window holds', () => {
    expect(ledgerCoversBlockPrefix(loadedLedger(), [page[0]!])).toBe(false);
    expect(ledgerCoversBlockPrefix(loadedLedger(), [])).toBe(false);
  });

  it('rejects a ledger whose boundary block sits at the wrong offset', () => {
    expect(ledgerCoversBlockPrefix(loadedLedger(), [page[0]!, ...tail])).toBe(
      false,
    );
  });
});

describe('ledgerForWindow', () => {
  const page = blocks('b1', 'b2');
  const tail = blocks('t1');

  function loadedLedger(sessionId = 's1') {
    return recordLedgerLoadPage(
      createTranscriptPageLedger(sessionId),
      entry('load', page),
    );
  }

  it('keeps a ledger that still describes the window', () => {
    const ledger = loadedLedger();
    expect(ledgerForWindow(ledger, 's1', [...page, ...tail])).toBe(ledger);
  });

  it('discards a ledger left over from another session', () => {
    const fresh = ledgerForWindow(loadedLedger('s1'), 's2', page);
    expect(pageIds(fresh)).toEqual([]);
    expect(fresh.sessionId).toBe('s2');
  });

  it('discards a ledger the store was wiped behind', () => {
    // Clear screen and session clear reset the store without telling the
    // ledger; recording the next page must not inherit those boundaries.
    const fresh = ledgerForWindow(loadedLedger(), 's1', []);
    expect(pageIds(fresh)).toEqual([]);
    expect(fresh.sessionId).toBe('s1');
  });
});
