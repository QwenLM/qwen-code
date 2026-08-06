/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const LIVE_SESSION_SOURCE_PREFIX = 'realtime_voice:';

export interface LiveSessionCreationMetadata {
  parentSessionId?: string;
  sourceType?: string;
  sourceId?: string;
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

function isStandaloneConversationSessionSource(source: {
  sourceType?: string;
  sourceId?: string;
}): boolean {
  return (
    source.sourceId === undefined &&
    (source.sourceType === undefined || source.sourceType === 'default')
  );
}

export async function readLoadableLiveConversationMetadata(
  sessionId: string,
  readMetadata: (sessionId: string) => Promise<LiveSessionCreationMetadata>,
): Promise<LiveSessionCreationMetadata | undefined> {
  const metadata = await readMetadata(sessionId);
  if (
    metadata.parentSessionId === undefined &&
    (isCompatibleLiveSessionSource(metadata) ||
      isStandaloneConversationSessionSource(metadata))
  ) {
    return metadata;
  }
  if (
    metadata.parentSessionId === undefined ||
    metadata.sourceType !== undefined ||
    metadata.sourceId !== undefined
  ) {
    return undefined;
  }
  const parent = await readMetadata(metadata.parentSessionId);
  return parent.parentSessionId === undefined &&
    (isCompatibleLiveSessionSource(parent) ||
      isStandaloneConversationSessionSource(parent))
    ? metadata
    : undefined;
}
