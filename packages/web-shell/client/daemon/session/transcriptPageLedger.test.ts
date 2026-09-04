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
  type TranscriptPageSpan,
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

/** Compact span rendering: `gap:<older locator>` and `page:<id>`. */
function spanSummary(ledger: TranscriptPageLedger): string[] {
  return ledger.spans.map((span) =>
    span.kind === 'gap'
      ? `gap:${span.gap.older?.beforeRecordId ?? 'unlocated'}`
      : `page:${span.entry.id}`,
  );
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
    ledger = recordLedgerPrependPage(ledger, entry('old', blocks('b0')), true);
    ledger = recordLedgerLoadPage(
      ledger,
      entry('load', blocks('b1', 'b2')),
      false,
    );
    expect(spanSummary(ledger)).toEqual(['page:load']);
    expect(ledger.sessionId).toBe('s1');
  });

  it('inserts a prepended page at the head', () => {
    let ledger = recordLedgerLoadPage(
      createTranscriptPageLedger(),
      entry('load', blocks('b3', 'b4')),
      false,
    );
    ledger = recordLedgerPrependPage(
      ledger,
      entry('pre1', [
        block('b1', { sourceRecordIds: ['r1'] }),
        block('b2', { sourceRecordIds: ['r2'] }),
      ]),
      true,
    );
    ledger = recordLedgerPrependPage(
      ledger,
      entry('pre2', [block('b0', { sourceRecordIds: ['r0'] })]),
      true,
    );
    expect(pageIds(ledger)).toEqual(['pre2', 'pre1', 'load']);
    expect(ledgerBlockCount(ledger)).toBe(5);
  });

  it('delimits the live tail at the newest page boundary', () => {
    const empty = createTranscriptPageLedger();
    expect(ledgerLiveTailFirstBlockId(empty)).toBeUndefined();
    let ledger = recordLedgerLoadPage(
      empty,
      entry('load', blocks('b1', 'b2')),
      false,
    );
    expect(ledgerLiveTailFirstBlockId(ledger)).toBe('b2');
    ledger = recordLedgerPrependPage(ledger, entry('pre', blocks('b0')), true);
    expect(ledgerLiveTailFirstBlockId(ledger)).toBe('b2');
  });
});

describe('older gap tracking', () => {
  it('opens a head gap when the replay did not cover the session', () => {
    const ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', [
        block('b1', { sourceRecordIds: ['r1'] }),
        block('b2', { sourceRecordIds: ['r2'] }),
      ]),
      true,
    );
    expect(spanSummary(ledger)).toEqual(['gap:r1', 'page:load']);
  });

  it('records no gap when the replay reached the start of the session', () => {
    const ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', [block('b1', { sourceRecordIds: ['r1'] })]),
      false,
    );
    expect(spanSummary(ledger)).toEqual(['page:load']);
  });

  it('records a locator-less gap when no retained block carries a record id', () => {
    const ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', blocks('b1')),
      true,
    );
    expect(spanSummary(ledger)).toEqual(['gap:unlocated', 'page:load']);
  });

  it('moves the head gap back as prepends resolve it', () => {
    let ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', [block('b3', { sourceRecordIds: ['r3'] })]),
      true,
    );
    expect(spanSummary(ledger)).toEqual(['gap:r3', 'page:load']);
    ledger = recordLedgerPrependPage(
      ledger,
      entry('pre', [block('b1', { sourceRecordIds: ['r1'] })]),
      true,
    );
    // The prepended page resolved the front of the gap, so exactly one gap
    // remains and it now points at the newly oldest retained record.
    expect(spanSummary(ledger)).toEqual(['gap:r1', 'page:pre', 'page:load']);
  });

  it('closes the head gap when a prepend reaches the start of the session', () => {
    let ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', [block('b3', { sourceRecordIds: ['r3'] })]),
      true,
    );
    ledger = recordLedgerPrependPage(
      ledger,
      entry('pre', [block('b1', { sourceRecordIds: ['r1'] })]),
      false,
    );
    expect(spanSummary(ledger)).toEqual(['page:pre', 'page:load']);
  });
});

describe('clipLedgerToRetainedBlocks', () => {
  const prepended = [block('b0', { sourceRecordIds: ['r0'] })];
  const page = [
    block('b1', { sourceRecordIds: ['r1'] }),
    block('b2', { sourceRecordIds: ['r2'] }),
  ];
  const tail = blocks('t1', 't2');

  function twoPageLedger() {
    let ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', page),
      false,
    );
    ledger = recordLedgerPrependPage(ledger, entry('pre', prepended), false);
    return ledger;
  }

  function evict(
    ledger: TranscriptPageLedger,
    all: readonly DaemonTranscriptBlock[],
    retainedBlockCount: number,
    evictedOldest: boolean,
    oldestRetainedRecordId?: string,
  ) {
    return clipLedgerToRetainedBlocks(ledger, {
      blocks: all,
      retainedBlockCount,
      evictedOldest,
      ...(oldestRetainedRecordId !== undefined
        ? { oldestRetainedRecordId }
        : {}),
    });
  }

  it('is a no-op when nothing was evicted', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    expect(evict(ledger, all, all.length, true)).toBe(ledger);
  });

  it('drops a whole page evicted from the prefix and clips the next one', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    // The trim evicted the two oldest blocks: the whole prepended page plus
    // the load page's first block.
    const clipped = evict(ledger, all, all.length - 2, true, 'r2');
    expect(spanSummary(clipped)).toEqual(['gap:r2', 'page:load']);
    expect(ledgerPageEntries(clipped)[0]).toMatchObject({
      id: 'load',
      firstBlockId: 'b2',
      lastBlockId: 'b2',
      blockCount: 1,
      firstRecordId: 'r2',
    });
  });

  it('clips a partially evicted page and recomputes its bounds', () => {
    const wide = blocks('b1', 'b2', 'b3');
    const ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', wide),
      false,
    );
    const all = [...wide, ...tail];
    const clipped = evict(ledger, all, all.length - 1, true);
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

  it('keeps exactly one head gap across repeated trims', () => {
    const wide = [
      block('b1', { sourceRecordIds: ['r1'] }),
      block('b2', { sourceRecordIds: ['r2'] }),
      block('b3', { sourceRecordIds: ['r3'] }),
    ];
    const ledger = recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', wide),
      true,
    );
    expect(spanSummary(ledger)).toEqual(['gap:r1', 'page:load']);
    const once = evict(ledger, wide, 2, true, 'r2');
    expect(spanSummary(once)).toEqual(['gap:r2', 'page:load']);
    // The second trim runs against the window the first one left behind.
    const twice = evict(once, wide.slice(1), 1, true, 'r3');
    expect(spanSummary(twice)).toEqual(['gap:r3', 'page:load']);
    expect(ledgerPageEntries(twice)[0]).toMatchObject({
      firstBlockId: 'b3',
      blockCount: 1,
    });
  });

  it('folds the gaps around a fully evicted page into one head gap', () => {
    // An anchored window: head gap, an old page, an interior gap, and the
    // newest page. A trim that swallows the old page leaves everything before
    // the survivor as one missing range.
    const oldPage = [block('o1', { sourceRecordIds: ['ro1'] })];
    const newPage = [block('n1', { sourceRecordIds: ['rn1'] })];
    const spans: TranscriptPageSpan[] = [
      { kind: 'gap', gap: { older: { beforeRecordId: 'ro1' } } },
      { kind: 'page', entry: entry('old', oldPage, 'anchored') },
      { kind: 'gap', gap: {} },
      { kind: 'page', entry: entry('new', newPage, 'load') },
    ];
    const ledger: TranscriptPageLedger = { sessionId: 's1', spans };
    const all = [...oldPage, ...newPage, ...tail];
    const clipped = evict(ledger, all, all.length - 1, true, 'rn1');
    expect(spanSummary(clipped)).toEqual(['gap:rn1', 'page:new']);
  });

  it('adds a head gap without disturbing an interior one', () => {
    const oldPage = [
      block('o1', { sourceRecordIds: ['ro1'] }),
      block('o2', { sourceRecordIds: ['ro2'] }),
    ];
    const newPage = [
      block('n1', { sourceRecordIds: ['rn1'] }),
      block('n2', { sourceRecordIds: ['rn2'] }),
    ];
    const spans: TranscriptPageSpan[] = [
      { kind: 'page', entry: entry('old', oldPage, 'anchored') },
      { kind: 'gap', gap: {} },
      { kind: 'page', entry: entry('new', newPage, 'load') },
    ];
    const ledger: TranscriptPageLedger = { sessionId: 's1', spans };
    const all = [...oldPage, ...newPage, ...tail];
    // Evict only the older page's first block.
    const clipped = evict(ledger, all, all.length - 1, true, 'ro2');
    expect(spanSummary(clipped)).toEqual([
      'gap:ro2',
      'page:old',
      'gap:unlocated',
      'page:new',
    ]);
    expect(ledgerPageEntries(clipped)[0]).toMatchObject({
      firstBlockId: 'o2',
      blockCount: 1,
    });
  });

  it('drops every page when the eviction reaches into the live tail', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    const clipped = evict(ledger, all, 1, true, 'r-tail');
    expect(pageIds(clipped)).toEqual([]);
    expect(spanSummary(clipped)).toEqual(['gap:r-tail']);
    expect(ledgerLiveTailFirstBlockId(clipped)).toBeUndefined();
  });

  it('leaves the ledger alone when a rewind only drops live-tail blocks', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    const clipped = evict(ledger, all, all.length - 2, false);
    expect(spanSummary(clipped)).toEqual(['page:pre', 'page:load']);
    expect(ledgerBlockCount(clipped)).toBe(3);
  });

  it('clips the newest page when a rewind reaches past the live tail', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    // Retain the prepended page plus the load page's first block only.
    const clipped = evict(ledger, all, 2, false);
    expect(pageIds(clipped)).toEqual(['pre', 'load']);
    expect(ledgerPageEntries(clipped)[1]).toMatchObject({
      firstBlockId: 'b1',
      lastBlockId: 'b1',
      blockCount: 1,
    });
  });

  it('drops gaps beyond a rewind but keeps the head gap', () => {
    const oldPage = [block('o1', { sourceRecordIds: ['ro1'] })];
    const newPage = [block('n1', { sourceRecordIds: ['rn1'] })];
    const spans: TranscriptPageSpan[] = [
      { kind: 'gap', gap: { older: { beforeRecordId: 'ro1' } } },
      { kind: 'page', entry: entry('old', oldPage, 'anchored') },
      { kind: 'gap', gap: {} },
      { kind: 'page', entry: entry('new', newPage, 'load') },
    ];
    const ledger: TranscriptPageLedger = { sessionId: 's1', spans };
    const all = [...oldPage, ...newPage, ...tail];
    // Rewind to just after the old page: the interior gap and the newest page
    // are beyond the cut.
    const clipped = evict(ledger, all, 1, false);
    expect(spanSummary(clipped)).toEqual(['gap:ro1', 'page:old']);
  });

  it('empties the ledger when a rewind drops everything', () => {
    const ledger = twoPageLedger();
    const all = [...prepended, ...page, ...tail];
    expect(pageIds(evict(ledger, all, 0, false))).toEqual([]);
  });

  it('discards a ledger that no longer matches the store instead of clipping', () => {
    const ledger = twoPageLedger();
    // An external `store.reset()` wiped the window and unrelated live blocks
    // accumulated afterwards. The ledger's offsets describe blocks that are
    // gone, so clipping against them would invent boundaries.
    const unrelated = blocks('x1', 'x2', 'x3', 'x4', 'x5');
    expect(pageIds(evict(ledger, unrelated, 3, true))).toEqual([]);
  });
});

describe('ledgerCoversBlockPrefix', () => {
  const page = blocks('b1', 'b2');
  const tail = blocks('t1');

  function loadedLedger() {
    return recordLedgerLoadPage(
      createTranscriptPageLedger('s1'),
      entry('load', page),
      false,
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
      false,
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
