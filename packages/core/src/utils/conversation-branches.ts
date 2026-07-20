/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '../services/chatRecordingService.js';

const SUMMARY_TEXT_LIMIT = 200;
const SYNTHETIC_USER_SUBTYPES = new Set([
  'notification',
  'cron',
  'mid_turn_user_message',
]);
const NEUTRAL_TAIL_SUBTYPES = new Set([
  'custom_title',
  'session_artifact_event',
  'session_artifact_snapshot',
]);

export type ConversationBranchClassification =
  | 'ordinary'
  | 'rewind-descendant'
  | 'rewind-sibling'
  | 'mixed-rewind';

export interface ConversationBranchSummary {
  leafUuid: string;
  branchPointUuid: string | null;
  classification: ConversationBranchClassification;
  containsRewindUuids: string[];
  siblingRewindUuids: string[];
  firstUserTextAfterBranchPoint?: string;
  lastUserText?: string;
  lastAssistantText?: string;
  recordCounts: {
    user: number;
    assistant: number;
    toolResult: number;
    system: number;
  };
  startedAt: string;
  updatedAt: string;
}

export type ConversationBranchDiagnostic =
  | {
      kind: 'missing-parent';
      childUuid: string;
      missingParentUuid: string;
    }
  | {
      kind: 'parent-cycle';
      uuids: string[];
    }
  | {
      kind: 'conflicting-parent';
      uuid: string;
      parentUuids: Array<string | null>;
    };

export interface ConversationBranchAnalysis {
  branches: ConversationBranchSummary[];
  diagnostics: ConversationBranchDiagnostic[];
}

interface ConversationIndex {
  firstByUuid: Map<string, ChatRecord>;
  recordsByUuid: Map<string, ChatRecord[]>;
  childrenByUuid: Map<string, string[]>;
  physicalIndexByUuid: Map<string, number>;
  diagnostics: ConversationBranchDiagnostic[];
}

interface ForestPosition {
  rootUuid: string;
  enteredAt: number;
  exitedAt: number;
}

interface SemanticLeaf {
  leafUuid: string;
  physicalLeafUuid: string;
}

export function inspectConversationBranches(
  records: readonly ChatRecord[],
): ConversationBranchAnalysis {
  if (records.length === 0) return { branches: [], diagnostics: [] };

  const index = buildConversationIndex(records);
  const semanticLeaves = findSemanticLeaves(index);
  const leafCountByAncestor = countLeafDescendants(
    semanticLeaves.map(({ leafUuid }) => leafUuid),
    index.firstByUuid,
  );
  const rewindUuids = [...index.firstByUuid.values()]
    .filter(isRewindRecord)
    .map((record) => record.uuid);
  const forestPositions = indexForest(index);

  const branches = semanticLeaves.map(({ leafUuid, physicalLeafUuid }) =>
    summarizeBranch(
      leafUuid,
      physicalLeafUuid,
      leafCountByAncestor,
      rewindUuids,
      forestPositions,
      index,
    ),
  );

  return { branches, diagnostics: index.diagnostics };
}

function indexForest(index: ConversationIndex): Map<string, ForestPosition> {
  const positions = new Map<string, ForestPosition>();
  let clock = 0;
  for (const [uuid, record] of index.firstByUuid) {
    if (
      record.parentUuid !== null &&
      index.firstByUuid.has(record.parentUuid)
    ) {
      continue;
    }
    const stack: Array<{ uuid: string; exiting: boolean }> = [
      { uuid, exiting: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.exiting) {
        const position = positions.get(frame.uuid);
        if (position) position.exitedAt = clock++;
        continue;
      }
      if (positions.has(frame.uuid)) continue;
      positions.set(frame.uuid, {
        rootUuid: uuid,
        enteredAt: clock++,
        exitedAt: -1,
      });
      stack.push({ uuid: frame.uuid, exiting: true });
      const children = index.childrenByUuid.get(frame.uuid) ?? [];
      for (
        let childIndex = children.length - 1;
        childIndex >= 0;
        childIndex--
      ) {
        stack.push({ uuid: children[childIndex]!, exiting: false });
      }
    }
  }
  return positions;
}

function buildConversationIndex(
  records: readonly ChatRecord[],
): ConversationIndex {
  const firstByUuid = new Map<string, ChatRecord>();
  const recordsByUuid = new Map<string, ChatRecord[]>();
  const physicalIndexByUuid = new Map<string, number>();

  for (const [physicalIndex, record] of records.entries()) {
    const grouped = recordsByUuid.get(record.uuid);
    if (grouped) {
      grouped.push(record);
    } else {
      firstByUuid.set(record.uuid, record);
      recordsByUuid.set(record.uuid, [record]);
      physicalIndexByUuid.set(record.uuid, physicalIndex);
    }
  }

  const diagnostics: ConversationBranchDiagnostic[] = [];
  const childrenByUuid = new Map<string, string[]>();

  for (const [uuid, grouped] of recordsByUuid) {
    const parentUuids = [
      ...new Set(grouped.map((record) => record.parentUuid)),
    ];
    if (parentUuids.length > 1) {
      diagnostics.push({ kind: 'conflicting-parent', uuid, parentUuids });
    }

    const parentUuid = firstByUuid.get(uuid)?.parentUuid;
    if (parentUuid === undefined || parentUuid === null) continue;
    if (!firstByUuid.has(parentUuid)) {
      diagnostics.push({
        kind: 'missing-parent',
        childUuid: uuid,
        missingParentUuid: parentUuid,
      });
      continue;
    }
    const children = childrenByUuid.get(parentUuid);
    if (children) {
      children.push(uuid);
    } else {
      childrenByUuid.set(parentUuid, [uuid]);
    }
  }

  diagnostics.push(...findParentCycles(firstByUuid));
  return {
    firstByUuid,
    recordsByUuid,
    childrenByUuid,
    physicalIndexByUuid,
    diagnostics,
  };
}

function findParentCycles(
  firstByUuid: ReadonlyMap<string, ChatRecord>,
): ConversationBranchDiagnostic[] {
  const complete = new Set<string>();
  const diagnostics: ConversationBranchDiagnostic[] = [];

  for (const startUuid of firstByUuid.keys()) {
    if (complete.has(startUuid)) continue;
    const path: string[] = [];
    const positionByUuid = new Map<string, number>();
    let currentUuid: string | null = startUuid;

    while (currentUuid !== null && firstByUuid.has(currentUuid)) {
      if (complete.has(currentUuid)) break;
      const existingPosition = positionByUuid.get(currentUuid);
      if (existingPosition !== undefined) {
        diagnostics.push({
          kind: 'parent-cycle',
          uuids: path.slice(existingPosition),
        });
        break;
      }
      positionByUuid.set(currentUuid, path.length);
      path.push(currentUuid);
      currentUuid = firstByUuid.get(currentUuid)?.parentUuid ?? null;
    }

    for (const uuid of path) complete.add(uuid);
  }

  return diagnostics;
}

function findSemanticLeaves(index: ConversationIndex): SemanticLeaf[] {
  const candidates = new Set<string>();
  const physicalLeafBySemanticLeaf = new Map<string, string>();
  for (const uuid of index.firstByUuid.keys()) {
    if ((index.childrenByUuid.get(uuid)?.length ?? 0) > 0) continue;
    const leafUuid = collapseNeutralTail(uuid, index.firstByUuid);
    if (leafUuid === null) continue;
    candidates.add(leafUuid);
    physicalLeafBySemanticLeaf.set(leafUuid, uuid);
  }

  const superseded = new Set<string>();
  for (const candidate of candidates) {
    const visited = new Set<string>();
    let currentUuid = index.firstByUuid.get(candidate)?.parentUuid ?? null;
    while (
      currentUuid !== null &&
      index.firstByUuid.has(currentUuid) &&
      !visited.has(currentUuid)
    ) {
      if (candidates.has(currentUuid)) superseded.add(currentUuid);
      visited.add(currentUuid);
      currentUuid = index.firstByUuid.get(currentUuid)?.parentUuid ?? null;
    }
  }

  const leaves = [...candidates].filter(
    (candidate) => !superseded.has(candidate),
  );

  return leaves
    .sort((left, right) => {
      const leftPhysicalLeaf = physicalLeafBySemanticLeaf.get(left)!;
      const rightPhysicalLeaf = physicalLeafBySemanticLeaf.get(right)!;
      return (
        index.physicalIndexByUuid.get(leftPhysicalLeaf)! -
        index.physicalIndexByUuid.get(rightPhysicalLeaf)!
      );
    })
    .map((leafUuid) => ({
      leafUuid,
      physicalLeafUuid: physicalLeafBySemanticLeaf.get(leafUuid)!,
    }));
}

function countLeafDescendants(
  semanticLeaves: readonly string[],
  firstByUuid: ReadonlyMap<string, ChatRecord>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const leafUuid of semanticLeaves) {
    for (const uuid of buildChain(leafUuid, firstByUuid)) {
      counts.set(uuid, (counts.get(uuid) ?? 0) + 1);
    }
  }
  return counts;
}

function collapseNeutralTail(
  leafUuid: string,
  firstByUuid: ReadonlyMap<string, ChatRecord>,
): string | null {
  const visited = new Set<string>();
  let currentUuid = leafUuid;

  while (!visited.has(currentUuid)) {
    visited.add(currentUuid);
    const record = firstByUuid.get(currentUuid);
    if (!record) return null;
    if (!isNeutralTailRecord(record)) return currentUuid;
    const parentUuid = record.parentUuid;
    if (parentUuid === null || !firstByUuid.has(parentUuid)) return null;
    currentUuid = parentUuid;
  }

  return null;
}

function summarizeBranch(
  leafUuid: string,
  physicalLeafUuid: string,
  leafCountByAncestor: ReadonlyMap<string, number>,
  rewindUuids: readonly string[],
  forestPositions: ReadonlyMap<string, ForestPosition>,
  index: ConversationIndex,
): ConversationBranchSummary {
  const chain = buildChain(leafUuid, index.firstByUuid);
  const chainSet = new Set(chain);
  const branchPointUuid = findBranchPoint(chain, leafCountByAncestor);
  const containsRewindUuids = chain.filter((uuid) =>
    isRewindRecord(index.firstByUuid.get(uuid)),
  );
  const siblingRewindUuids = rewindUuids.filter(
    (rewindUuid) =>
      !chainSet.has(rewindUuid) &&
      isSiblingPath(
        leafUuid,
        chain,
        rewindUuid,
        forestPositions,
        index.firstByUuid,
      ),
  );

  const firstRecord = index.firstByUuid.get(chain[0])!;
  const physicalLeafRecord = index.firstByUuid.get(physicalLeafUuid)!;
  const recordCounts = { user: 0, assistant: 0, toolResult: 0, system: 0 };
  for (const uuid of chain) {
    const record = index.firstByUuid.get(uuid)!;
    if (record.type === 'tool_result') {
      recordCounts.toolResult++;
    } else {
      recordCounts[record.type]++;
    }
  }

  const firstDistinctIndex = branchPointUuid
    ? chain.indexOf(branchPointUuid) + 1
    : 0;
  const firstUserTextAfterBranchPoint = findUserText(
    chain.slice(firstDistinctIndex),
    index,
  );
  const lastUserText = findUserText([...chain].reverse(), index);
  const lastAssistantText = findAssistantText([...chain].reverse(), index);

  return {
    leafUuid,
    branchPointUuid,
    classification: classifyBranch(
      containsRewindUuids.length > 0,
      siblingRewindUuids.length > 0,
    ),
    containsRewindUuids,
    siblingRewindUuids,
    ...(firstUserTextAfterBranchPoint ? { firstUserTextAfterBranchPoint } : {}),
    ...(lastUserText ? { lastUserText } : {}),
    ...(lastAssistantText ? { lastAssistantText } : {}),
    recordCounts,
    startedAt: firstRecord.timestamp,
    updatedAt: physicalLeafRecord.timestamp,
  };
}

function findBranchPoint(
  chain: readonly string[],
  leafCountByAncestor: ReadonlyMap<string, number>,
): string | null {
  for (let index = chain.length - 2; index >= 0; index--) {
    const candidate = chain[index];
    if (candidate && (leafCountByAncestor.get(candidate) ?? 0) > 1) {
      return candidate;
    }
  }
  return null;
}

function findUserText(
  uuids: readonly string[],
  index: ConversationIndex,
): string | undefined {
  for (const uuid of uuids) {
    const record = index.firstByUuid.get(uuid);
    if (!record || record.type !== 'user' || isSyntheticUserRecord(record)) {
      continue;
    }
    const text = extractText(index.recordsByUuid.get(uuid) ?? [], 'user');
    if (text) return text;
  }
  return undefined;
}

function findAssistantText(
  uuids: readonly string[],
  index: ConversationIndex,
): string | undefined {
  for (const uuid of uuids) {
    if (index.firstByUuid.get(uuid)?.type !== 'assistant') continue;
    const text = extractText(index.recordsByUuid.get(uuid) ?? [], 'assistant');
    if (text) return text;
  }
  return undefined;
}

function extractText(
  records: readonly ChatRecord[],
  type: 'user' | 'assistant',
): string | undefined {
  const text = records
    .filter(
      (record) =>
        record.type === type &&
        (type !== 'user' || !isSyntheticUserRecord(record)),
    )
    .flatMap((record) => record.message?.parts ?? [])
    .map((part) => {
      const textPart = part as { text?: unknown; thought?: unknown };
      return typeof textPart.text === 'string' && textPart.thought !== true
        ? textPart.text
        : '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > SUMMARY_TEXT_LIMIT
    ? `${text.slice(0, SUMMARY_TEXT_LIMIT)}...`
    : text;
}

function buildChain(
  leafUuid: string,
  firstByUuid: ReadonlyMap<string, ChatRecord>,
): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let currentUuid: string | null = leafUuid;
  while (
    currentUuid !== null &&
    firstByUuid.has(currentUuid) &&
    !visited.has(currentUuid)
  ) {
    visited.add(currentUuid);
    chain.push(currentUuid);
    currentUuid = firstByUuid.get(currentUuid)?.parentUuid ?? null;
  }
  chain.reverse();
  return chain;
}

function isSiblingPath(
  leafUuid: string,
  leafChain: readonly string[],
  rewindUuid: string,
  forestPositions: ReadonlyMap<string, ForestPosition>,
  firstByUuid: ReadonlyMap<string, ChatRecord>,
): boolean {
  const leafPosition = forestPositions.get(leafUuid);
  const rewindPosition = forestPositions.get(rewindUuid);
  if (leafPosition && rewindPosition) {
    return (
      leafPosition.rootUuid === rewindPosition.rootUuid &&
      !isAncestorPosition(leafPosition, rewindPosition)
    );
  }
  return pathsDiverge(leafChain, buildChain(rewindUuid, firstByUuid));
}

function isAncestorPosition(
  ancestor: ForestPosition,
  descendant: ForestPosition,
): boolean {
  return (
    ancestor.enteredAt <= descendant.enteredAt &&
    ancestor.exitedAt >= descendant.exitedAt
  );
}

function pathsDiverge(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const rightPositions = new Map(right.map((uuid, index) => [uuid, index]));
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex--) {
    const uuid = left[leftIndex];
    if (!uuid) continue;
    const rightIndex = rightPositions.get(uuid);
    if (rightIndex === undefined) continue;
    return leftIndex < left.length - 1 && rightIndex < right.length - 1;
  }
  return false;
}

function isNeutralTailRecord(record: ChatRecord): boolean {
  return (
    record.type === 'system' &&
    record.subtype !== undefined &&
    NEUTRAL_TAIL_SUBTYPES.has(record.subtype)
  );
}

function isSyntheticUserRecord(record: ChatRecord): boolean {
  return (
    record.externalInputKind === 'notification' ||
    (record.subtype !== undefined &&
      SYNTHETIC_USER_SUBTYPES.has(record.subtype))
  );
}

function isRewindRecord(record: ChatRecord | undefined): boolean {
  return record?.type === 'system' && record.subtype === 'rewind';
}

function classifyBranch(
  containsRewind: boolean,
  hasSiblingRewind: boolean,
): ConversationBranchClassification {
  if (containsRewind && hasSiblingRewind) return 'mixed-rewind';
  if (containsRewind) return 'rewind-descendant';
  if (hasSiblingRewind) return 'rewind-sibling';
  return 'ordinary';
}
