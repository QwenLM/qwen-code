/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { drainTranscriptSteps } from './cooperative.js';

import type {
  AssistantMessage,
  UserMessage,
} from '../../protocol/transcript/message.js';
import type { TranscriptMessage } from '../../protocol/transcript/entry.js';

export interface TranscriptGraphView {
  readonly messagesByUuid: ReadonlyMap<string, TranscriptMessage>;
  readonly orderByUuid: ReadonlyMap<string, number>;
}

export interface LeafSelectionPolicy {
  readonly includeSidechains: boolean;
  readonly includeTeamMessages: boolean;
  readonly includeMetaMessages: boolean;
  readonly preferStableAssistant: boolean;
  readonly order: 'file-order' | 'timestamp';
  /** Restrict sidechain recovery to one persistent agent identity. */
  readonly agentId?: string;
}

export const DEFAULT_RESUME_LEAF_POLICY: LeafSelectionPolicy = {
  includeSidechains: false,
  includeTeamMessages: true,
  includeMetaMessages: true,
  preferStableAssistant: true,
  order: 'timestamp',
};

/**
 * Policy for resuming one agent's sidechain. `includeSidechains` and `agentId`
 * only make sense together, and an interrupted agent's last message is often an
 * unfinished assistant turn, so the three overrides live here rather than being
 * reassembled at each call site.
 */
export function subagentResumeLeafPolicy(agentId: string): LeafSelectionPolicy {
  return {
    ...DEFAULT_RESUME_LEAF_POLICY,
    includeSidechains: true,
    preferStableAssistant: false,
    agentId,
  };
}

export type GraphDiagnostic =
  | { readonly kind: 'parent-cycle'; readonly uuid: string }
  | {
      readonly kind: 'broken-chain';
      readonly uuid: string;
      readonly parentUuid: string;
    };

export interface ResolvedTranscriptChain {
  readonly leafUuid?: string;
  readonly messages: readonly TranscriptMessage[];
  readonly diagnostics: readonly GraphDiagnostic[];
}

export class TranscriptConsistencyError extends Error {
  readonly code = 'TRANSCRIPT_ACTIVE_LEAF_INVALID';

  constructor(
    readonly leafUuid: string,
    message = `Active transcript leaf not found: ${leafUuid}`,
  ) {
    super(message);
    this.name = 'TranscriptConsistencyError';
  }
}

type ConversationTranscriptMessage = TranscriptMessage &
  (UserMessage | AssistantMessage);

interface ResumeLeafCandidate {
  /** The user or assistant message that identifies a resumable branch. */
  readonly leaf: ConversationTranscriptMessage;
}

export function computeLeafUuids(
  graph: TranscriptGraphView,
): ReadonlySet<string> {
  return new Set(
    drainTranscriptSteps(computeResumeLeafCandidatesSteps(graph)).map(
      (candidate) => candidate.leaf.uuid,
    ),
  );
}

function* computeResumeLeafCandidatesSteps(
  graph: TranscriptGraphView,
): Generator<void, readonly ResumeLeafCandidate[]> {
  const parentUuids = new Set<string>();
  const conversationParentUuids = new Set<string>();
  for (const message of graph.messagesByUuid.values()) {
    yield;
    if (message.parentUuid) {
      parentUuids.add(message.parentUuid);
      if (message.type === 'user' || message.type === 'assistant') {
        conversationParentUuids.add(message.parentUuid);
      }
    }
  }

  const candidates = new Map<string, ResumeLeafCandidate>();
  const ancestors = new Map<
    string,
    ConversationTranscriptMessage | undefined
  >();
  for (const terminal of graph.messagesByUuid.values()) {
    yield;
    if (parentUuids.has(terminal.uuid)) {
      continue;
    }
    const seen = new Set<string>();
    let current: TranscriptMessage | undefined = terminal;
    let ancestor: ConversationTranscriptMessage | undefined;
    while (current && !seen.has(current.uuid)) {
      yield;
      if (ancestors.has(current.uuid)) {
        ancestor = ancestors.get(current.uuid);
        break;
      }
      seen.add(current.uuid);
      if (current.type === 'user' || current.type === 'assistant') {
        ancestor = current;
        break;
      }
      current = current.parentUuid
        ? graph.messagesByUuid.get(current.parentUuid)
        : undefined;
    }
    for (const uuid of seen) {
      yield;
      ancestors.set(uuid, ancestor);
    }
    if (ancestor && !conversationParentUuids.has(ancestor.uuid)) {
      candidates.set(ancestor.uuid, { leaf: ancestor });
    }
  }
  return [...candidates.values()];
}

function* selectDefaultLeafSteps(
  graph: TranscriptGraphView,
  policy: LeafSelectionPolicy = DEFAULT_RESUME_LEAF_POLICY,
): Generator<void, ConversationTranscriptMessage | undefined> {
  const candidateGraph = scopeLeafCandidatesToAgent(graph, policy.agentId);
  const candidates = (yield* computeResumeLeafCandidatesSteps(candidateGraph))
    .filter(
      // An agent-scoped policy has already narrowed to that agent's sidechain,
      // so it implies includeSidechains — without this, pairing `agentId` with
      // the default `includeSidechains: false` would drop every candidate and
      // resolve to an empty chain instead of the agent's history.
      ({ leaf }) =>
        policy.agentId !== undefined ||
        policy.includeSidechains ||
        !leaf.isSidechain,
    )
    .filter(({ leaf }) => policy.includeTeamMessages || !leaf.teamName)
    .filter(({ leaf }) => policy.includeMetaMessages || !leaf.isMeta);
  const stableCandidates = policy.preferStableAssistant
    ? candidates.filter(({ leaf }) => isStableResumeLeaf(leaf))
    : candidates;
  const selectable =
    stableCandidates.length > 0 ? stableCandidates : candidates;
  return selectable.reduce<ResumeLeafCandidate | undefined>(
    (latest, candidate) => {
      if (!latest) {
        return candidate;
      }
      return compareLeafOrder(
        candidate.leaf,
        latest.leaf,
        graph.orderByUuid,
        policy.order,
      ) >= 0
        ? candidate
        : latest;
    },
    undefined,
  )?.leaf;
}

export function resolveTranscriptChain(
  graph: TranscriptGraphView,
  leafUuid?: string | null,
  policy: LeafSelectionPolicy = DEFAULT_RESUME_LEAF_POLICY,
): ResolvedTranscriptChain {
  return drainTranscriptSteps(
    resolveTranscriptChainWithParentModeSteps(
      graph,
      leafUuid,
      policy,
      'runtime',
    ),
  );
}

/**
 * Resolves the complete historical chain for the active branch.
 *
 * Runtime traversal restarts at a Compact Boundary. Historical traversal
 * follows its `logicalParentUuid` to the pre-compact ancestor. Both views
 * otherwise share leaf selection and compatibility repair behavior.
 */
export function resolveHistoricalTranscriptChain(
  graph: TranscriptGraphView,
  leafUuid?: string | null,
  policy: LeafSelectionPolicy = DEFAULT_RESUME_LEAF_POLICY,
): ResolvedTranscriptChain {
  return drainTranscriptSteps(
    resolveTranscriptChainWithParentModeSteps(
      graph,
      leafUuid,
      policy,
      'historical',
    ),
  );
}

function* resolveTranscriptChainWithParentModeSteps(
  graph: TranscriptGraphView,
  leafUuid: string | null | undefined,
  policy: LeafSelectionPolicy,
  mode: 'runtime' | 'historical',
): Generator<void, ResolvedTranscriptChain> {
  if (leafUuid === null) {
    return { messages: [], diagnostics: [] };
  }
  const requestedLeaf =
    leafUuid === undefined
      ? yield* selectDefaultLeafSteps(graph, policy)
      : graph.messagesByUuid.get(leafUuid);
  if (leafUuid !== undefined && !requestedLeaf) {
    throw new TranscriptConsistencyError(leafUuid);
  }
  if (requestedLeaf && !isMessageInAgentScope(requestedLeaf, policy.agentId)) {
    throw new TranscriptConsistencyError(
      requestedLeaf.uuid,
      `Active transcript leaf ${requestedLeaf.uuid} does not belong to agent ${policy.agentId}.`,
    );
  }
  const normalizedLeaf = requestedLeaf
    ? yield* normalizeConversationLeafSteps(graph, requestedLeaf)
    : undefined;
  const leaf =
    normalizedLeaf && isMessageInAgentScope(normalizedLeaf, policy.agentId)
      ? normalizedLeaf
      : yield* selectDefaultLeafSteps(graph, policy);
  if (!leaf) {
    return { messages: [], diagnostics: [] };
  }

  const reversed: TranscriptMessage[] = [];
  const seen = new Set<string>();
  const diagnostics: GraphDiagnostic[] = [];
  let current: TranscriptMessage | undefined = leaf;
  while (current) {
    yield;
    if (seen.has(current.uuid)) {
      diagnostics.push({ kind: 'parent-cycle', uuid: current.uuid });
      break;
    }
    seen.add(current.uuid);
    reversed.push(current);
    const parentUuid = getTraversalParentUuid(current, mode);
    if (!parentUuid) {
      break;
    }
    const parent = graph.messagesByUuid.get(parentUuid);
    if (!parent || seen.has(parent.uuid)) {
      const fallback: TranscriptMessage | undefined =
        yield* findTimestampFallbackSteps(graph, current, seen);
      if (fallback) {
        current = fallback;
        continue;
      }
      diagnostics.push(
        parent
          ? { kind: 'parent-cycle', uuid: parent.uuid }
          : {
              kind: 'broken-chain',
              uuid: current.uuid,
              parentUuid,
            },
      );
      break;
    }
    current = parent;
  }
  reversed.reverse();
  const grouped = yield* recoverGroupedAssistantMessagesSteps(
    graph,
    reversed,
    seen,
  );
  const recovered = yield* recoverNonConversationalDescendantsSteps(
    graph,
    leaf,
    grouped,
  );
  return {
    leafUuid: leaf.uuid,
    messages:
      policy.agentId === undefined
        ? recovered
        : recovered.filter((message) =>
            isMessageInAgentScope(message, policy.agentId),
          ),
    diagnostics,
  };
}

function getTraversalParentUuid(
  message: TranscriptMessage,
  mode: 'runtime' | 'historical',
): string | null | undefined {
  if (
    mode === 'historical' &&
    message.type === 'system' &&
    message.subtype === 'compact_boundary'
  ) {
    return message.logicalParentUuid ?? message.parentUuid;
  }
  return message.parentUuid;
}

function scopeLeafCandidatesToAgent(
  graph: TranscriptGraphView,
  agentId: string | undefined,
): TranscriptGraphView {
  if (agentId === undefined) {
    return graph;
  }
  return {
    messagesByUuid: new Map(
      [...graph.messagesByUuid].filter(([, message]) =>
        isMessageInAgentScope(message, agentId),
      ),
    ),
    // Order is only ever looked up by uuid, so the unscoped map is safe to
    // share — extra entries for filtered-out messages are never consulted.
    orderByUuid: graph.orderByUuid,
  };
}

export function isMessageInAgentScope(
  message: TranscriptMessage,
  agentId: string | undefined,
): boolean {
  return (
    agentId === undefined ||
    (message.agentId === agentId && message.isSidechain === true)
  );
}

const MAX_TIMESTAMP_FALLBACK_MS = 5_000;

function* normalizeConversationLeafSteps(
  graph: TranscriptGraphView,
  start: TranscriptMessage,
): Generator<void, ConversationTranscriptMessage | undefined> {
  const seen = new Set<string>();
  let current: TranscriptMessage | undefined = start;
  while (current && !seen.has(current.uuid)) {
    yield;
    seen.add(current.uuid);
    if (current.type === 'user' || current.type === 'assistant') {
      return current;
    }
    current = current.parentUuid
      ? graph.messagesByUuid.get(current.parentUuid)
      : undefined;
  }
  return undefined;
}

function* findTimestampFallbackSteps(
  graph: TranscriptGraphView,
  current: TranscriptMessage,
  seen: ReadonlySet<string>,
): Generator<void, TranscriptMessage | undefined> {
  const currentTimestamp = Date.parse(current.timestamp);
  if (Number.isNaN(currentTimestamp)) {
    return undefined;
  }

  let closest: TranscriptMessage | undefined;
  let closestDelta = Number.POSITIVE_INFINITY;
  for (const candidate of graph.messagesByUuid.values()) {
    yield;
    if (seen.has(candidate.uuid)) {
      continue;
    }
    if (candidate.isSidechain !== current.isSidechain) {
      continue;
    }
    const candidateTimestamp = Date.parse(candidate.timestamp);
    if (Number.isNaN(candidateTimestamp)) {
      continue;
    }
    const delta = currentTimestamp - candidateTimestamp;
    if (
      delta >= 0 &&
      delta <= MAX_TIMESTAMP_FALLBACK_MS &&
      delta < closestDelta
    ) {
      closest = candidate;
      closestDelta = delta;
    }
  }
  return closest;
}

function* recoverNonConversationalDescendantsSteps(
  graph: TranscriptGraphView,
  leaf: TranscriptMessage,
  chain: readonly TranscriptMessage[],
): Generator<void, readonly TranscriptMessage[]> {
  const seen = new Set(chain.map((message) => message.uuid));
  const childrenByParentUuid = new Map<string, TranscriptMessage[]>();
  for (const message of graph.messagesByUuid.values()) {
    yield;
    if (
      !message.parentUuid ||
      message.type === 'user' ||
      message.type === 'assistant'
    ) {
      continue;
    }
    const children = childrenByParentUuid.get(message.parentUuid) ?? [];
    children.push(message);
    childrenByParentUuid.set(message.parentUuid, children);
  }

  const recovered: TranscriptMessage[] = [];
  const pending = [leaf.uuid];
  for (let cursor = 0; cursor < pending.length; cursor++) {
    yield;
    const parentUuid = pending[cursor];
    for (const child of childrenByParentUuid.get(parentUuid) ?? []) {
      yield;
      if (seen.has(child.uuid)) {
        continue;
      }
      seen.add(child.uuid);
      recovered.push(child);
      pending.push(child.uuid);
    }
  }
  recovered.sort((left, right) =>
    compareByTimestampThenFileOrder(left, right, graph.orderByUuid),
  );
  return [...chain, ...recovered];
}

function* recoverGroupedAssistantMessagesSteps(
  graph: TranscriptGraphView,
  chain: readonly TranscriptMessage[],
  initiallySeen: ReadonlySet<string> = new Set(
    chain.map((message) => message.uuid),
  ),
): Generator<void, readonly TranscriptMessage[]> {
  const chainAssistants = chain.filter(
    (message): message is TranscriptMessage & AssistantMessage =>
      message.type === 'assistant',
  );
  if (chainAssistants.length === 0) {
    return chain;
  }
  const seen = new Set(initiallySeen);
  const anchorByMessageId = new Map<
    string,
    TranscriptMessage & AssistantMessage
  >();
  for (const assistant of chainAssistants) {
    yield;
    if (assistant.message.id) {
      anchorByMessageId.set(assistant.message.id, assistant);
    }
  }

  const siblingsByMessageId = new Map<string, TranscriptMessage[]>();
  const toolResultsByAssistantUuid = new Map<string, TranscriptMessage[]>();
  for (const message of graph.messagesByUuid.values()) {
    yield;
    if (message.type === 'assistant' && message.message.id) {
      const siblings = siblingsByMessageId.get(message.message.id) ?? [];
      siblings.push(message);
      siblingsByMessageId.set(message.message.id, siblings);
    } else if (isToolResultMessage(message) && message.parentUuid) {
      const results = toolResultsByAssistantUuid.get(message.parentUuid) ?? [];
      results.push(message);
      toolResultsByAssistantUuid.set(message.parentUuid, results);
    }
  }

  const processedGroups = new Set<string>();
  const inserts = new Map<string, TranscriptMessage[]>();
  for (const assistant of chainAssistants) {
    yield;
    const messageId = assistant.message.id;
    if (!messageId || processedGroups.has(messageId)) {
      continue;
    }
    processedGroups.add(messageId);
    const group = siblingsByMessageId.get(messageId) ?? [assistant];
    const orphanedSiblings = group.filter((sibling) => !seen.has(sibling.uuid));
    const orphanedToolResults = group.flatMap(
      (member) =>
        toolResultsByAssistantUuid
          .get(member.uuid)
          ?.filter((result) => !seen.has(result.uuid)) ?? [],
    );
    if (orphanedSiblings.length === 0 && orphanedToolResults.length === 0) {
      continue;
    }
    const anchor = anchorByMessageId.get(messageId);
    if (!anchor) {
      continue;
    }
    const groupOrdered = [...group].sort((left, right) =>
      compareByTimestampThenFileOrder(left, right, graph.orderByUuid),
    );
    orphanedToolResults.sort((left, right) =>
      compareByTimestampThenFileOrder(left, right, graph.orderByUuid),
    );
    const anchorIndex = groupOrdered.findIndex(
      (message) => message.uuid === anchor.uuid,
    );
    const recovered = [
      ...groupOrdered
        .slice(0, Math.max(anchorIndex, 0))
        .filter((message) => !seen.has(message.uuid)),
      ...groupOrdered
        .slice(anchorIndex + 1)
        .filter((message) => !seen.has(message.uuid)),
      ...orphanedToolResults,
    ];
    for (const message of recovered) {
      yield;
      seen.add(message.uuid);
    }
    inserts.set(anchor.uuid, recovered);
  }

  if (inserts.size === 0) {
    return chain;
  }
  return chain.flatMap((message) => {
    const recovered = inserts.get(message.uuid);
    if (!recovered) {
      return [message];
    }
    const anchorOrder =
      graph.orderByUuid.get(message.uuid) ?? Number.MAX_SAFE_INTEGER;
    const before: TranscriptMessage[] = [];
    const after: TranscriptMessage[] = [];
    for (const candidate of recovered) {
      const candidateOrder =
        graph.orderByUuid.get(candidate.uuid) ?? Number.MAX_SAFE_INTEGER;
      const isBefore =
        message.type === 'assistant' &&
        candidate.type === 'assistant' &&
        candidate.message.id === message.message.id &&
        candidateOrder < anchorOrder;
      (isBefore ? before : after).push(candidate);
    }
    return [...before, message, ...after];
  });
}

/**
 * True when a user message carries at least one `tool_result` block. Distinct
 * from `isToolResultUserMessage` in protocol/message-utils, which requires
 * *every* block to be a tool_result.
 */
export function isToolResultMessage(
  message: TranscriptMessage,
): message is TranscriptMessage & UserMessage {
  return (
    message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content.some((block) => block.type === 'tool_result')
  );
}

function isStableResumeLeaf(message: TranscriptMessage): boolean {
  return (
    message.type !== 'assistant' ||
    message.message.stop_reason != null ||
    message.isApiErrorMessage === true
  );
}

function compareLeafOrder(
  left: TranscriptMessage,
  right: TranscriptMessage,
  orderByUuid: ReadonlyMap<string, number>,
  order: LeafSelectionPolicy['order'],
): number {
  if (order === 'timestamp') {
    const timestamp = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (!Number.isNaN(timestamp) && timestamp !== 0) {
      return timestamp;
    }
  }
  return (
    (orderByUuid.get(left.uuid) ?? Number.MIN_SAFE_INTEGER) -
    (orderByUuid.get(right.uuid) ?? Number.MIN_SAFE_INTEGER)
  );
}

function compareByTimestampThenFileOrder(
  left: TranscriptMessage,
  right: TranscriptMessage,
  orderByUuid: ReadonlyMap<string, number>,
): number {
  const timestamp = left.timestamp.localeCompare(right.timestamp);
  if (timestamp !== 0) {
    return timestamp;
  }
  return (
    (orderByUuid.get(left.uuid) ?? Number.MAX_SAFE_INTEGER) -
    (orderByUuid.get(right.uuid) ?? Number.MAX_SAFE_INTEGER)
  );
}

export function selectDefaultLeaf(
  graph: TranscriptGraphView,
  policy: LeafSelectionPolicy = DEFAULT_RESUME_LEAF_POLICY,
): ConversationTranscriptMessage | undefined {
  return drainTranscriptSteps(selectDefaultLeafSteps(graph, policy));
}

export function recoverGroupedAssistantMessages(
  graph: TranscriptGraphView,
  chain: readonly TranscriptMessage[],
  initiallySeen?: ReadonlySet<string>,
): readonly TranscriptMessage[] {
  return drainTranscriptSteps(
    recoverGroupedAssistantMessagesSteps(graph, chain, initiallySeen),
  );
}

/** Same traversal as historical readers, yielded in bounded resume batches. */
export function resolveTranscriptChainSteps(
  graph: TranscriptGraphView,
  leafUuid?: string | null,
  policy: LeafSelectionPolicy = DEFAULT_RESUME_LEAF_POLICY,
  mode: 'runtime' | 'historical' = 'runtime',
): Generator<void, ResolvedTranscriptChain> {
  return resolveTranscriptChainWithParentModeSteps(
    graph,
    leafUuid,
    policy,
    mode,
  );
}
