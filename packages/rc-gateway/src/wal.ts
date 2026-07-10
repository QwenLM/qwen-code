/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Durable per-session event write-ahead log (WAL).
 *
 * Ported from the donor reference implementation at
 * packages/cli/src/serve/remoteControl/wal.ts (qwen-code-remote repo),
 * adapted for the rc-gateway's numeric event-id frame shape.
 *
 * Framing: each frame is a 4-byte big-endian unsigned length prefix followed
 * by exactly that many bytes of UTF-8 JSON (the WalFrame). The fixed-width
 * prefix lets us forward-scan a segment cheaply and detect a torn trailing
 * frame without speculative JSON parsing.
 *
 * On-disk layout: <dir>/wal/<sessionId>.log is the active segment; rotated
 * segments are <sessionId>.log.1, <sessionId>.log.2, ... where a higher
 * numeric suffix is OLDER. Replay scans oldest -> newest.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** Width of the big-endian length prefix that precedes each JSON frame. */
const LENGTH_PREFIX_BYTES = 4;

/**
 * The frame shape stored in the WAL. Mirrors the daemon's DaemonEvent shape
 * (id is a numeric integer, not hex), so frames can be replayed directly as
 * SSE data payloads without conversion.
 */
export interface WalFrame {
  id: number;
  v: number;
  type: string;
  data: unknown;
  [extra: string]: unknown;
}

/** Result of a replay request — discriminated on `truncated`. */
export type ReplayResult =
  | { truncated: false; events: WalFrame[] }
  | {
      truncated: true;
      events: WalFrame[];
      earliestAvailableId: number | null;
      reason: 'older_than_wal_horizon' | 'no_wal';
    };

/** WAL retention defaults (matches donor's DEFAULTS). */
export const WAL_DEFAULTS = {
  walMaxEvents: 10_000,
  walHorizonSec: 86_400,
  walSegmentMaxBytes: 16 * 1024 * 1024,
} as const;

export interface SessionWalOptions {
  /** Root directory; the WAL lives at <dir>/wal/<sessionId>.log. */
  dir: string;
  sessionId: string;
  /** Rotate the active segment once it exceeds this many bytes. */
  segmentMaxBytes?: number;
  /** Retain at most this many events (older bound wins vs. horizon). */
  maxEvents?: number;
  /** Retain events newer than now - horizonSec (older bound wins). */
  horizonSec?: number;
  /** Injectable clock (epoch ms) for horizon tests. Defaults to Date.now. */
  now?: () => number;
}

/** Per-frame metadata for every retained event across all segments. */
interface FrameMeta {
  id: number;
  /** Append wall-clock time (epoch ms) captured at write time. */
  appendedAtMs: number;
  /** Byte length of the full frame (prefix + payload) on disk. */
  frameBytes: number;
}

/**
 * A per-session write-ahead log. One instance owns one session's segments and
 * may be re-opened against an existing directory (e.g. after a gateway restart),
 * recovering its counters by scanning the segments.
 */
export class SessionWal {
  readonly sessionId: string;
  private readonly walDir: string;
  private readonly activePath: string;
  private readonly segmentMaxBytes: number;
  private readonly maxEvents: number;
  private readonly horizonSec: number;
  private readonly now: () => number;

  /** Append-mode fd for the active segment, or null until opened. */
  private fd: number | null = null;
  /** Current byte size of the active segment. */
  private activeBytes = 0;

  /**
   * Per-frame metadata for every retained event across all segments, in
   * ascending id order. Used to compute counts/horizon and to enforce the
   * bound by dropping leading frames / pruning segments.
   */
  private frames: FrameMeta[] = [];
  private _earliest: number | null = null;
  private _latest: number | null = null;

  constructor(opts: SessionWalOptions) {
    this.sessionId = opts.sessionId;
    this.walDir = join(opts.dir, 'wal');
    this.activePath = join(this.walDir, `${opts.sessionId}.log`);
    this.segmentMaxBytes =
      opts.segmentMaxBytes ?? WAL_DEFAULTS.walSegmentMaxBytes;
    this.maxEvents = opts.maxEvents ?? WAL_DEFAULTS.walMaxEvents;
    this.horizonSec = opts.horizonSec ?? WAL_DEFAULTS.walHorizonSec;
    this.now = opts.now ?? Date.now;

    mkdirSync(this.walDir, { recursive: true });
    this.recover();
  }

  // -- accessors ----------------------------------------------------------

  /** Earliest retained event id or null when empty. */
  earliestId(): number | null {
    return this._earliest;
  }

  /** Latest retained event id or null when empty. */
  latestId(): number | null {
    return this._latest;
  }

  /** Number of retained events across all segments. */
  count(): number {
    return this.frames.length;
  }

  // -- write path ---------------------------------------------------------

  /**
   * Encode `frame` as one length-prefixed frame and append it to the active
   * segment via a single append-mode write. Updates counters, rotates when the
   * active segment exceeds segmentMaxBytes, then enforces the retention bounds.
   */
  append(frame: WalFrame): void {
    const encoded = encodeFrame(frame);
    const fd = this.ensureOpen();
    writeSync(fd, encoded, 0, encoded.length);

    const appendedAtMs = this.now();
    this.activeBytes += encoded.length;
    this.frames.push({
      id: frame.id,
      appendedAtMs,
      frameBytes: encoded.length,
    });
    if (this._earliest === null) {
      this._earliest = frame.id;
    }
    this._latest = frame.id;

    if (this.activeBytes > this.segmentMaxBytes) {
      this.rotate();
    }
    this.enforceBounds();
  }

  /** Flush + close the active fd. Safe to call multiple times. */
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  // -- replay path --------------------------------------------------------

  /**
   * Replay events with id strictly greater than `lastEventId`, scanning
   * segments oldest -> newest in ascending id order.
   *
   * - If `lastEventId` is OLDER than the earliest retained id (and not the
   *   predecessor boundary), the requested resume point has fallen out of the
   *   WAL: return a truncated result carrying `earliestAvailableId` so the
   *   caller can emit a `replay_truncated` event and respond 412.
   * - Otherwise return the in-range events in ascending order; the caller then
   *   transitions to live streaming.
   */
  replayFrom(lastEventId: number): ReplayResult {
    // Empty WAL: nothing retained. Anything but the genesis cursor (0) is
    // treated as truncated since we cannot vouch for the gap.
    if (this._earliest === null) {
      if (lastEventId === 0) {
        return { truncated: false, events: [] };
      }
      return {
        truncated: true,
        events: [],
        earliestAvailableId: null,
        reason: 'no_wal',
      };
    }

    // The resume cursor is older than anything we still hold AND it is not the
    // exact predecessor boundary we can vouch for: signal truncation.
    if (lastEventId < this._earliest - 1) {
      return {
        truncated: true,
        events: [],
        earliestAvailableId: this._earliest,
        reason: 'older_than_wal_horizon',
      };
    }

    const events: WalFrame[] = [];
    for (const seg of this.segmentsOldestToNewest()) {
      for (const frame of decodeSegment(seg)) {
        if (frame.id > lastEventId) {
          events.push(frame);
        }
      }
    }
    events.sort((a, b) => a.id - b.id);
    return { truncated: false, events };
  }

  // -- internals ----------------------------------------------------------

  private ensureOpen(): number {
    if (this.fd === null) {
      // 'a' => append mode; every write lands at end-of-file atomically.
      this.fd = openSync(this.activePath, 'a');
      this.activeBytes = existsSync(this.activePath)
        ? fstatSync(this.fd).size
        : 0;
    }
    return this.fd;
  }

  /**
   * Re-derive counters by scanning every existing segment. Tolerates a torn
   * trailing frame in any segment (ignored as a truncated tail).
   */
  private recover(): void {
    this.frames = [];
    this._earliest = null;
    this._latest = null;

    for (const seg of this.segmentsOldestToNewest()) {
      // Use the file mtime as a best-effort append time for recovered frames so
      // the horizon bound still applies across restarts.
      const mtimeMs = statSync(seg).mtimeMs;
      for (const { frame, frameBytes } of decodeSegmentWithSizes(seg)) {
        this.frames.push({ id: frame.id, appendedAtMs: mtimeMs, frameBytes });
        if (this._earliest === null) {
          this._earliest = frame.id;
        }
        this._latest = frame.id;
      }
    }

    if (existsSync(this.activePath)) {
      this.activeBytes = statSync(this.activePath).size;
    }
  }

  /**
   * Rotate the active segment: <sid>.log -> <sid>.log.1, shifting any existing
   * .log.N up to .log.(N+1) first so a higher suffix stays older.
   */
  private rotate(): void {
    this.close();

    const suffixes = this.rotatedSuffixesDescending();
    for (const n of suffixes) {
      renameSync(this.segPath(n), this.segPath(n + 1));
    }
    if (existsSync(this.activePath)) {
      renameSync(this.activePath, this.segPath(1));
    }
    this.activeBytes = 0;
    // Eagerly reopen so the active segment exists as an empty file even before
    // the next append.
    this.ensureOpen();
  }

  /**
   * Enforce both retention bounds; the OLDER bound wins. Drop leading (oldest)
   * frames whose id is below the threshold, then delete any rotated segment
   * whose every frame has been dropped.
   */
  private enforceBounds(): void {
    if (this.frames.length === 0) {
      return;
    }

    // Bound A: event count. The oldest index we may keep.
    let keepFromCount = 0;
    if (this.frames.length > this.maxEvents) {
      keepFromCount = this.frames.length - this.maxEvents;
    }

    // Bound B: wall-clock horizon.
    const cutoffMs = this.now() - this.horizonSec * 1000;
    let keepFromHorizon = 0;
    while (
      keepFromHorizon < this.frames.length &&
      this.frames[keepFromHorizon]!.appendedAtMs < cutoffMs
    ) {
      keepFromHorizon += 1;
    }

    // Older bound wins => keep from the LATER (larger) of the two cut indices.
    const dropCount = Math.max(keepFromCount, keepFromHorizon);
    if (dropCount <= 0) {
      return;
    }

    this.frames = this.frames.slice(dropCount);
    this._earliest = this.frames.length > 0 ? this.frames[0]!.id : null;
    if (this.frames.length === 0) {
      this._latest = null;
    }

    this.pruneEmptySegments();
  }

  /**
   * Delete whole rotated segments that no longer contain any retained frame.
   * A rotated segment is droppable when its newest (last) id is < the current
   * earliest retained id. We never delete the active segment here.
   */
  private pruneEmptySegments(): void {
    const earliest = this._earliest;
    for (const n of this.rotatedSuffixesDescending()) {
      const path = this.segPath(n);
      let newestInSeg: number | null = null;
      for (const frame of decodeSegment(path)) {
        newestInSeg = frame.id;
      }
      // Segment fully below the retained window (or empty) => delete it.
      if (newestInSeg === null || earliest === null || newestInSeg < earliest) {
        rmSync(path, { force: true });
      }
    }
  }

  // -- segment path helpers ----------------------------------------------

  private segPath(n: number): string {
    return n === 0 ? this.activePath : `${this.activePath}.${n}`;
  }

  /** Existing rotated suffixes (>=1), sorted DESCENDING (oldest first). */
  private rotatedSuffixesDescending(): number[] {
    const base = `${this.sessionId}.log.`;
    const out: number[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.walDir);
    } catch {
      return out;
    }
    for (const name of entries) {
      if (!name.startsWith(base)) {
        continue;
      }
      const tail = name.slice(base.length);
      if (!/^[0-9]+$/.test(tail)) {
        continue;
      }
      out.push(Number(tail));
    }
    out.sort((a, b) => b - a);
    return out;
  }

  /** All segment paths in oldest -> newest order (rotated desc, then active). */
  private segmentsOldestToNewest(): string[] {
    const paths: string[] = [];
    for (const n of this.rotatedSuffixesDescending()) {
      paths.push(this.segPath(n));
    }
    if (existsSync(this.activePath)) {
      paths.push(this.activePath);
    }
    return paths;
  }
}

// ---------------------------------------------------------------------------
// Framing helpers (exported for tests / reuse)
// ---------------------------------------------------------------------------

/** Encode one WalFrame as a 4-byte big-endian length prefix + UTF-8 JSON. */
export function encodeFrame(frame: WalFrame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  const encoded = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + json.length);
  encoded.writeUInt32BE(json.length, 0);
  json.copy(encoded, LENGTH_PREFIX_BYTES);
  return encoded;
}

/**
 * Forward-scan a buffer yielding decoded frames with byte sizes. A torn
 * trailing frame (the length prefix promises more bytes than remain, or the
 * prefix itself is partial) is treated as a truncated tail and silently
 * ignored — we stop the scan rather than crash.
 */
function* decodeBuffer(
  buf: Buffer,
): Generator<{ frame: WalFrame; frameBytes: number }> {
  let offset = 0;
  while (offset + LENGTH_PREFIX_BYTES <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const start = offset + LENGTH_PREFIX_BYTES;
    const end = start + len;
    if (end > buf.length) {
      // Torn/partial frame: stop; this is the truncated tail.
      return;
    }
    const slice = buf.subarray(start, end);
    let frame: WalFrame;
    try {
      frame = JSON.parse(slice.toString('utf8')) as WalFrame;
    } catch {
      // Corrupt payload: treat the rest as untrustworthy and stop.
      return;
    }
    yield { frame, frameBytes: LENGTH_PREFIX_BYTES + len };
    offset = end;
  }
}

/** Decode a segment file path into WalFrames (torn tail tolerated). */
export function* decodeSegment(path: string): Generator<WalFrame> {
  if (!existsSync(path)) {
    return;
  }
  const buf = readFileSync(path);
  for (const { frame } of decodeBuffer(buf)) {
    yield frame;
  }
}

/** Like decodeSegment but also yields each frame's on-disk byte size. */
function* decodeSegmentWithSizes(
  path: string,
): Generator<{ frame: WalFrame; frameBytes: number }> {
  if (!existsSync(path)) {
    return;
  }
  const buf = readFileSync(path);
  yield* decodeBuffer(buf);
}
