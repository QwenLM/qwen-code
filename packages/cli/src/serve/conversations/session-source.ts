/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isValidSessionId,
  normalizeSessionIdForLookup,
} from '../../config/session-id.js';

export const LIVE_SESSION_SOURCE_PREFIX = 'realtime_voice:';
export const STANDALONE_SESSION_SOURCE_TYPE = 'standalone';

export interface LiveSessionCreationMetadata {
  parentSessionId?: string;
  sourceType?: string;
  sourceId?: string;
}

export interface ConversationSessionMetadataStore {
  getSessionLocation(
    sessionId: string,
  ): Promise<'active' | 'archived' | 'conflict' | undefined>;
  readCreationMetadataIfReadable(
    sessionId: string,
    state: 'active' | 'archived',
  ): Promise<LiveSessionCreationMetadata | undefined>;
}

export type ConversationSessionKind = 'live' | 'standalone';

export interface ConversationSessionLineage {
  kind: ConversationSessionKind;
  persistence: 'explicit' | 'legacy';
}

export interface LoadableConversationSession {
  kind: ConversationSessionKind;
  persistence: 'explicit' | 'legacy';
  /**
   * Classification of the persisted parent, set only when this session has a
   * parent and that parent is still readable and classifies as top-level.
   * Undefined for a top-level session, and for an explicit standalone child
   * whose parent has been archived away or deleted: that child is
   * self-describing, so a parent it can no longer produce is not evidence
   * against it. Callers that require proven lineage must check this rather
   * than infer it from `kind`.
   */
  parentSource?: ConversationSessionLineage;
  metadata: LiveSessionCreationMetadata;
}

export function isReservedLiveSessionSource(source: {
  sourceType?: string;
  sourceId?: string;
}): boolean {
  return (
    source.sourceType === 'default' &&
    source.sourceId?.startsWith(LIVE_SESSION_SOURCE_PREFIX) === true
  );
}

export function isCompatibleLiveSessionSource(source: {
  sourceType?: string;
  sourceId?: string;
}): boolean {
  const sourceId = source.sourceId;
  return (
    isReservedLiveSessionSource(source) &&
    typeof sourceId === 'string' &&
    sourceId.length > LIVE_SESSION_SOURCE_PREFIX.length
  );
}

export function isReservedStandaloneSessionSource(source: {
  sourceType?: string;
}): boolean {
  return source.sourceType === STANDALONE_SESSION_SOURCE_TYPE;
}

function isCompatibleLegacyStandaloneSource(source: {
  sourceType?: string;
  sourceId?: string;
}): boolean {
  return (
    source.sourceId === undefined &&
    (source.sourceType === undefined || source.sourceType === 'default')
  );
}

export function classifyTopLevelConversationSource(
  metadata: LiveSessionCreationMetadata,
): LoadableConversationSession | undefined {
  if (metadata.parentSessionId !== undefined) return undefined;
  if (isCompatibleLiveSessionSource(metadata)) {
    return { kind: 'live', persistence: 'explicit', metadata };
  }
  if (
    isReservedStandaloneSessionSource(metadata) &&
    metadata.sourceId === undefined
  ) {
    return { kind: 'standalone', persistence: 'explicit', metadata };
  }
  if (isCompatibleLegacyStandaloneSource(metadata)) {
    return { kind: 'standalone', persistence: 'legacy', metadata };
  }
  return undefined;
}

async function readExistingMetadata(
  sessionId: string,
  store: ConversationSessionMetadataStore,
): Promise<LiveSessionCreationMetadata | undefined> {
  const location = await store.getSessionLocation(sessionId);
  if (location !== 'active' && location !== 'archived') return undefined;
  const metadata = await store.readCreationMetadataIfReadable(
    sessionId,
    location,
  );
  if (!metadata) return undefined;
  const confirmedLocation = await store.getSessionLocation(sessionId);
  return confirmedLocation === location ? metadata : undefined;
}

export async function readLoadableConversationSession(
  sessionId: string,
  store: ConversationSessionMetadataStore,
): Promise<LoadableConversationSession | undefined> {
  const metadata = await readExistingMetadata(sessionId, store);
  if (!metadata) return undefined;

  const topLevel = classifyTopLevelConversationSource(metadata);
  if (topLevel) return topLevel;

  const parentSessionId = metadata.parentSessionId;
  if (
    parentSessionId === undefined ||
    !isValidSessionId(parentSessionId) ||
    normalizeSessionIdForLookup(parentSessionId) ===
      normalizeSessionIdForLookup(sessionId)
  ) {
    return undefined;
  }

  if (
    isReservedStandaloneSessionSource(metadata) &&
    metadata.sourceId === undefined
  ) {
    // Self-describing: the reserved source decides the kind, so a parent that
    // is gone cannot disqualify the child. A parent that is still readable and
    // contradicts depth-1 standalone lineage can — which also rejects a
    // grandchild or a lineage cycle, because neither parent classifies as
    // top-level.
    const parent = await readExistingMetadata(parentSessionId, store);
    if (parent === undefined) {
      return { kind: 'standalone', persistence: 'explicit', metadata };
    }
    const parentSource = classifyTopLevelConversationSource(parent);
    if (parentSource?.kind !== 'standalone') return undefined;
    return {
      kind: 'standalone',
      persistence: 'explicit',
      parentSource: {
        kind: parentSource.kind,
        persistence: parentSource.persistence,
      },
      metadata,
    };
  }

  if (metadata.sourceType !== undefined || metadata.sourceId !== undefined) {
    return undefined;
  }

  const parent = await readExistingMetadata(parentSessionId, store);
  if (!parent) return undefined;
  const parentSource = classifyTopLevelConversationSource(parent);
  if (!parentSource) return undefined;
  return {
    kind: parentSource.kind,
    persistence: 'legacy',
    parentSource: {
      kind: parentSource.kind,
      persistence: parentSource.persistence,
    },
    metadata,
  };
}

export async function readLoadableLiveConversationMetadata(
  sessionId: string,
  store: ConversationSessionMetadataStore,
): Promise<LiveSessionCreationMetadata | undefined> {
  const result = await readLoadableConversationSession(sessionId, store);
  if (
    !result ||
    (result.kind === 'standalone' && result.persistence === 'explicit')
  ) {
    return undefined;
  }
  if (
    result.kind === 'standalone' &&
    result.metadata.parentSessionId !== undefined
  ) {
    // The general reader already classified the parent; re-reading the store
    // here would only duplicate that work.
    if (
      result.parentSource?.kind !== 'standalone' ||
      result.parentSource.persistence !== 'legacy'
    ) {
      return undefined;
    }
  }
  return result.metadata;
}
