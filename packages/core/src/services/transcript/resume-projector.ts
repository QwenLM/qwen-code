/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { FileHistorySnapshot } from '../../file-history/file-history.js';
import type {
  ContentReplacementEntry,
  TranscriptMessage,
} from '../../protocol/transcript/entry.js';
import { transcriptToMessage } from '../../protocol/transcript/conversions.js';
import type { Message } from '../../protocol/transcript/message.js';
import {
  getAssistantTextBlocks,
  isWellFormedAttachmentPayload,
} from '../../protocol/transcript/message-utils.js';
import {
  formatApiErrorDisplayMessage,
  resolvePersistedApiErrorDisplay,
} from '../../utils/errorParsing.js';
import { runLogger } from '../../utils/runLogger.js';
import type { CompatibleTranscriptView } from './compatibility.js';
import type { ResolvedTranscriptChain } from './graph-resolver.js';
import type { TranscriptIndex } from './index.js';

export interface ProjectedTranscriptSession {
  readonly resolved: ResolvedTranscriptChain;
  readonly index: TranscriptIndex;
  readonly compatible: CompatibleTranscriptView;
  readonly chain: readonly TranscriptMessage[];
  readonly messages: readonly Message[];
  readonly leafUuid?: string;
  readonly fileHistorySnapshots: readonly FileHistorySnapshot[];
  readonly contentReplacements: ReadonlyMap<
    string,
    ReadonlyArray<ContentReplacementEntry['replacements'][number]>
  >;
}

export type TranscriptProjectionView = 'runtime' | 'historical';

/** Converts an immutable index and resolved chain into runtime resume state. */
export function projectTranscriptSession(
  index: TranscriptIndex,
  compatible: CompatibleTranscriptView,
  resolved: ResolvedTranscriptChain,
  projection: TranscriptProjectionView = 'runtime',
): ProjectedTranscriptSession {
  const chain = dropMalformedAttachments(resolved.messages);
  return {
    index,
    resolved,
    compatible,
    chain,
    messages: projectNormalizedTranscriptMessages(chain, projection),
    ...(resolved.leafUuid ? { leafUuid: resolved.leafUuid } : {}),
    fileHistorySnapshots: buildFileHistorySnapshotChain(index, chain),
    contentReplacements: projectContentReplacements(index, chain),
  };
}

/** Projects a complete lineage into runtime or visible historical messages. */
export function projectTranscriptMessages(
  chain: readonly TranscriptMessage[],
  projection: TranscriptProjectionView,
): readonly Message[] {
  return projectNormalizedTranscriptMessages(
    dropMalformedAttachments(chain),
    projection,
  );
}

function projectNormalizedTranscriptMessages(
  chain: readonly TranscriptMessage[],
  projection: TranscriptProjectionView,
): readonly Message[] {
  const selectedChain =
    projection === 'runtime' ? selectLatestRuntimeChain(chain) : chain;
  const messages = projectRuntimeMessages(selectedChain);
  const projected =
    projection === 'historical'
      ? messages.filter((message) => !isCompactInternalMessage(message))
      : messages;
  return filterUnresolvedToolUses(projected);
}

function selectLatestRuntimeChain(
  chain: readonly TranscriptMessage[],
): readonly TranscriptMessage[] {
  const boundaryIndex = chain.findLastIndex(
    (message) =>
      message.type === 'system' && message.subtype === 'compact_boundary',
  );
  return boundaryIndex >= 0 ? chain.slice(boundaryIndex) : chain;
}

function isCompactInternalMessage(message: Message): boolean {
  return (
    message.isCompactSummary === true ||
    (message.type === 'system' && message.subtype === 'compact_boundary')
  );
}

/**
 * Drops malformed attachment payloads after graph resolution so a bad node
 * cannot truncate its valid ancestors. Descendants are reparented around each
 * removed node, preserving a continuous chain for resume and fork.
 */
function dropMalformedAttachments(
  chain: readonly TranscriptMessage[],
): TranscriptMessage[] {
  const droppedParents = new Map<string, string | null>();
  const result: TranscriptMessage[] = [];

  // Values stored in droppedParents are already resolved to a retained uuid
  // (or null), so a single lookup is enough — no ancestor walk needed.
  const nearestRetainedParent = (uuid: string | null): string | null =>
    uuid !== null && droppedParents.has(uuid)
      ? (droppedParents.get(uuid) ?? null)
      : uuid;

  for (const entry of chain) {
    if (
      entry.type === 'attachment' &&
      !isWellFormedAttachmentPayload(entry.attachment)
    ) {
      droppedParents.set(entry.uuid, nearestRetainedParent(entry.parentUuid));
      continue;
    }
    if (droppedParents.size === 0) {
      result.push(entry);
      continue;
    }

    const parentUuid = nearestRetainedParent(entry.parentUuid);
    const logicalParentUuid =
      entry.logicalParentUuid === undefined
        ? undefined
        : nearestRetainedParent(entry.logicalParentUuid);
    if (
      parentUuid === entry.parentUuid &&
      logicalParentUuid === entry.logicalParentUuid
    ) {
      result.push(entry);
      continue;
    }
    result.push({
      ...entry,
      parentUuid,
      ...(logicalParentUuid !== undefined ? { logicalParentUuid } : {}),
    });
  }

  if (droppedParents.size > 0) {
    runLogger.warn(
      'transcript.resume.malformed_attachments_dropped',
      `count=${droppedParents.size}`,
    );
  }
  return result;
}

function projectRuntimeMessages(
  chain: readonly TranscriptMessage[],
): Message[] {
  const messagesByUuid = new Map(
    chain.map((message) => [message.uuid, message]),
  );
  return chain.flatMap((entry): Message[] => {
    if (entry.type === 'system' && entry.subtype === 'error') {
      const parent = entry.parentUuid
        ? messagesByUuid.get(entry.parentUuid)
        : undefined;
      if (
        parent?.type === 'assistant' &&
        parent.isApiErrorMessage &&
        !parent.modelError &&
        isMatchingLegacyApiErrorDisplay(entry.content, parent)
      ) {
        // Older local TUI transcripts persisted both the technical synthetic
        // assistant error and a derived system/error display record. Keep the
        // structured synthetic record as the single canonical resume item.
        return [];
      }
    }
    return [transcriptToMessage(entry)];
  });
}

function isMatchingLegacyApiErrorDisplay(
  systemContent: string,
  parent: Extract<TranscriptMessage, { type: 'assistant' }>,
): boolean {
  const rawError = getAssistantTextBlocks(parent).join('').trim();
  const { displayErrorCode, fallbackMessage } = resolvePersistedApiErrorDisplay(
    parent,
    rawError,
  );
  const candidates = [fallbackMessage];
  if (displayErrorCode !== undefined && fallbackMessage !== undefined) {
    candidates.push(
      formatApiErrorDisplayMessage(displayErrorCode, fallbackMessage),
    );
  }
  const normalizedContent = systemContent.trim();
  return candidates.some(
    (candidate) => candidate?.trim() === normalizedContent,
  );
}

export function filterUnresolvedToolUses(
  messages: readonly Message[],
): readonly Message[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.type === 'assistant') {
      message.message.content.forEach((block) => {
        if (block.type === 'tool_use') toolUseIds.add(block.id);
      });
    } else if (
      message.type === 'user' &&
      typeof message.message.content !== 'string'
    ) {
      for (const block of message.message.content) {
        if (block.type === 'tool_result') toolResultIds.add(block.tool_use_id);
      }
    }
  }
  const unresolvedIds = new Set(
    [...toolUseIds].filter((id) => !toolResultIds.has(id)),
  );
  if (unresolvedIds.size === 0) {
    return [...messages];
  }

  return messages.flatMap<Message>((message): Message[] => {
    if (message.type !== 'assistant') {
      return [message];
    }
    const filteredContent = message.message.content.filter(
      (block) => block.type !== 'tool_use' || !unresolvedIds.has(block.id),
    );
    if (filteredContent.length === 0) {
      return [];
    }
    if (filteredContent.length === message.message.content.length) {
      return [message];
    }
    return [
      {
        ...message,
        message: { ...message.message, content: filteredContent },
      },
    ];
  });
}

function buildFileHistorySnapshotChain(
  index: TranscriptIndex,
  chain: readonly TranscriptMessage[],
): FileHistorySnapshot[] {
  const entriesByMessageId = new Map(
    index.snapshots.map((entry) => [entry.messageId, entry]),
  );
  const snapshots: FileHistorySnapshot[] = [];
  // 有过 Worktree 的会话不能在退出或缺失回退后重新接受来源不明的历史快照。
  const discardLegacySnapshots =
    index.snapshots.length > 0 &&
    index.entriesInFileOrder.some(
      ({ entry }) =>
        entry.type === 'worktree-state' &&
        (entry.worktreeSession !== null ||
          entry.discardLegacyFileHistorySnapshots === true),
    );
  const indexByMessageId = new Map<string, number>();
  for (const message of chain) {
    const entry = entriesByMessageId.get(message.uuid);
    if (!entry) {
      continue;
    }
    const snapshot = normalizeSnapshot(entry.snapshot, entry.messageId);
    if (discardLegacySnapshots && !snapshot.cwd) {
      continue;
    }
    const existingIndex = entry.isSnapshotUpdate
      ? indexByMessageId.get(snapshot.messageId)
      : undefined;
    if (existingIndex === undefined) {
      indexByMessageId.set(snapshot.messageId, snapshots.length);
      snapshots.push(snapshot);
    } else {
      snapshots[existingIndex] = snapshot;
    }
  }
  return snapshots;
}

export function projectContentReplacements(
  index: TranscriptIndex,
  chain: readonly TranscriptMessage[],
): ReadonlyMap<
  string,
  ReadonlyArray<ContentReplacementEntry['replacements'][number]>
> {
  const liveUuids = new Set(chain.map((message) => message.uuid));
  const replacementsBySession = new Map<
    string,
    ContentReplacementEntry['replacements']
  >();
  for (const entry of index.contentReplacements) {
    const replacements = replacementsBySession.get(entry.sessionId) ?? [];
    // 替换子项可能很多，逐项追加避免参数展开先触发调用栈上限。
    for (const replacement of entry.replacements) {
      if (liveUuids.has(replacement.messageUuid)) {
        replacements.push(replacement);
      }
    }
    if (replacements.length > 0) {
      replacementsBySession.set(entry.sessionId, replacements);
    }
  }
  return replacementsBySession;
}

function normalizeSnapshot(
  snapshot: FileHistorySnapshot,
  messageId: string,
): FileHistorySnapshot {
  return {
    ...snapshot,
    messageId,
    ...(snapshot.cwd ? { cwd: path.resolve(snapshot.cwd) } : {}),
    timestamp: new Date(snapshot.timestamp),
    trackedFileBackups: Object.fromEntries(
      Object.entries(snapshot.trackedFileBackups).map(([filePath, backup]) => [
        filePath,
        { ...backup, backupTime: new Date(backup.backupTime) },
      ]),
    ),
  };
}
