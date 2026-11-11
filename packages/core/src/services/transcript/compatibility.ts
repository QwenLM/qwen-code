/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { drainTranscriptSteps } from './cooperative.js';
import type {
  AssistantMessage,
  CompactMetadata,
  UserMessage,
} from '../../protocol/transcript/message.js';
import type {
  Entry,
  TranscriptMessage,
} from '../../protocol/transcript/entry.js';
import { isTranscriptMessage } from '../../protocol/transcript/entry.js';
import { isTaskLifecycleSubtype } from '../../protocol/transcript/message-utils.js';
import type { TranscriptIndex } from './index.js';
import { isToolResultMessage } from './graph-resolver.js';
import { COMPACT_TAIL_THRESHOLD_BYTES } from './scanner.js';

export interface CompatibilityDiagnostic {
  readonly kind:
    | 'legacy-provider-parent-repaired'
    | 'queued-command-parent-repaired'
    | 'preserved-segment-relinked'
    | 'preserved-segment-broken'
    | 'pre-compact-message-pruned';
  readonly count: number;
}

export interface CompatibleTranscriptView {
  readonly messagesByUuid: ReadonlyMap<string, TranscriptMessage>;
  readonly orderByUuid: ReadonlyMap<string, number>;
  readonly diagnostics: readonly CompatibilityDiagnostic[];
  readonly hasCompactBoundary: boolean;
}

export interface TranscriptCompatibilityOptions {
  /** Keeps active-lineage nodes that precede a Compact Boundary. */
  readonly retainPreCompactHistory?: boolean;
}

/** Applies named, read-only migrations for historical transcript shapes. */
export function* applyTranscriptCompatibilitySteps(
  index: TranscriptIndex,
  options: TranscriptCompatibilityOptions = {},
): Generator<void, CompatibleTranscriptView> {
  const diagnostics: CompatibilityDiagnostic[] = [];
  const messages = yield* collectResumeMessagesSteps(
    index,
    diagnostics,
    options.retainPreCompactHistory === true,
  );
  const providerParentRepairs =
    yield* normalizeLegacyProviderParentsSteps(messages);
  if (providerParentRepairs > 0) {
    diagnostics.push({
      kind: 'legacy-provider-parent-repaired',
      count: providerParentRepairs,
    });
  }
  const queuedCommandRepairs = yield* repairQueuedCommandParentsSteps(messages);
  if (queuedCommandRepairs > 0) {
    diagnostics.push({
      kind: 'queued-command-parent-repaired',
      count: queuedCommandRepairs,
    });
  }
  if (!options.retainPreCompactHistory) {
    const preservedResult = yield* applyPreservedSegmentRelinksSteps(messages);
    if (preservedResult.kind) {
      diagnostics.push({
        kind: preservedResult.kind,
        count: preservedResult.count,
      });
    }
  }
  return {
    messagesByUuid: messages,
    orderByUuid: new Map(
      [...messages.keys()].map((uuid) => [
        uuid,
        index.orderByUuid.get(uuid) ?? Number.MAX_SAFE_INTEGER,
      ]),
    ),
    diagnostics,
    hasCompactBoundary: [...messages.values()].some(isCompactBoundary),
  };
}

function* collectResumeMessagesSteps(
  index: TranscriptIndex,
  diagnostics: CompatibilityDiagnostic[],
  retainPreCompactHistory: boolean,
): Generator<void, Map<string, TranscriptMessage>> {
  const messages = new Map<string, TranscriptMessage>();
  const prunePreCompact =
    !retainPreCompactHistory &&
    index.snapshot.size > COMPACT_TAIL_THRESHOLD_BYTES;
  const compactCommits = yield* collectCompactCommitsSteps(index);
  let pruned = 0;
  for (const indexed of index.entriesInFileOrder) {
    yield;
    const entry = indexed.entry;
    if (!isTranscriptMessage(entry) || shouldSkipPersistedMessage(entry)) {
      continue;
    }
    if (
      prunePreCompact &&
      isCompactBoundary(entry) &&
      !entry.compactMetadata?.preservedSegment &&
      isCommittedCompactBoundary(entry, indexed.order, compactCommits)
    ) {
      pruned += messages.size;
      messages.clear();
    }
    messages.set(entry.uuid, entry);
  }
  if (pruned > 0) {
    diagnostics.push({ kind: 'pre-compact-message-pruned', count: pruned });
  }
  return messages;
}

export interface CompactCommit {
  readonly order: number;
  readonly sessionId: string;
}

/** 结构扫描与完整兼容读取共用隐式提交语义，按边界 UUID 独立追踪。 */
export function recordCompactCommit(
  entry: Entry,
  order: number,
  commits: Map<string, CompactCommit>,
): void {
  if (
    entry.type === 'active-leaf' &&
    !entry.explicit &&
    entry.compactBoundaryUuid
  ) {
    commits.set(entry.compactBoundaryUuid, {
      order,
      sessionId: entry.sessionId,
    });
  }
}

function* collectCompactCommitsSteps(
  index: TranscriptIndex,
): Generator<void, ReadonlyMap<string, CompactCommit>> {
  const commits = new Map<string, CompactCommit>();
  for (const indexed of index.entriesInFileOrder) {
    yield;
    recordCompactCommit(indexed.entry, indexed.order, commits);
  }
  return commits;
}

export function isCommittedCompactBoundary(
  boundary: Pick<TranscriptMessage, 'type' | 'uuid' | 'sessionId'> & {
    readonly requiresActiveLeafCommit?: boolean;
  },
  boundaryOrder: number,
  commits: ReadonlyMap<string, CompactCommit>,
): boolean {
  if (
    boundary.type !== 'system' ||
    boundary.requiresActiveLeafCommit !== true
  ) {
    return true;
  }
  const commit = commits.get(boundary.uuid);
  return (
    commit !== undefined &&
    commit.order > boundaryOrder &&
    commit.sessionId === boundary.sessionId
  );
}

function shouldSkipPersistedMessage(message: TranscriptMessage): boolean {
  if (message.type !== 'system') {
    return false;
  }
  return (
    isTaskLifecycleSubtype(message.subtype) ||
    message.subtype === 'permission_mode_transient' ||
    (message.subtype === 'informational' &&
      isStalePermissionModeWarning(message.content))
  );
}

function isStalePermissionModeWarning(content: string): boolean {
  const hasSwitchHint =
    content.includes('Shift+Tab') || content.includes('Alt+Q');
  return (
    hasSwitchHint &&
    (content.includes('YOLO mode') || content.includes("Don't Ask mode"))
  );
}

function* normalizeLegacyProviderParentsSteps(
  messages: Map<string, TranscriptMessage>,
): Generator<void, number> {
  const nestedMessageIdToUuids = new Map<string, string[]>();
  for (const [uuid, message] of messages) {
    yield;
    const nestedMessageId = getNestedMessageId(message);
    if (!nestedMessageId) {
      continue;
    }
    const uuids = nestedMessageIdToUuids.get(nestedMessageId) ?? [];
    uuids.push(uuid);
    nestedMessageIdToUuids.set(nestedMessageId, uuids);
  }

  let repairs = 0;
  for (const [uuid, message] of messages) {
    yield;
    const parentUuid = yield* normalizeLegacyParentReferenceSteps(
      message,
      message.parentUuid,
      messages,
      nestedMessageIdToUuids,
    );
    const logicalParentUuid = yield* normalizeLegacyParentReferenceSteps(
      message,
      message.logicalParentUuid,
      messages,
      nestedMessageIdToUuids,
    );
    if (
      parentUuid === message.parentUuid &&
      logicalParentUuid === message.logicalParentUuid
    ) {
      continue;
    }
    const normalized: TranscriptMessage = {
      ...message,
      parentUuid: parentUuid ?? null,
    };
    if (logicalParentUuid !== undefined) {
      normalized.logicalParentUuid = logicalParentUuid;
    }
    messages.set(uuid, normalized);
    repairs++;
  }
  return repairs;
}

function* repairQueuedCommandParentsSteps(
  messages: Map<string, TranscriptMessage>,
): Generator<void, number> {
  const orderedUuids = [...messages.keys()];
  let repairs = 0;
  for (let index = 1; index < orderedUuids.length; index++) {
    yield;
    const uuid = orderedUuids[index];
    const message = uuid ? messages.get(uuid) : undefined;
    if (!message || message.parentUuid) {
      continue;
    }
    const previousUuid = orderedUuids[index - 1];
    const previous = previousUuid ? messages.get(previousUuid) : undefined;
    if (
      !previous ||
      !isQueuedCommandAttachment(previous) ||
      !previous.parentUuid
    ) {
      continue;
    }
    messages.set(message.uuid, { ...message, parentUuid: previous.parentUuid });
    repairs++;
  }
  return repairs;
}

function* applyPreservedSegmentRelinksSteps(
  messages: Map<string, TranscriptMessage>,
): Generator<
  void,
  {
    kind?: CompatibilityDiagnostic['kind'];
    count: number;
  }
> {
  let lastSegment: CompactMetadata['preservedSegment'];
  let lastSegmentBoundaryIndex = -1;
  let lastBoundaryIndex = -1;
  const entryIndex = new Map<string, number>();
  let index = 0;
  for (const message of messages.values()) {
    yield;
    entryIndex.set(message.uuid, index);
    if (isCompactBoundary(message)) {
      lastBoundaryIndex = index;
      if (message.compactMetadata?.preservedSegment) {
        lastSegment = message.compactMetadata.preservedSegment;
        lastSegmentBoundaryIndex = index;
      }
    }
    index++;
  }
  if (!lastSegment) {
    return { count: 0 };
  }

  const preservedUuids = new Set<string>();
  let relinkCount = 0;
  if (lastSegmentBoundaryIndex === lastBoundaryIndex) {
    if (lastSegment.messageUuids !== undefined) {
      const ordered = lastSegment.messageUuids;
      if (
        !Array.isArray(ordered) ||
        ordered[0] !== lastSegment.headUuid ||
        ordered.at(-1) !== lastSegment.tailUuid ||
        !messages.has(lastSegment.anchorUuid)
      )
        return { kind: 'preserved-segment-broken', count: 0 };
      // A response with parallel tools has sibling result parents. Following
      // only the final result's ancestry would silently drop the other results.
      for (const uuid of ordered) {
        yield;
        if (
          typeof uuid !== 'string' ||
          preservedUuids.has(uuid) ||
          !messages.has(uuid) ||
          uuid === lastSegment.anchorUuid
        ) {
          return {
            kind: 'preserved-segment-broken',
            count: preservedUuids.size,
          };
        }
        preservedUuids.add(uuid);
      }
      let parentUuid = lastSegment.anchorUuid;
      for (const uuid of ordered) {
        yield;
        const message = messages.get(uuid)!;
        messages.set(uuid, { ...message, parentUuid });
        parentUuid = uuid;
        relinkCount++;
      }
    } else {
      const seen = new Set<string>();
      let current = messages.get(lastSegment.tailUuid);
      let reachedHead = false;
      while (current && !seen.has(current.uuid)) {
        yield;
        seen.add(current.uuid);
        preservedUuids.add(current.uuid);
        if (current.uuid === lastSegment.headUuid) {
          reachedHead = true;
          break;
        }
        current = current.parentUuid
          ? messages.get(current.parentUuid)
          : undefined;
      }
      if (!reachedHead) {
        return { kind: 'preserved-segment-broken', count: seen.size };
      }
      const head = messages.get(lastSegment.headUuid);
      if (head) {
        messages.set(head.uuid, {
          ...head,
          parentUuid: lastSegment.anchorUuid,
        });
        relinkCount++;
      }
    }
    for (const [uuid, message] of messages) {
      yield;
      if (
        message.parentUuid === lastSegment.anchorUuid &&
        uuid !== lastSegment.headUuid
      ) {
        messages.set(uuid, { ...message, parentUuid: lastSegment.tailUuid });
        relinkCount++;
      }
    }
  }

  for (const [uuid] of messages) {
    yield;
    const messageIndex = entryIndex.get(uuid);
    if (
      messageIndex !== undefined &&
      messageIndex < lastBoundaryIndex &&
      !preservedUuids.has(uuid)
    ) {
      messages.delete(uuid);
      relinkCount++;
    }
  }
  return { kind: 'preserved-segment-relinked', count: relinkCount };
}

function* normalizeLegacyParentReferenceSteps(
  message: TranscriptMessage,
  parentUuid: string | null | undefined,
  messages: ReadonlyMap<string, TranscriptMessage>,
  nestedMessageIdToUuids: ReadonlyMap<string, readonly string[]>,
): Generator<void, string | null | undefined> {
  if (!parentUuid || messages.has(parentUuid)) {
    return parentUuid;
  }
  const candidates = nestedMessageIdToUuids.get(parentUuid);
  if (!candidates || candidates.length === 0) {
    return parentUuid;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  let parallelMatch: string | undefined;
  let parallelMatches = 0;
  let splitMatch: string | undefined;
  const toolUseIds = isToolResultMessage(message)
    ? getToolResultIds(message)
    : undefined;
  for (const uuid of candidates) {
    yield;
    const candidate = messages.get(uuid);
    if (toolUseIds && assistantContainsToolUseIds(candidate, toolUseIds)) {
      parallelMatch = uuid;
      parallelMatches++;
    }
    if (candidate && candidate.timestamp <= message.timestamp)
      splitMatch = uuid;
  }
  return (parallelMatches === 1 ? parallelMatch : splitMatch) ?? parentUuid;
}

function getNestedMessageId(message: TranscriptMessage): string | undefined {
  if (message.type !== 'assistant' && message.type !== 'user') {
    return undefined;
  }
  const nestedId = 'id' in message.message ? message.message.id : undefined;
  return typeof nestedId === 'string' && nestedId.length > 0
    ? nestedId
    : undefined;
}

function getToolResultIds(message: TranscriptMessage & UserMessage): string[] {
  if (!Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content.flatMap((block) =>
    block.type === 'tool_result' && block.tool_use_id
      ? [block.tool_use_id]
      : [],
  );
}

function assistantContainsToolUseIds(
  candidate: TranscriptMessage | undefined,
  toolUseIds: readonly string[],
): candidate is TranscriptMessage & AssistantMessage {
  if (candidate?.type !== 'assistant') {
    return false;
  }
  const candidateIds = new Set(
    candidate.message.content.flatMap((block) =>
      block.type === 'tool_use' ? [block.id] : [],
    ),
  );
  return toolUseIds.every((id) => candidateIds.has(id));
}

export function isCompactBoundary(
  message: TranscriptMessage,
): message is TranscriptMessage & {
  type: 'system';
  subtype: 'compact_boundary';
} {
  return message.type === 'system' && message.subtype === 'compact_boundary';
}

function isQueuedCommandAttachment(message: TranscriptMessage): boolean {
  return (
    message.type === 'attachment' &&
    message.attachment?.type === 'queued_command'
  );
}

export function applyTranscriptCompatibility(
  index: TranscriptIndex,
  options: TranscriptCompatibilityOptions = {},
): CompatibleTranscriptView {
  return drainTranscriptSteps(
    applyTranscriptCompatibilitySteps(index, options),
  );
}
