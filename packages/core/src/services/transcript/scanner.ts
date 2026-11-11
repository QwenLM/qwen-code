/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { decodeTranscriptLine, type DecodedTranscriptLine } from './entry-codec.js';
import {
  ResumeReadError,
  type ResumeReadAttempt,
} from './resume-read-budget.js';

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const LARGE_ENTRY_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
/**
 * Byte threshold past which pre-compact history is dropped: the scanner takes
 * the compact-tail read path and {@link applyTranscriptCompatibility} prunes
 * messages before the latest non-preserved compact boundary. Both layers must
 * agree, so this is the single source of truth.
 */
export const COMPACT_TAIL_THRESHOLD_BYTES = 5 * 1024 * 1024;
const ENTRY_TYPE_PREFIX_BYTES = 4 * 1024;
const PRE_COMPACT_METADATA_TYPES = new Set([
  'summary',
  'custom-title',
  'ai-title',
  'last-prompt',
  'tag',
  'workspace-directories',
  'runtime-config',
  'mode',
  'active-leaf',
  'relocated',
  'worktree-state',
]);

export type ScanProfile =
  | { readonly kind: 'full' }
  | { readonly kind: 'metadata' }
  | { readonly kind: 'compact-tail' }
  | {
      readonly kind: 'range';
      readonly startOffset: number;
      readonly endOffset?: number;
    };

export interface ScannedTranscriptLine {
  readonly order: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly line: number;
  readonly decoded: DecodedTranscriptLine;
}

export interface TranscriptScanDiagnostic {
  readonly kind: 'large-entry';
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly line: number;
}

export interface TranscriptFileSnapshot {
  readonly device: number;
  readonly inode: number;
  readonly size: number;
  readonly modifiedTimeMs: number;
  readonly changedTimeMs?: number;
}

export interface TranscriptScanResult {
  readonly filePath: string;
  readonly snapshot: TranscriptFileSnapshot;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly lines: readonly ScannedTranscriptLine[];
  readonly diagnostics: readonly TranscriptScanDiagnostic[];
  readonly bytesRead: number;
}

export interface EntryScannerOptions {
  readonly chunkBytes?: number;
}

/** Decodes an already ordered transcript snapshot without reopening its file. */
export function scanTranscriptBuffer(
  filePath: string,
  buffer: Buffer,
): TranscriptScanResult {
  const lines: ScannedTranscriptLine[] = [];
  const diagnostics: TranscriptScanDiagnostic[] = [];
  let lineStartOffset = 0;
  let lineNumber = 1;

  const emitLine = (lineEndOffset: number) => {
    const lineBuffer = buffer.subarray(lineStartOffset, lineEndOffset);
    const byteLength = lineEndOffset - lineStartOffset;
    if (!isBlankLine(lineBuffer)) {
      const decodeBuffer =
        lineStartOffset === 0 && hasUtf8Bom(lineBuffer)
          ? lineBuffer.subarray(3)
          : lineBuffer;
      lines.push({
        order: lines.length,
        byteOffset: lineStartOffset,
        byteLength,
        line: lineNumber,
        decoded: decodeTranscriptLine(decodeBuffer),
      });
      if (byteLength > LARGE_ENTRY_DIAGNOSTIC_BYTES) {
        diagnostics.push({
          kind: 'large-entry',
          byteOffset: lineStartOffset,
          byteLength,
          line: lineNumber,
        });
      }
    }
  };

  for (let offset = 0; offset < buffer.length; offset++) {
    if (buffer[offset] !== 0x0a) {
      continue;
    }
    emitLine(offset);
    lineStartOffset = offset + 1;
    lineNumber++;
  }
  if (lineStartOffset < buffer.length) {
    emitLine(buffer.length);
  }

  return {
    filePath,
    snapshot: {
      device: 0,
      inode: 0,
      size: buffer.length,
      modifiedTimeMs: 0,
    },
    startOffset: 0,
    endOffset: buffer.length,
    lines,
    diagnostics,
    bytesRead: buffer.length,
  };
}

type CandidateDecision = 'undecided' | 'candidate' | 'irrelevant';

interface CompactTailPlan {
  readonly startOffset: number;
  readonly metadataLines: readonly ScannedTranscriptLine[];
  readonly bytesRead: number;
}

/** Reads a stable byte range from one file descriptor and decodes JSONL lines. */
export class EntryScanner {
  private readonly chunkBytes: number;

  constructor(options: EntryScannerOptions = {}) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    if (this.chunkBytes <= 0) {
      throw new RangeError('chunkBytes must be greater than zero');
    }
  }

  async consume(
    filePath: string,
    visitor: (
      line: ScannedTranscriptLine,
      validatedNestedItems?: number,
    ) => void | Promise<void>,
    options: {
      attempt: ResumeReadAttempt;
      handle?: FileHandle;
      snapshot?: TranscriptFileSnapshot;
      startOffset?: number;
      endOffset?: number;
    },
  ): Promise<TranscriptFileSnapshot> {
    const { attempt } = options;
    attempt.check();
    const handle = options.handle ?? (await fs.open(filePath, 'r'));
    try {
      attempt.check();
      const snapshot = options.snapshot ?? toSnapshot(await handle.stat());
      attempt.check();
      const startOffset = options.startOffset ?? 0;
      const endOffset = options.endOffset ?? snapshot.size;
      if (
        !Number.isSafeInteger(snapshot.size) ||
        snapshot.size < 0 ||
        !Number.isSafeInteger(startOffset) ||
        startOffset < 0 ||
        !Number.isSafeInteger(endOffset) ||
        endOffset < startOffset ||
        endOffset > snapshot.size
      ) {
        throw new ResumeReadError('unsafe');
      }
      await this.scanLines(handle, startOffset, endOffset, visitor, false, attempt);
      attempt.check();
      return snapshot;
    } finally {
      if (!options.handle) await handle.close();
    }
  }

  async scan(
    filePath: string,
    profile: ScanProfile = { kind: 'full' },
  ): Promise<TranscriptScanResult> {
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (
        profile.kind === 'compact-tail' &&
        stat.size > COMPACT_TAIL_THRESHOLD_BYTES
      ) {
        const plan = await this.findCompactTailPlan(handle, stat);
        if (plan) {
          const tail = await this.scanHandle(filePath, handle, stat, {
            kind: 'range',
            startOffset: plan.startOffset,
          });
          return mergeCompactTailScan(filePath, stat, plan, tail);
        }
      }
      return await this.scanHandle(filePath, handle, stat, profile);
    } finally {
      await handle.close();
    }
  }

  /**
   * Locates the latest compact boundary without decoding stale message bodies.
   * Writer-produced entries expose `type` near the start of each record. If a
   * historical record violates that invariant, the optimization is abandoned
   * and the caller performs a full scan so persisted protocol semantics win.
   */
  private async findCompactTailPlan(
    handle: FileHandle,
    stat: Stats,
  ): Promise<CompactTailPlan | undefined> {
    const buffer = Buffer.allocUnsafe(this.chunkBytes);
    const metadataLines: ScannedTranscriptLine[] = [];
    const activeLeafMetadataBySession = new Map<
      string,
      ScannedTranscriptLine
    >();
    let latestPlan: CompactTailPlan | undefined;
    let pendingCommit:
      | { readonly boundaryUuid: string; readonly plan: CompactTailPlan }
      | undefined;
    let fastPathSafe = true;
    let lineSegments: Buffer[] = [];
    let retainedBytes = 0;
    let lineBytes = 0;
    let lineStartOffset = 0;
    let lineNumber = 1;
    let decision: CandidateDecision = 'undecided';
    let position = 0;

    const retainSegment = (source: Buffer, start: number, end: number) => {
      if (end <= start || decision === 'irrelevant') {
        return;
      }
      if (decision === 'candidate') {
        const segment = Buffer.from(source.subarray(start, end));
        lineSegments.push(segment);
        retainedBytes += segment.length;
        return;
      }

      const remainingPrefix = ENTRY_TYPE_PREFIX_BYTES - retainedBytes;
      const prefixEnd = Math.min(end, start + Math.max(remainingPrefix, 0));
      if (prefixEnd > start) {
        const segment = Buffer.from(source.subarray(start, prefixEnd));
        lineSegments.push(segment);
        retainedBytes += segment.length;
      }
      decision = classifyCandidatePrefix(
        joinSegments(lineSegments, retainedBytes),
      );
      if (decision === 'candidate' && prefixEnd < end) {
        const segment = Buffer.from(source.subarray(prefixEnd, end));
        lineSegments.push(segment);
        retainedBytes += segment.length;
      } else if (decision === 'irrelevant') {
        lineSegments = [];
        retainedBytes = 0;
      } else if (retainedBytes >= ENTRY_TYPE_PREFIX_BYTES) {
        fastPathSafe = false;
        decision = 'irrelevant';
        lineSegments = [];
        retainedBytes = 0;
      }
    };

    const emitLine = () => {
      if (decision === 'irrelevant') {
        return;
      }
      const lineBuffer = joinSegments(lineSegments, retainedBytes);
      if (isBlankLine(lineBuffer)) {
        return;
      }
      const decodeBuffer =
        lineStartOffset === 0 && hasUtf8Bom(lineBuffer)
          ? lineBuffer.subarray(3)
          : lineBuffer;
      const decoded = decodeTranscriptLine(decodeBuffer);
      if (decoded.kind !== 'entry') {
        return;
      }
      const scanned: ScannedTranscriptLine = {
        order: metadataLines.length + activeLeafMetadataBySession.size,
        byteOffset: lineStartOffset,
        byteLength: lineBytes,
        line: lineNumber,
        decoded,
      };
      if (decoded.entry.type === 'active-leaf') {
        activeLeafMetadataBySession.set(decoded.entry.sessionId, scanned);
        if (
          pendingCommit &&
          decoded.entry.explicit === false &&
          decoded.entry.compactBoundaryUuid === pendingCommit.boundaryUuid
        ) {
          latestPlan = pendingCommit.plan;
          pendingCommit = undefined;
        }
        return;
      }
      if (PRE_COMPACT_METADATA_TYPES.has(decoded.entry.type)) {
        metadataLines.push(scanned);
        return;
      }
      if (
        decoded.entry.type === 'system' &&
        decoded.entry.subtype === 'compact_boundary' &&
        !decoded.entry.compactMetadata?.preservedSegment
      ) {
        const plan = {
          startOffset: lineStartOffset,
          metadataLines: snapshotPreCompactMetadata(
            metadataLines,
            activeLeafMetadataBySession,
          ),
          bytesRead: stat.size,
        };
        if (decoded.entry.requiresActiveLeafCommit === true) {
          pendingCommit = { boundaryUuid: decoded.entry.uuid, plan };
        } else {
          latestPlan = plan;
          pendingCommit = undefined;
        }
      }
    };

    const resetLine = (nextOffset: number) => {
      lineSegments = [];
      retainedBytes = 0;
      lineBytes = 0;
      lineStartOffset = nextOffset;
      lineNumber++;
      decision = 'undecided';
    };

    while (position < stat.size) {
      const requested = Math.min(buffer.length, stat.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) {
        break;
      }
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== 0x0a) {
          continue;
        }
        retainSegment(buffer, segmentStart, index);
        lineBytes += index - segmentStart;
        emitLine();
        resetLine(position + index + 1);
        segmentStart = index + 1;
      }
      retainSegment(buffer, segmentStart, bytesRead);
      lineBytes += bytesRead - segmentStart;
      position += bytesRead;
    }

    if (lineBytes > 0) {
      emitLine();
    }
    return fastPathSafe ? latestPlan : undefined;
  }

  private async scanHandle(
    filePath: string,
    handle: FileHandle,
    stat: Stats,
    profile: ScanProfile,
  ): Promise<TranscriptScanResult> {
    const startOffset = profile.kind === 'range' ? profile.startOffset : 0;
    const requestedEnd =
      profile.kind === 'range' ? (profile.endOffset ?? stat.size) : stat.size;
    if (startOffset < 0 || startOffset > stat.size) {
      throw new RangeError('scan startOffset is outside the file snapshot');
    }
    const endOffset = Math.min(Math.max(requestedEnd, startOffset), stat.size);
    const lines: ScannedTranscriptLine[] = [];
    const diagnostics: TranscriptScanDiagnostic[] = [];
    const bytesRead = await this.scanLines(
      handle,
      startOffset,
      endOffset,
      (line) => {
        lines.push(line);
        if (line.byteLength > LARGE_ENTRY_DIAGNOSTIC_BYTES) {
          diagnostics.push({
            kind: 'large-entry',
            byteOffset: line.byteOffset,
            byteLength: line.byteLength,
            line: line.line,
          });
        }
      },
      profile.kind === 'metadata',
    );
    return {
      filePath,
      snapshot: toSnapshot(stat),
      startOffset,
      endOffset,
      lines,
      diagnostics,
      bytesRead,
    };
  }

  /** 收集读取和逐条释放共用字节内核；仅恢复租约启用预算、取消和让出检查。 */
  private async scanLines(
    handle: FileHandle,
    startOffset: number,
    endOffset: number,
    visitor: (
      line: ScannedTranscriptLine,
      validatedNestedItems?: number,
    ) => void | Promise<void>,
    metadata: boolean,
    attempt?: ResumeReadAttempt,
  ): Promise<number> {
    if (startOffset === endOffset) return 0;
    const buffer = Buffer.allocUnsafe(
      attempt
        ? Math.min(this.chunkBytes, DEFAULT_CHUNK_BYTES, endOffset - startOffset)
        : this.chunkBytes,
    );
    const segments: Buffer[] = [];
    let scratch: Buffer | undefined;
    let segmentUsed = 0;
    let lineBytes = 0;
    let lineStartOffset = startOffset;
    let lineNumber = 1;
    let order = 0;
    let position = startOffset;
    let processedLines = 0;
    let metadataDecision: CandidateDecision = 'undecided';

    const retainSegment = (start: number, end: number) => {
      if (end <= start || metadataDecision === 'irrelevant') return;
      attempt?.checkLineBytes(lineBytes + end - start);
      let cursor = start;
      while (cursor < end) {
        let segment: Buffer | undefined = segments[segments.length - 1];
        if (!segment || segmentUsed === segment.length) {
          // 合并短读、复用首段；对象数量由行字节量而非 read 次数决定。
          segment = segments.length === 0 ? scratch : undefined;
          if (!segment) {
            segment = Buffer.allocUnsafe(
              Math.min(
                DEFAULT_CHUNK_BYTES,
                (attempt?.limits.maxLineBytes ?? Infinity) -
                  lineBytes - (cursor - start),
              ),
            );
            if (segments.length === 0) scratch = segment;
          }
          segments.push(segment);
          segmentUsed = 0;
        }
        const length = Math.min(end - cursor, segment.length - segmentUsed);
        buffer.copy(segment, segmentUsed, cursor, cursor + length);
        cursor += length;
        segmentUsed += length;
      }
      lineBytes += end - start;
      if (metadata && metadataDecision === 'undecided') {
        const prefix = segments[0]
          .subarray(0, Math.min(lineBytes, ENTRY_TYPE_PREFIX_BYTES))
          .toString('utf8');
        // 只优化顶层首字段为 type 的标准记录；其他字段顺序交给完整 codec，
        // 避免把嵌套对象中的 type 当成记录类型而漏读历史元数据。
        const match = /^\s*\{\s*"type"\s*:\s*"([^"\\]+)"/.exec(prefix);
        if (match) {
          metadataDecision = PRE_COMPACT_METADATA_TYPES.has(match[1])
            ? 'candidate'
            : 'irrelevant';
        } else if (lineBytes >= ENTRY_TYPE_PREFIX_BYTES) {
          metadataDecision = 'candidate';
        }
        if (metadataDecision === 'irrelevant') {
          segments.length = 0;
          segmentUsed = 0;
          lineBytes = 0;
        }
      }
    };

    const emitLine = (): void | Promise<void> => {
      if (metadataDecision === 'irrelevant') {
        metadataDecision = 'undecided';
        return;
      }
      attempt?.checkLineBytes(lineBytes);
      if (segments.length > 0) {
        const last = segments.length - 1;
        segments[last] = segments[last].subarray(0, segmentUsed);
      }
      const lineBuffer = joinSegments(segments, lineBytes);
      segments.length = 0;
      segmentUsed = 0;
      const byteLength = lineBytes;
      lineBytes = 0;
      metadataDecision = 'undecided';
      if (isBlankLine(lineBuffer)) return;
      const decodeBuffer =
        lineStartOffset === 0 && hasUtf8Bom(lineBuffer)
          ? lineBuffer.subarray(3)
          : lineBuffer;
      const decoded = decodeTranscriptLine(decodeBuffer);
      let validatedNestedItems: number | undefined;
      if (attempt) {
        if (decoded.kind === 'entry')
          validatedNestedItems = attempt.validateValue(decoded.entry);
        else if (decoded.kind !== 'malformed')
          attempt.validateValue(decoded.value);
        attempt.check();
      }
      if (
        metadata &&
        (decoded.kind !== 'entry' ||
          !PRE_COMPACT_METADATA_TYPES.has(decoded.entry.type))
      ) {
        return;
      }
      return visitor(
        {
          order: order++,
          byteOffset: lineStartOffset,
          byteLength,
          line: lineNumber,
          decoded,
        },
        validatedNestedItems,
      );
    };

    while (position < endOffset) {
      attempt?.check();
      const requested = Math.min(buffer.length, endOffset - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      attempt?.addReadBytes(bytesRead);
      if (bytesRead === 0) {
        if (attempt) throw new ResumeReadError('snapshot');
        break;
      }
      if (bytesRead > requested) throw new ResumeReadError('unsafe');
      let segmentStart = 0;
      const readable = buffer.subarray(0, bytesRead);
      // 在原生 Buffer 中定位换行，只访问本次实际读到的字节。
      for (
        let index = readable.indexOf(0x0a);
        index >= 0;
        index = readable.indexOf(0x0a, index + 1)
      ) {
        retainSegment(segmentStart, index);
        const pending = emitLine();
        if (pending) await pending;
        attempt?.check();
        lineNumber++;
        lineStartOffset = position + index + 1;
        segmentStart = index + 1;
        if (attempt && ++processedLines % 256 === 0) {
          await yieldToEventLoop();
          attempt.check();
        }
      }
      retainSegment(segmentStart, bytesRead);
      position += bytesRead;
      if (attempt) {
        await yieldToEventLoop();
        attempt.check();
      }
    }
    if (lineBytes > 0) {
      const pending = emitLine();
      if (pending) await pending;
    }
    attempt?.check();
    return position - startOffset;
  }
}

function snapshotPreCompactMetadata(
  metadataLines: readonly ScannedTranscriptLine[],
  activeLeafMetadataBySession: ReadonlyMap<string, ScannedTranscriptLine>,
): ScannedTranscriptLine[] {
  return [...metadataLines, ...activeLeafMetadataBySession.values()].sort(
    (left, right) => left.byteOffset - right.byteOffset,
  );
}

function joinSegments(segments: readonly Buffer[], totalBytes: number): Buffer {
  if (segments.length === 0) {
    return Buffer.alloc(0);
  }
  if (segments.length === 1) {
    return segments[0];
  }
  return Buffer.concat(segments, totalBytes);
}

function isBlankLine(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) {
      return false;
    }
  }
  return true;
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function classifyCandidatePrefix(buffer: Buffer): CandidateDecision {
  const match = /"type"\s*:\s*"([^"]+)"/.exec(buffer.toString('utf8'));
  if (!match) {
    return 'undecided';
  }
  const type = match[1];
  return type === 'system' || PRE_COMPACT_METADATA_TYPES.has(type)
    ? 'candidate'
    : 'irrelevant';
}

function mergeCompactTailScan(
  filePath: string,
  stat: Stats,
  plan: CompactTailPlan,
  tail: TranscriptScanResult,
): TranscriptScanResult {
  const lines = [...plan.metadataLines, ...tail.lines].map((line, order) => ({
    ...line,
    order,
  }));
  const metadataDiagnostics: TranscriptScanDiagnostic[] = plan.metadataLines
    .filter((line) => line.byteLength > LARGE_ENTRY_DIAGNOSTIC_BYTES)
    .map((line) => ({
      kind: 'large-entry',
      byteOffset: line.byteOffset,
      byteLength: line.byteLength,
      line: line.line,
    }));
  return {
    filePath,
    snapshot: toSnapshot(stat),
    startOffset: 0,
    endOffset: stat.size,
    lines,
    diagnostics: [...metadataDiagnostics, ...tail.diagnostics],
    bytesRead: plan.bytesRead + tail.bytesRead,
  };
}

function toSnapshot(stat: Stats): TranscriptFileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedTimeMs: stat.mtimeMs,
    changedTimeMs: stat.ctimeMs,
  };
}
