/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { drainTranscriptSteps } from './cooperative.js';
import type {
  ActiveLeafEntry,
  ContentReplacementEntry,
  Entry,
  FileHistorySnapshotEntry,
  RuntimeConfigEntry,
  SessionMode,
  TranscriptWorktreeSession,
  TranscriptMessage,
} from '../../protocol/transcript/entry.js';
import { isTranscriptMessage } from '../../protocol/transcript/entry.js';
import type {
  ScannedTranscriptLine,
  TranscriptFileSnapshot,
  TranscriptScanDiagnostic,
  TranscriptScanResult,
} from './scanner.js';

export interface IndexedTranscriptEntry {
  readonly entry: Entry;
  readonly order: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly line: number;
}

export type TranscriptIndexDiagnostic =
  | TranscriptScanDiagnostic
  | {
      readonly kind: 'malformed' | 'unknown' | 'invalid-shape';
      readonly byteOffset: number;
      readonly byteLength: number;
      readonly line: number;
      readonly type?: string;
    }
  | {
      readonly kind: 'duplicate-uuid';
      readonly uuid: string;
      readonly winningOrder: number;
      readonly orders: readonly number[];
    }
  | {
      readonly kind: 'broken-parent';
      readonly uuid: string;
      readonly parentUuid: string;
    };

export interface TranscriptMetadataView {
  readonly summaries: ReadonlyMap<string, string>;
  readonly customTitles: ReadonlyMap<string, string>;
  readonly aiTitles: ReadonlyMap<string, string>;
  readonly lastPrompts: ReadonlyMap<string, string>;
  readonly tags: ReadonlyMap<string, string>;
  readonly workspaceDirectories: ReadonlyMap<string, readonly string[]>;
  readonly runtimeConfigs: ReadonlyMap<string, RuntimeConfigEntry>;
  readonly modes: ReadonlyMap<string, SessionMode>;
  readonly activeLeaves: ReadonlyMap<string, ActiveLeafEntry>;
  readonly relocatedCwds: ReadonlyMap<string, string>;
  readonly worktreeSessions: ReadonlyMap<
    string,
    TranscriptWorktreeSession | null
  >;
  readonly latestActiveLeaf?: ActiveLeafEntry;
}

export interface TranscriptIndex {
  readonly filePath: string;
  readonly snapshot: TranscriptFileSnapshot;
  readonly entriesInFileOrder: readonly IndexedTranscriptEntry[];
  readonly messagesByUuid: ReadonlyMap<string, TranscriptMessage>;
  readonly orderByUuid: ReadonlyMap<string, number>;
  readonly childrenByParentUuid: ReadonlyMap<string, readonly string[]>;
  readonly leafUuids: ReadonlySet<string>;
  readonly metadata: TranscriptMetadataView;
  readonly snapshots: readonly FileHistorySnapshotEntry[];
  readonly contentReplacements: readonly ContentReplacementEntry[];
  readonly diagnostics: readonly TranscriptIndexDiagnostic[];
  readonly bytesRead: number;
}

/** Builds the immutable, file-order-preserving representation used by readers. */
export function* buildTranscriptIndexSteps(
  scan: TranscriptScanResult,
): Generator<void, TranscriptIndex> {
  const entriesInFileOrder: IndexedTranscriptEntry[] = [];
  const messagesByUuid = new Map<string, TranscriptMessage>();
  const orderByUuid = new Map<string, number>();
  const uuidOrders = new Map<string, number[]>();
  const diagnostics: TranscriptIndexDiagnostic[] = [...scan.diagnostics];
  const snapshots: FileHistorySnapshotEntry[] = [];
  const contentReplacements: ContentReplacementEntry[] = [];
  const metadata = createMutableMetadata();

  for (const scanned of scan.lines) {
    yield;
    if (scanned.decoded.kind !== 'entry') {
      diagnostics.push(toDecodeDiagnostic(scanned));
      continue;
    }
    const indexed: IndexedTranscriptEntry = {
      entry: scanned.decoded.entry,
      order: scanned.order,
      byteOffset: scanned.byteOffset,
      byteLength: scanned.byteLength,
      line: scanned.line,
    };
    entriesInFileOrder.push(indexed);
    const entry = indexed.entry;
    reduceMetadata(metadata, entry);
    if (entry.type === 'file-history-snapshot') {
      snapshots.push(entry);
    } else if (entry.type === 'content-replacement') {
      contentReplacements.push(entry);
    }
    if (!isTranscriptMessage(entry)) {
      continue;
    }
    const orders = uuidOrders.get(entry.uuid) ?? [];
    orders.push(indexed.order);
    uuidOrders.set(entry.uuid, orders);
    messagesByUuid.set(entry.uuid, entry);
    orderByUuid.set(entry.uuid, indexed.order);
  }

  for (const [uuid, orders] of uuidOrders) {
    yield;
    if (orders.length > 1) {
      diagnostics.push({
        kind: 'duplicate-uuid',
        uuid,
        winningOrder: orders.at(-1) as number,
        orders,
      });
    }
  }

  const childrenByParentUuid = new Map<string, string[]>();
  const referencedParents = new Set<string>();
  for (const message of messagesByUuid.values()) {
    yield;
    if (message.parentUuid === null) {
      continue;
    }
    if (!messagesByUuid.has(message.parentUuid)) {
      diagnostics.push({
        kind: 'broken-parent',
        uuid: message.uuid,
        parentUuid: message.parentUuid,
      });
      continue;
    }
    referencedParents.add(message.parentUuid);
    const children = childrenByParentUuid.get(message.parentUuid) ?? [];
    children.push(message.uuid);
    childrenByParentUuid.set(message.parentUuid, children);
  }
  const leafUuids = new Set(
    [...messagesByUuid.keys()].filter((uuid) => !referencedParents.has(uuid)),
  );

  return {
    filePath: scan.filePath,
    snapshot: scan.snapshot,
    entriesInFileOrder,
    messagesByUuid,
    orderByUuid,
    childrenByParentUuid,
    leafUuids,
    metadata,
    snapshots,
    contentReplacements,
    diagnostics,
    bytesRead: scan.bytesRead,
  };
}

interface MutableMetadata {
  summaries: Map<string, string>;
  customTitles: Map<string, string>;
  aiTitles: Map<string, string>;
  lastPrompts: Map<string, string>;
  tags: Map<string, string>;
  workspaceDirectories: Map<string, readonly string[]>;
  runtimeConfigs: Map<string, RuntimeConfigEntry>;
  modes: Map<string, SessionMode>;
  activeLeaves: Map<string, ActiveLeafEntry>;
  relocatedCwds: Map<string, string>;
  worktreeSessions: Map<string, TranscriptWorktreeSession | null>;
  latestActiveLeaf?: ActiveLeafEntry;
}

function createMutableMetadata(): MutableMetadata {
  return {
    summaries: new Map(),
    customTitles: new Map(),
    aiTitles: new Map(),
    lastPrompts: new Map(),
    tags: new Map(),
    workspaceDirectories: new Map(),
    runtimeConfigs: new Map(),
    modes: new Map(),
    activeLeaves: new Map(),
    relocatedCwds: new Map(),
    worktreeSessions: new Map(),
  };
}

function reduceMetadata(metadata: MutableMetadata, entry: Entry): void {
  switch (entry.type) {
    case 'summary':
      metadata.summaries.set(entry.leafUuid, entry.summary);
      break;
    case 'custom-title':
      metadata.customTitles.set(entry.sessionId, entry.customTitle);
      break;
    case 'ai-title':
      metadata.aiTitles.set(entry.sessionId, entry.aiTitle);
      break;
    case 'last-prompt':
      metadata.lastPrompts.set(entry.sessionId, entry.lastPrompt);
      break;
    case 'tag':
      metadata.tags.set(entry.sessionId, entry.tag);
      break;
    case 'workspace-directories':
      metadata.workspaceDirectories.set(entry.sessionId, [
        ...entry.directories,
      ]);
      break;
    case 'runtime-config':
      metadata.runtimeConfigs.set(entry.sessionId, entry);
      break;
    case 'mode':
      metadata.modes.set(entry.sessionId, entry.mode);
      break;
    case 'active-leaf':
      metadata.activeLeaves.set(entry.sessionId, entry);
      metadata.latestActiveLeaf = entry;
      break;
    case 'relocated':
      metadata.relocatedCwds.set(entry.sessionId, entry.relocatedCwd);
      break;
    case 'worktree-state':
      metadata.worktreeSessions.set(entry.sessionId, entry.worktreeSession);
      break;
    default:
      break;
  }
}

function toDecodeDiagnostic(
  scanned: ScannedTranscriptLine,
): TranscriptIndexDiagnostic {
  switch (scanned.decoded.kind) {
    case 'malformed':
      return {
        kind: 'malformed',
        byteOffset: scanned.byteOffset,
        byteLength: scanned.byteLength,
        line: scanned.line,
      };
    case 'unknown':
      return {
        kind: 'unknown',
        byteOffset: scanned.byteOffset,
        byteLength: scanned.byteLength,
        line: scanned.line,
        ...(scanned.decoded.type ? { type: scanned.decoded.type } : {}),
      };
    case 'invalid-shape':
      return {
        kind: 'invalid-shape',
        byteOffset: scanned.byteOffset,
        byteLength: scanned.byteLength,
        line: scanned.line,
        type: scanned.decoded.type,
      };
    case 'entry':
      throw new Error('Entry lines do not produce decode diagnostics');
    default:
      throw new Error('Unsupported transcript decode result');
  }
}

export function buildTranscriptIndex(
  scan: TranscriptScanResult,
): TranscriptIndex {
  return drainTranscriptSteps(buildTranscriptIndexSteps(scan));
}
