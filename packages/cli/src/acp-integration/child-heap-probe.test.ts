/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type * as v8 from 'node:v8';
import { constants as perfConstants } from 'node:perf_hooks';
import {
  shouldProbeChildHeap,
  startChildHeapProbe,
  type ChildHeapProbe,
  type ChildHeapProbeSnapshot,
} from './child-heap-probe.js';

function space(name: string, size: number, used = size): v8.HeapSpaceInfo {
  return {
    space_name: name,
    space_size: size,
    space_used_size: used,
    space_available_size: Math.max(0, size - used),
    physical_space_size: size,
  };
}

const heap = (total: number): v8.HeapInfo =>
  ({ total_heap_size: total }) as v8.HeapInfo;

function snapshotOf(probe: ChildHeapProbe): ChildHeapProbeSnapshot {
  const snapshot = probe.snapshot();
  if (!snapshot) throw new Error('expected at least one successful sample');
  return snapshot;
}

describe('shouldProbeChildHeap', () => {
  it('probes only a daemon-spawned child', () => {
    expect(shouldProbeChildHeap({ QWEN_CODE_SERVE: '1' })).toBe(true);
    expect(shouldProbeChildHeap({})).toBe(false);
  });

  it('treats the marker as an exact value, not a truthy string', () => {
    // '0' and 'false' are truthy strings. The daemon marker has already had
    // this bug once, so the negative cases are pinned rather than assumed:
    // an operator setting QWEN_CODE_SERVE=0 means the opposite of what a
    // truthiness test concludes.
    for (const value of ['0', 'false', '', 'true', 'yes', '01', ' 1']) {
      expect(shouldProbeChildHeap({ QWEN_CODE_SERVE: value })).toBe(false);
    }
  });
});

describe('startChildHeapProbe', () => {
  it('sums old-generation spaces rather than old_space alone', () => {
    // The regression that motivates the whole module: a child can OOM against
    // its ceiling with old_space at a few MB while large_object_space holds
    // everything.
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => [
        space('old_space', 3 * 1024 * 1024),
        space('large_object_space', 183 * 1024 * 1024),
        space('new_space', 64 * 1024 * 1024),
      ],
      heapStatistics: () => heap(0),
    });
    try {
      expect(snapshotOf(probe).peakOldGenerationBytes).toBe(186 * 1024 * 1024);
    } finally {
      probe.stop();
    }
  });

  it('excludes the young generation and read-only space from the sum', () => {
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => [
        space('old_space', 100),
        space('new_space', 5_000),
        space('new_large_object_space', 5_000),
        space('read_only_space', 5_000),
      ],
      heapStatistics: () => heap(0),
    });
    try {
      const snapshot = snapshotOf(probe);
      expect(snapshot.peakOldGenerationBytes).toBe(100);
      expect(snapshot.unclassifiedSpaceNames).toEqual([]);
    } finally {
      probe.stop();
    }
  });

  it('reports an unknown space name instead of dropping it silently', () => {
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => [
        space('old_space', 100),
        space('some_future_v8_space', 999),
      ],
      heapStatistics: () => heap(0),
    });
    try {
      const snapshot = snapshotOf(probe);
      expect(snapshot.unclassifiedSpaceNames).toEqual(['some_future_v8_space']);
      // Not summed — the point of the field is to say the sum is incomplete,
      // not to guess which side the unknown space belongs on.
      expect(snapshot.peakOldGenerationBytes).toBe(100);
    } finally {
      probe.stop();
    }
  });

  it('holds the high-water mark when usage falls back', () => {
    let committed = 500;
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => [space('old_space', committed)],
      heapStatistics: () => heap(0),
    });
    try {
      committed = 9_000;
      expect(snapshotOf(probe).peakOldGenerationBytes).toBe(9_000);
      committed = 10;
      expect(snapshotOf(probe).peakOldGenerationBytes).toBe(9_000);
    } finally {
      probe.stop();
    }
  });

  it('keeps the last good values when V8 readings throw', () => {
    let failing = false;
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => {
        if (failing) throw new Error('restricted container');
        return [space('old_space', 4_096)];
      },
      heapStatistics: () => {
        if (failing) throw new Error('restricted container');
        return heap(8_192);
      },
    });
    try {
      expect(snapshotOf(probe).peakOldGenerationBytes).toBe(4_096);
      failing = true;
      const snapshot = snapshotOf(probe);
      expect(snapshot.peakOldGenerationBytes).toBe(4_096);
      expect(snapshot.peakTotalHeapBytes).toBe(8_192);
    } finally {
      probe.stop();
    }
  });

  it('reports nothing until the first successful sample', () => {
    // The restricted-container steady state: every read throws. A zeroed
    // report here would read downstream as measured, needs-nothing, and
    // coverage-complete — the manufactured zero the bridge and status layers
    // refuse to emit — so the probe reports absence instead, exactly like a
    // child without the probe.
    let failing = true;
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => {
        if (failing) throw new Error('restricted container');
        return [space('old_space', 4_096)];
      },
      heapStatistics: () => {
        if (failing) throw new Error('restricted container');
        return heap(8_192);
      },
    });
    try {
      expect(probe.snapshot()).toBeUndefined();
      failing = false;
      const snapshot = snapshotOf(probe);
      expect(snapshot.peakOldGenerationBytes).toBe(4_096);
      expect(snapshot.peakTotalHeapBytes).toBe(8_192);
    } finally {
      probe.stop();
    }
  });

  it('leaves the live set at zero until a major GC is observed', () => {
    // `peakLiveSetBytes` is only meaningful immediately after a major
    // collection; a used-size read at any other moment includes garbage. With
    // no major GC observed it must read 0 rather than report an interval
    // sample as if it were a live set.
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => [space('old_space', 8_000, 7_000)],
      heapStatistics: () => heap(0),
    });
    try {
      const snapshot = snapshotOf(probe);
      expect(snapshot.peakOldGenerationBytes).toBe(8_000);
      expect(snapshot.peakLiveSetBytes).toBe(0);
      expect(snapshot.majorGcCount).toBe(0);
    } finally {
      probe.stop();
    }
  });

  it('updates the live set and GC figures from major-GC entries', () => {
    // The observer callback is the only writer of these three fields, so
    // deliver entries through the same detail.kind check production runs: a
    // wrong kind comparison or a callback that never runs stays green without
    // this pin.
    let gcCallback: ((entries: PerformanceEntry[]) => void) | undefined;
    let disconnected = false;
    const gcEntry = (kind: number, duration: number) =>
      ({ detail: { kind }, duration }) as unknown as PerformanceEntry;
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => [space('old_space', 8_000, 7_000)],
      heapStatistics: () => heap(9_000),
      gcObserver: (callback) => {
        gcCallback = callback;
        return {
          disconnect: () => {
            disconnected = true;
          },
        };
      },
    });
    try {
      // A minor collection delivers an entry too; it must not move the live
      // set or the counters.
      gcCallback?.([gcEntry(perfConstants.NODE_PERFORMANCE_GC_MINOR, 3)]);
      expect(snapshotOf(probe).peakLiveSetBytes).toBe(0);
      expect(snapshotOf(probe).majorGcCount).toBe(0);

      gcCallback?.([gcEntry(perfConstants.NODE_PERFORMANCE_GC_MAJOR, 5)]);
      const snapshot = snapshotOf(probe);
      expect(snapshot.peakLiveSetBytes).toBe(7_000);
      expect(snapshot.majorGcCount).toBe(1);
      expect(snapshot.majorGcMs).toBe(5);
    } finally {
      probe.stop();
    }
    expect(disconnected).toBe(true);
  });

  it('classifies every heap space the running Node actually reports', () => {
    // Deliberately against the real V8, not a fixture. A fixture can only
    // contain space names somebody already thought of, so only the live call
    // catches a taxonomy this repo supports and the sets do not — the failure
    // that would silently under-count every other figure.
    const probe = startChildHeapProbe();
    try {
      expect(snapshotOf(probe).unclassifiedSpaceNames).toEqual([]);
    } finally {
      probe.stop();
    }
  });

  it('tracks a real allocation upward against the real V8', () => {
    // Compared against a baseline taken before allocating, not against zero.
    // `> 0` would pass on a probe that never sampled again after construction.
    const probe = startChildHeapProbe();
    try {
      const before = snapshotOf(probe).peakOldGenerationBytes;
      const held: unknown[] = [];
      // ~16 MiB per array, into large_object_space — the space an
      // old_space-only implementation would miss entirely.
      for (let i = 0; i < 12; i++) held.push(new Array(2_000_000).fill(i));
      const after = snapshotOf(probe).peakOldGenerationBytes;
      expect(after).toBeGreaterThan(before + 100 * 1024 * 1024);
      expect(held.length).toBe(12);
    } finally {
      probe.stop();
    }
  });

  it('stops sampling after stop()', () => {
    let reads = 0;
    const probe = startChildHeapProbe({
      heapSpaceStatistics: () => {
        reads++;
        return [space('old_space', 1)];
      },
      heapStatistics: () => heap(1),
      intervalMs: 1,
    });
    probe.stop();
    const after = reads;
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(reads).toBe(after);
        resolve();
      }, 30);
    });
  });
});
