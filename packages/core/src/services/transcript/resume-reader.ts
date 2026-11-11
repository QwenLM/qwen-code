/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  sameTranscriptSnapshot,
  matchesTranscriptSnapshot,
} from './snapshot.js';
import { runTranscriptSteps } from './cooperative.js';
import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { isNodeError } from '../../utils/errors.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  isTranscriptMessage,
  type Entry,
} from '../../protocol/transcript/entry.js';
import {
  isCompactBoundary,
  isCommittedCompactBoundary,
  recordCompactCommit,
  type CompactCommit,
} from './compatibility.js';
import { buildTranscriptIndexSteps, type TranscriptIndex } from './index.js';
import {
  COMPACT_TAIL_THRESHOLD_BYTES,
  type EntryScanner,
  type ScannedTranscriptLine,
  type TranscriptFileSnapshot,
} from './scanner.js';
import {
  ResumeReadError,
  type ResumeReadAttempt,
} from './resume-read-budget.js';
import type {
  ResumeTranscriptReadOptions,
  ResumeTranscriptResult,
} from './repository.js';

interface Position {
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly order: number;
  readonly line: number;
}

/** 全文件 UUID 去重只保留最后位置和会话，不保留已裁掉正文的图信息。 */
interface MessageDescriptor extends Position {
  readonly sessionId: string;
}

/** 边界按物理记录保存；同 UUID 的不同版本可能具有不同提交状态。 */
interface CompactDescriptor extends Position {
  readonly type: 'system';
  readonly uuid: string;
  readonly sessionId: string;
  readonly parentUuid: string | null;
  readonly preserved: boolean;
  readonly requiresActiveLeafCommit?: boolean;
}

interface ReplacementPosition extends Position {
  readonly targets: readonly string[];
}

interface Structure {
  readonly messages: Map<string, MessageDescriptor>;
  readonly compacts: CompactDescriptor[];
  readonly metadata: Position[];
  readonly latestMetadata: Map<string, Position>;
  readonly snapshots: Map<string, Position>;
  readonly replacements: ReplacementPosition[];
  readonly commits: Map<string, CompactCommit>;
  marker?: { readonly leafUuid: string | null };
  mixedSession: boolean;
}

type ProjectResume = (
  index: TranscriptIndex,
  messageUuids: readonly string[],
  retainedEntries: number,
) => Promise<ResumeTranscriptResult>;

/** Full history boundary for consumers that must inspect every persisted branch. */
export async function readBoundedTranscriptIndex<T>(
  filePath: string,
  attempt: ResumeReadAttempt,
  scanner: EntryScanner,
  project: (index: TranscriptIndex) => Promise<T>,
): Promise<T | null> {
  attempt.check();
  attempt.resetRetained();
  attempt.resetStructure();
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const snapshot = snapshotFromStat(await handle.stat());
    if (snapshot.size > attempt.limits.maxRetainedBytes)
      throw new ResumeReadError('unsafe');
    const lines: ScannedTranscriptLine[] = [];
    await scanner.consume(
      filePath,
      (line, validatedNestedItems) => {
        attempt.check();
        if (line.decoded.kind !== 'entry') return;
        const entry = line.decoded.entry;
        assertSafeDerivation(entry);
        const nested = validatedNestedItems ?? attempt.validateValue(entry);
        attempt.retain(
          line.byteLength + 1,
          nested,
          !isTranscriptMessage(entry),
        );
        // Reserve the index, compatibility graph and projection containers.
        // 嵌套项数量已由 retain() 的 maxNestedItems 预算约束，不重复计入结构
        // 条目预算；结构条目只统计解码后的物理记录数，避免嵌套密集的历史在
        // 其余预算均满足时仍被双重计数拒绝。
        attempt.addStructure(768 + nested * 24, 1);
        lines.push(line);
      },
      { attempt, handle, snapshot },
    );
    await assertSnapshot(filePath, handle, snapshot);
    const index = await runTranscriptSteps(
      buildTranscriptIndexSteps({
        filePath,
        snapshot,
        startOffset: 0,
        endOffset: snapshot.size,
        lines,
        diagnostics: [],
        bytesRead: snapshot.size,
      }),
      attempt,
    );
    const result = await project(index);
    await yieldToEventLoop();
    attempt.check();
    await assertSnapshot(filePath, handle, snapshot);
    attempt.check();
    return result;
  } finally {
    await handle.close();
  }
}

/** Repository 的内部两阶段读取；借用一个 descriptor 和一个 attempt，不结束租约。 */
export async function readBoundedTranscript(
  filePath: string,
  options: ResumeTranscriptReadOptions,
  scanner: EntryScanner,
  project: ProjectResume,
): Promise<ResumeTranscriptResult | null> {
  const { attempt, sessionId } = options;
  attempt.check();
  attempt.resetRetained();
  attempt.resetStructure();
  let handle: FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const snapshot = snapshotFromStat(await handle.stat());
    const historical =
      options.view === 'historical' || !!options.resumeSessionAt;
    // historical / fork 必须完整保留正文；超过保留预算属于容量超限（budget），
    // 不是不可信结构，不能报成 unsafe。
    if (historical && snapshot.size > attempt.limits.maxRetainedBytes)
      throw new ResumeReadError('budget');
    const structure: Structure = {
      messages: new Map(),
      compacts: [],
      metadata: [],
      latestMetadata: new Map(),
      snapshots: new Map(),
      replacements: [],
      commits: new Map(),
      mixedSession: false,
    };
    const diagnosticCounts = { malformed: 0, unknown: 0, 'invalid-shape': 0 };
    await scanner.consume(
      filePath,
      (line) => {
        attempt.check();
        if (line.decoded.kind !== 'entry')
          diagnosticCounts[line.decoded.kind]++;
        collectStructure(structure, line, options);
      },
      { attempt, handle, snapshot },
    );
    await assertSnapshot(filePath, handle, snapshot);
    const boundary = historical
      ? undefined
      : selectSafeBoundary(structure, snapshot, sessionId, attempt);
    const startOffset = boundary?.byteOffset;
    if (
      startOffset === undefined &&
      snapshot.size > attempt.limits.maxRetainedBytes
    ) {
      throw new ResumeReadError('unsafe');
    }

    // 全文件 UUID 的 Map 初次插入顺序与旧 index 保持一致，不使用局部索引的 keys。
    attempt.addStructure(16 * structure.messages.size, structure.messages.size);
    const messageUuids = Array.from(structure.messages.keys());
    const selectedUuids = new Set<string>();
    const start = startOffset ?? 0;
    for (const [uuid, message] of structure.messages) {
      attempt.check();
      if (start > 0 && message.byteOffset >= start) {
        attempt.addStructure(32);
        selectedUuids.add(uuid);
      }
    }
    const prefix: Position[] = [];
    const addPrefix = (position: Position) => {
      attempt.addStructure(32);
      prefix.push(position);
    };
    if (start > 0) {
      for (const position of structure.metadata) {
        attempt.check();
        if (position.byteOffset < start) addPrefix(position);
      }
      for (const position of structure.latestMetadata.values()) {
        attempt.check();
        if (position.byteOffset < start) addPrefix(position);
      }
      for (const [uuid, position] of structure.snapshots) {
        attempt.check();
        if (selectedUuids.has(uuid) && position.byteOffset < start)
          addPrefix(position);
      }
      for (const position of structure.replacements) {
        attempt.check();
        if (
          position.byteOffset < start &&
          position.targets.some((uuid) => selectedUuids.has(uuid))
        ) {
          addPrefix(position);
        }
      }
      prefix.sort((left, right) => left.byteOffset - right.byteOffset);
    }
    structure.messages.clear();
    structure.compacts.length = 0;
    structure.metadata.length = 0;
    structure.latestMetadata.clear();
    structure.snapshots.clear();
    structure.replacements.length = 0;
    structure.commits.clear();
    selectedUuids.clear();
    attempt.resetStructure();
    for (const uuid of messageUuids)
      attempt.addStructure(stringBytes(uuid) + 64);
    attempt.addStructure(prefix.length * 64, prefix.length);
    attempt.resetRetained();

    const lines: ScannedTranscriptLine[] = [];
    const retain = (
      line: ScannedTranscriptLine,
      validatedNestedItems?: number,
    ) => {
      attempt.check();
      if (line.decoded.kind !== 'entry') return;
      const entry = line.decoded.entry;
      assertSafeDerivation(entry);
      const nested = validatedNestedItems ?? attempt.validateValue(entry);
      attempt.retain(line.byteLength + 1, nested, !isTranscriptMessage(entry));
      // index、兼容图及投影只复制引用；在派生前为这些线性容器预留结构额度。
      // 嵌套项数量由 retain() 的 maxNestedItems 预算约束，此处条目数只统计
      // 物理记录，与 readBoundedTranscriptIndex 的口径保持一致。
      attempt.addStructure(768 + nested * 24, 1);
      lines.push(line);
    };
    // 只合并相邻记录，避免为每条元数据重新分配扫描缓冲、发起 read。
    // 保留全文件 order；不能将范围内局部序号用于 compact 提交判定。
    for (let first = 0; first < prefix.length; ) {
      let end = first + 1;
      let endOffset = prefix[first].byteOffset + prefix[first].byteLength + 1;
      while (end < prefix.length && prefix[end].byteOffset === endOffset) {
        attempt.check();
        endOffset += prefix[end].byteLength + 1;
        end++;
      }
      let current = first;
      await scanner.consume(
        filePath,
        (line, nested) => retain({ ...line, ...prefix[current++] }, nested),
        {
          attempt,
          handle,
          snapshot,
          startOffset: prefix[first].byteOffset,
          endOffset: Math.min(snapshot.size, endOffset),
        },
      );
      first = end;
    }
    prefix.length = 0;
    await scanner.consume(
      filePath,
      (line, nested) => {
        // 前缀 commit 与尾段边界必须处于同一全文件 order 域。
        retain({ ...line, order: line.order + (boundary?.order ?? 0) }, nested);
      },
      {
        attempt,
        handle,
        snapshot,
        startOffset: start,
      },
    );
    await assertSnapshot(filePath, handle, snapshot);
    await yieldToEventLoop();
    attempt.check();
    const index = await runTranscriptSteps(
      buildTranscriptIndexSteps({
        filePath,
        snapshot,
        startOffset: start,
        endOffset: snapshot.size,
        lines,
        diagnostics: [],
        bytesRead: snapshot.size,
      }),
      attempt,
    );
    await yieldToEventLoop();
    attempt.check();
    const result = await project(index, messageUuids, lines.length);
    await yieldToEventLoop();
    attempt.check();
    if (
      result.chain.some(
        (message) => message.sessionId && message.sessionId !== sessionId,
      )
    ) {
      throw new ResumeReadError('unsafe');
    }
    attempt.check();
    await assertSnapshot(filePath, handle, snapshot);
    attempt.check();
    runLogger.debug('[transcript.resume.read]', {
      strategy: startOffset === undefined ? 'bounded-full' : 'compact-tail',
      fileBytes: snapshot.size,
      ...attempt.stats,
      diagnosticCounts,
    });
    return result;
  } finally {
    await handle.close();
  }
}

function collectStructure(
  structure: Structure,
  line: ScannedTranscriptLine,
  { attempt, sessionId }: ResumeTranscriptReadOptions,
): void {
  if (line.decoded.kind !== 'entry') return;
  const entry = line.decoded.entry;
  const position: Position = {
    byteOffset: line.byteOffset,
    byteLength: line.byteLength,
    order: line.order,
    line: line.line,
  };
  if (isTranscriptMessage(entry)) {
    attempt.addStructure(96 + stringBytes(entry.uuid, entry.sessionId));
    structure.messages.set(entry.uuid, {
      ...position,
      sessionId: entry.sessionId,
    });
    if (isCompactBoundary(entry)) {
      attempt.addStructure(
        128 + stringBytes(entry.uuid, entry.sessionId, entry.parentUuid),
      );
      structure.compacts.push({
        ...position,
        type: 'system',
        uuid: entry.uuid,
        sessionId: entry.sessionId,
        parentUuid: entry.parentUuid,
        preserved: !!entry.compactMetadata?.preservedSegment,
        requiresActiveLeafCommit: entry.requiresActiveLeafCommit,
      });
    }
    if (entry.sessionId !== sessionId) structure.mixedSession = true;
  } else if (entry.type === 'file-history-snapshot') {
    attempt.addStructure(80 + stringBytes(entry.messageId));
    structure.snapshots.set(entry.messageId, position);
  } else if (entry.type === 'content-replacement') {
    const targets: string[] = [];
    attempt.addStructure(80);
    for (const replacement of entry.replacements) {
      if (!replacement || typeof replacement.messageUuid !== 'string')
        throw new ResumeReadError('unsafe');
      attempt.addStructure(24 + stringBytes(replacement.messageUuid));
      targets.push(replacement.messageUuid);
    }
    structure.replacements.push({ ...position, targets });
  } else {
    // 只折叠 reducer 的 last-write-wins 标量；提交和 Worktree 历史事实不得折叠。
    const key =
      entry.type === 'summary'
        ? `summary:${entry.leafUuid}`
        : entry.type !== 'active-leaf' && entry.type !== 'worktree-state'
          ? `${entry.type}:${entry.sessionId}`
          : undefined;
    attempt.addStructure(64 + stringBytes(key));
    if (key) structure.latestMetadata.set(key, position);
    else structure.metadata.push(position);
    if (entry.type === 'active-leaf') {
      if (entry.sessionId === sessionId)
        structure.marker = { leafUuid: entry.leafUuid };
      if (!entry.explicit && entry.compactBoundaryUuid) {
        attempt.addStructure(
          80 + stringBytes(entry.compactBoundaryUuid, entry.sessionId),
        );
      }
      recordCompactCommit(entry, line.order, structure.commits);
    }
  }
}

function selectSafeBoundary(
  structure: Structure,
  snapshot: TranscriptFileSnapshot,
  sessionId: string,
  attempt: ResumeReadAttempt,
): CompactDescriptor | undefined {
  if (snapshot.size <= COMPACT_TAIL_THRESHOLD_BYTES || structure.mixedSession)
    return undefined;
  let boundary: CompactDescriptor | undefined;
  for (const candidate of structure.compacts) {
    attempt.check();
    if (
      !candidate.preserved &&
      candidate.sessionId === sessionId &&
      isCommittedCompactBoundary(candidate, candidate.order, structure.commits)
    )
      boundary = candidate;
  }
  // Writer 每次 compact 都写物理根边界（parentUuid=null，旧父节点保存在
  // logicalParentUuid），多次 compact 的会话最新边界同样是根；带父节点的边界
  // 不是可裁剪的独立起点，退回受限全读。
  if (!boundary || boundary.parentUuid !== null) return undefined;
  const start = boundary.byteOffset;
  for (const candidate of structure.compacts) {
    attempt.check();
    if (candidate.byteOffset >= start && candidate.preserved) return undefined;
  }
  // collectResumeMessages 在普通截点清空旧正文，parent/provider 修复只消费尾段；
  // 不在这里重新证明已经被兼容层裁掉的图，全文件 UUID 种子仍独立保留。
  const leaf = structure.marker?.leafUuid;
  if (leaf) {
    const target = structure.messages.get(leaf);
    if (!target || target.byteOffset < start || target.sessionId !== sessionId)
      return undefined;
  }
  return boundary;
}

/** codec 的宽松容错不应让恢复派生阶段抛出不受控的 TypeError。 */
function assertSafeDerivation(entry: Entry): void {
  if (isTranscriptMessage(entry)) {
    if (
      (entry.type === 'assistant' && !Array.isArray(entry.message.content)) ||
      (entry.type === 'user' &&
        typeof entry.message.content !== 'string' &&
        !Array.isArray(entry.message.content)) ||
      (entry.type === 'system' && typeof entry.content !== 'string')
    )
      throw new ResumeReadError('unsafe');
    if (
      (entry.type === 'assistant' || entry.type === 'user') &&
      Array.isArray(entry.message.content) &&
      entry.message.content.some(
        (block) => !block || typeof block.type !== 'string',
      )
    )
      throw new ResumeReadError('unsafe');
  } else if (entry.type === 'file-history-snapshot') {
    if (
      !entry.snapshot.trackedFileBackups ||
      typeof entry.snapshot.trackedFileBackups !== 'object' ||
      Object.values(entry.snapshot.trackedFileBackups).some(
        (backup) => !backup || typeof backup !== 'object',
      )
    ) {
      throw new ResumeReadError('unsafe');
    }
  } else if (
    entry.type === 'content-replacement' &&
    entry.replacements.some(
      (replacement) =>
        !replacement || typeof replacement.messageUuid !== 'string',
    )
  )
    throw new ResumeReadError('unsafe');
}

function stringBytes(...values: Array<string | null | undefined>): number {
  let bytes = 0;
  for (const value of values)
    if (typeof value === 'string')
      bytes += Buffer.byteLength(value, 'utf8') * 2;
  return bytes;
}

function snapshotFromStat(stat: Stats): TranscriptFileSnapshot {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedTimeMs: stat.mtimeMs,
    changedTimeMs: stat.ctimeMs,
  };
}

async function assertSnapshot(
  filePath: string,
  handle: FileHandle,
  snapshot: TranscriptFileSnapshot,
): Promise<void> {
  if (
    !sameTranscriptSnapshot(snapshot, await handle.stat()) ||
    !(await matchesTranscriptSnapshot(filePath, snapshot))
  ) {
    throw new ResumeReadError('snapshot');
  }
}
