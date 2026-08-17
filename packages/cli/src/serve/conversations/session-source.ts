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
  readCreationMetadata(sessionId: string): Promise<LiveSessionCreationMetadata>;
}

export type ConversationSessionKind = 'live' | 'standalone';

export interface LoadableConversationSession {
  kind: ConversationSessionKind;
  persistence: 'explicit' | 'legacy';
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
  const metadata = await store.readCreationMetadata(sessionId);
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
    return { kind: 'standalone', persistence: 'explicit', metadata };
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
    const parent = await readExistingMetadata(
      result.metadata.parentSessionId,
      store,
    );
    const parentSource = parent
      ? classifyTopLevelConversationSource(parent)
      : undefined;
    if (
      parentSource?.kind !== 'standalone' ||
      parentSource.persistence !== 'legacy'
    ) {
      return undefined;
    }
  }
  return result.metadata;
}
