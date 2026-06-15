/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, FunctionCall, Part } from '@google/genai';
import { createDebugLogger } from '../utils/debugLogger.js';

const DUPLICATE_ID_SUFFIX = '__qwen_dup_';
const GENERATED_ID_PREFIX = 'call_qwen_';
const debugLogger = createDebugLogger('TOOL_CALL_IDS');

function addId(ids: Set<string>, id: string | undefined): void {
  if (id) {
    ids.add(id);
  }
}

function nextAvailableDuplicateId(rawId: string, usedIds: Set<string>): string {
  if (!usedIds.has(rawId)) {
    return rawId;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${rawId}${DUPLICATE_ID_SUFFIX}${suffix}`;
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }
}

function nextGeneratedId(usedIds: Set<string>): string {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${GENERATED_ID_PREFIX}${suffix}`;
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }
}

export function collectToolCallIdsFromHistory(
  history: readonly Content[],
): Set<string> {
  const ids = new Set<string>();
  for (const content of history) {
    for (const part of content.parts ?? []) {
      addId(ids, part.functionCall?.id);
      addId(ids, part.functionResponse?.id);
    }
  }
  return ids;
}

export function normalizeModelToolCallIds(
  parts: readonly Part[],
  usedIds: Set<string>,
  rawIdsInCurrentTurn: Set<string>,
): Part[] {
  const normalized: Part[] = [];

  for (const part of parts) {
    const functionCall = part.functionCall;
    if (!functionCall) {
      normalized.push(part);
      continue;
    }

    const rawId = functionCall.id;
    if (rawId) {
      if (rawIdsInCurrentTurn.has(rawId)) {
        debugLogger.debug(
          `Dropping same-turn duplicate functionCall id=${rawId} name=${functionCall.name}`,
        );
        continue;
      }
      rawIdsInCurrentTurn.add(rawId);
    }

    const id = rawId
      ? nextAvailableDuplicateId(rawId, usedIds)
      : nextGeneratedId(usedIds);
    if (rawId && id !== rawId) {
      debugLogger.debug(
        `Suffixing cross-turn duplicate functionCall id=${rawId} normalizedId=${id} name=${functionCall.name}`,
      );
    }
    usedIds.add(id);

    normalized.push({
      ...part,
      functionCall: {
        ...functionCall,
        id,
      },
    });
  }

  return normalized;
}

export function dedupeToolCallsById<T extends Pick<FunctionCall, 'id'>>(
  functionCalls: readonly T[],
): T[] {
  const seenIds = new Set<string>();
  const deduped: T[] = [];

  for (const functionCall of functionCalls) {
    const id = functionCall.id;
    if (id) {
      if (seenIds.has(id)) {
        debugLogger.debug(`Dropping duplicate functionCall id=${id}`);
        continue;
      }
      seenIds.add(id);
    }
    deduped.push(functionCall);
  }

  return deduped;
}
