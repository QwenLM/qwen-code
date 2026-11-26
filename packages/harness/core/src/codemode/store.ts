/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger } from '../utils/runLogger.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import type { ActiveConversation } from '../config/config.js';
import type { TranscriptMessage } from '../protocol/transcript/entry.js';
import { selectToolResultSideChannel } from '../protocol/transcript/tool-result-side-channel.js';
import {
  CODE_MODE_RESULT_TYPE,
  STORE_LIMITS,
  type JsonObject,
  type JsonValue,
  type StoreWrite,
} from './types.js';

/** Session-local JSON state. Each successful script commits only its changed keys. */
export class CodeModeStore {
  private entries = new Map<string, string>();

  snapshot(): JsonObject {
    return Object.fromEntries(
      [...this.entries].map(([key, value]) => [
        key,
        JSON.parse(value) as JsonValue,
      ]),
    );
  }

  commit(writes: readonly StoreWrite[]): void {
    if (!writes.length) return;
    const next = new Map(this.entries);
    for (const { key, value } of writes) {
      if (typeof key !== 'string' || !key || key.length > STORE_LIMITS.keyChars)
        throw new Error(
          `store key must be a non-empty string of at most ${STORE_LIMITS.keyChars} characters`,
        );
      if (value === undefined) next.delete(key);
      else next.set(key, JSON.stringify(value));
    }
    if (next.size > STORE_LIMITS.keys)
      throw new Error(`store holds at most ${STORE_LIMITS.keys} keys`);
    let bytes = 0;
    for (const [key, value] of next)
      bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
    if (bytes > STORE_LIMITS.totalBytes)
      throw new Error('store size limit exceeded; delete unused keys first');
    this.entries = next;
  }
}

/** The committed writes a CodeMode tool result carries, if any. */
export function storeWritesOf(
  toolUseResult: unknown,
): StoreWrite[] | undefined {
  if (!toolUseResult || typeof toolUseResult !== 'object') return undefined;
  const { type, storeWrites } = toolUseResult as Record<string, unknown>;
  return type === CODE_MODE_RESULT_TYPE && Array.isArray(storeWrites)
    ? (storeWrites as StoreWrite[])
    : undefined;
}

/** Deltas of every completed script on a chain, oldest first; each rides in its own tool result. */
export function storeWritesOnChain(
  chain: readonly TranscriptMessage[],
): StoreWrite[][] {
  const deltas: StoreWrite[][] = [];
  for (const message of chain) {
    if (message.type !== 'user' || message.toolUseResult === undefined)
      continue;
    const content = message.message.content;
    const count = Array.isArray(content)
      ? content.filter((block) => block.type === 'tool_result').length
      : 0;
    for (let index = 0; index < count; index++) {
      const writes = storeWritesOf(
        selectToolResultSideChannel(message.toolUseResult, index, count),
      );
      if (writes) deltas.push(writes);
    }
  }
  return deltas;
}

export class StoreRestoreError extends Error {
  constructor(cause: unknown) {
    super('Unable to restore the persisted CodeMode store', { cause });
    this.name = 'StoreRestoreError';
  }
}

/** Replays every committed delta on the conversation chain into a fresh store. */
export async function restoreStore(
  conversation: ActiveConversation | undefined,
  signal?: AbortSignal,
): Promise<CodeModeStore> {
  const store = new CodeModeStore();
  let deltas: StoreWrite[][] = [];
  try {
    signal?.throwIfAborted();
    deltas = conversation
      ? storeWritesOnChain(
          await raceWithAbortSignal(conversation.readChain(), signal),
        )
      : [];
  } catch (error) {
    if (signal?.aborted) throw error;
    runLogger.warn('[CodeMode] Unable to restore the persisted store', error);
    throw new StoreRestoreError(error);
  }
  for (const writes of deltas) {
    try {
      store.commit(writes);
    } catch (error) {
      runLogger.warn(
        '[CodeMode] Skipped an invalid persisted store delta',
        error,
      );
    }
  }
  return store;
}
