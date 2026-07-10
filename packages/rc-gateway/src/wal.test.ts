/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWal, encodeFrame, decodeSegment } from './wal.js';
import type { WalFrame } from './wal.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'rc-gateway-wal-'));
}

function makeFrame(
  id: number,
  type = 'session_update',
  data: unknown = { text: `event-${id}` },
): WalFrame {
  return { id, v: 1, type, data };
}

describe('SessionWal', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  it('append + replay round-trip: returns frames in ascending id order', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.append(makeFrame(1));
    wal.append(makeFrame(2));
    wal.append(makeFrame(3));
    wal.close();

    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([1, 2, 3]);
      expect(result.events[0]!.data).toEqual({ text: 'event-1' });
    }
  });

  it('replayFrom skips events at or before the cursor', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.append(makeFrame(1));
    wal.append(makeFrame(2));
    wal.append(makeFrame(3));
    wal.close();

    const result = wal.replayFrom(2);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([3]);
    }
  });

  it('replayFrom(0) on empty WAL returns empty non-truncated result', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.close();
    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events).toHaveLength(0);
    }
  });

  it('replayFrom non-zero cursor on empty WAL returns truncated: no_wal', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.close();
    const result = wal.replayFrom(5);
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.reason).toBe('no_wal');
      expect(result.earliestAvailableId).toBeNull();
    }
  });

  it('horizon eviction: events older than horizonSec are dropped', () => {
    let now = 1_000_000;
    const wal = new SessionWal({
      dir,
      sessionId: 'sess-1',
      horizonSec: 10,
      now: () => now,
    });

    wal.append(makeFrame(1)); // at t=1_000_000
    now += 15_000; // jump 15s forward — frame 1 is now beyond 10s horizon
    wal.append(makeFrame(2)); // at t=1_015_000

    wal.close();

    expect(wal.count()).toBe(1);
    expect(wal.earliestId()).toBe(2);

    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.reason).toBe('older_than_wal_horizon');
      expect(result.earliestAvailableId).toBe(2);
    }
  });

  it('count eviction: keeps only maxEvents newest events', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1', maxEvents: 3 });
    for (let i = 1; i <= 5; i++) {
      wal.append(makeFrame(i));
    }
    wal.close();

    expect(wal.count()).toBe(3);
    expect(wal.earliestId()).toBe(3);
    expect(wal.latestId()).toBe(5);

    const result = wal.replayFrom(0);
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.reason).toBe('older_than_wal_horizon');
      expect(result.earliestAvailableId).toBe(3);
    }
  });

  it('replay from cursor older than earliest returns truncated with earliestAvailableId', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1', maxEvents: 2 });
    wal.append(makeFrame(10));
    wal.append(makeFrame(11));
    wal.append(makeFrame(12)); // evicts 10
    wal.close();

    const result = wal.replayFrom(5); // 5 < 11 (earliest)
    expect(result.truncated).toBe(true);
    if (result.truncated) {
      expect(result.earliestAvailableId).toBe(11);
    }
  });

  it('torn-tail recovery: ignores incomplete frame at end of segment', () => {
    const wal = new SessionWal({ dir, sessionId: 'sess-1' });
    wal.append(makeFrame(1));
    wal.append(makeFrame(2));
    wal.close();

    // Corrupt the active segment: append a partial length prefix (3 bytes instead of 4+payload)
    const segPath = join(dir, 'wal', 'sess-1.log');
    const existing = readFileSync(segPath);
    const torn = Buffer.concat([existing, Buffer.from([0x00, 0x00, 0x10])]);
    writeFileSync(segPath, torn);

    // Re-open should recover cleanly
    const wal2 = new SessionWal({ dir, sessionId: 'sess-1' });
    const result = wal2.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([1, 2]);
    }
    wal2.close();
  });

  it('segment rotation: creates .log.1 once active segment exceeds segmentMaxBytes', () => {
    const wal = new SessionWal({
      dir,
      sessionId: 'sess-1',
      segmentMaxBytes: 50, // tiny threshold to force rotation quickly
    });

    // Each frame is ~50+ bytes; after first append it will rotate
    wal.append(makeFrame(1, 'session_update', { text: 'a'.repeat(40) }));
    wal.append(makeFrame(2, 'session_update', { text: 'b'.repeat(40) }));
    wal.close();

    expect(existsSync(join(dir, 'wal', 'sess-1.log.1'))).toBe(true);

    const wal2 = new SessionWal({ dir, sessionId: 'sess-1' });
    const result = wal2.replayFrom(0);
    expect(result.truncated).toBe(false);
    if (!result.truncated) {
      expect(result.events.map((e) => e.id)).toEqual([1, 2]);
    }
    wal2.close();
  });
});

describe('encodeFrame / decodeSegment', () => {
  it('round-trips a frame through encode + decode', () => {
    const frame: WalFrame = {
      id: 42,
      v: 1,
      type: 'session_update',
      data: { x: 1 },
    };
    const encoded = encodeFrame(frame);
    const path = join(makeTmpDir(), 'test.log');
    writeFileSync(path, encoded);
    const decoded = [...decodeSegment(path)];
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(frame);
  });
});
