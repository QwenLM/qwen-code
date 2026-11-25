/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PreviousGeneratedMemory } from '../../agents/memory-extraction-agent.js';
import type { Message } from '../../protocol/transcript/message.js';
import type { SessionStateStore } from '../session-state-store.js';

export const AUTO_MEMORY_INCREMENTAL_STATE_SEGMENT_KEY =
  'auto_memory_incremental_generation';

export interface AutoMemoryIncrementalState {
  committed_message_uuid?: string;
  previous_generated_memories: PreviousGeneratedMemory[];
}

export function emptyAutoMemoryIncrementalState(): AutoMemoryIncrementalState {
  return { previous_generated_memories: [] };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export async function loadAutoMemoryIncrementalState(
  store: SessionStateStore,
): Promise<AutoMemoryIncrementalState> {
  const value = await store.getSegment<unknown>(
    AUTO_MEMORY_INCREMENTAL_STATE_SEGMENT_KEY,
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return emptyAutoMemoryIncrementalState();
  }

  const record = value as Record<string, unknown>;
  const rawCommittedMessageUuid = record['committed_message_uuid'];
  const committedMessageUuid = isNonEmptyString(rawCommittedMessageUuid)
    ? rawCommittedMessageUuid
    : undefined;
  const previousGeneratedMemories = Array.isArray(
    record['previous_generated_memories'],
  )
    ? record['previous_generated_memories'].flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return [];
        }
        const memory = entry as Record<string, unknown>;
        const filePath = memory['filePath'];
        const content = memory['content'];
        return isString(filePath) && isString(content)
          ? [
              {
                filePath,
                content,
              },
            ]
          : [];
      })
    : [];

  return {
    ...(committedMessageUuid
      ? { committed_message_uuid: committedMessageUuid }
      : {}),
    previous_generated_memories: previousGeneratedMemories,
  };
}

export async function commitAutoMemoryIncrementalState(
  store: SessionStateStore,
  state: AutoMemoryIncrementalState,
): Promise<void> {
  await store.setSegment(
    AUTO_MEMORY_INCREMENTAL_STATE_SEGMENT_KEY,
    {
      ...(state.committed_message_uuid
        ? { committed_message_uuid: state.committed_message_uuid }
        : {}),
      previous_generated_memories: state.previous_generated_memories.map(
        ({ filePath, content }) => ({ filePath, content }),
      ),
    } satisfies AutoMemoryIncrementalState,
    { encrypted: true },
  );
}

/**
 * Resolves the incremental range on the already-restored active transcript
 * lineage. If a stored cursor is absent from that lineage (for example after a
 * rewind), the complete active lineage is used so evidence is never skipped.
 */
export function getMessagesAfterCommittedCursor(
  messages: readonly Message[],
  committedMessageUuid?: string,
): Message[] {
  if (!committedMessageUuid) return [...messages];
  const committedIndex = messages.findIndex(
    (message) => message.uuid === committedMessageUuid,
  );
  return committedIndex < 0
    ? [...messages]
    : messages.slice(committedIndex + 1);
}

export function getCapturedEndpointUuid(
  messages: readonly Message[],
): string | undefined {
  return messages.at(-1)?.uuid;
}
