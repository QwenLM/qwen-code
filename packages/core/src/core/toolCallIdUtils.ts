/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, FunctionCall, Part } from '@google/genai';
import { createDebugLogger } from '../utils/debugLogger.js';
import { getToolCallRepeatKey } from '../utils/tool-call-repeat-key.js';

const DUPLICATE_ID_SUFFIX = '__qwen_dup_';
const GENERATED_ID_PREFIX = 'call_qwen_';
const PROVIDER_TOOL_CALL_ID = Symbol('providerToolCallId');
const debugLogger = createDebugLogger('TOOL_CALL_IDS');

// History functionCall parts are stable objects (accessors walk history in
// place, without cloning), so fingerprints of large args — e.g. write_file
// content — are computed once per call instead of once per dedup pass.
const functionCallFingerprintCache = new WeakMap<FunctionCall, string>();

type FunctionCallWithProviderId = FunctionCall & {
  [PROVIDER_TOOL_CALL_ID]?: string;
};

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

/**
 * Identity of a tool call for duplicate provider-id replay detection: the
 * same canonical (name, args) key the loop guards use, so "replay" means
 * the exact call the provider already saw answered — not merely a reused
 * id. Providers whose ids are only unique within a single response (e.g.
 * `{name}_{index}` schemes that restart at 0) legitimately reuse ids for
 * different calls; those must not be treated as replays.
 */
export function getToolCallFingerprint(
  name: string | undefined,
  args: unknown,
): string {
  return getToolCallRepeatKey(name ?? '', args ?? {});
}

export function getFunctionCallFingerprint(functionCall: FunctionCall): string {
  let fingerprint = functionCallFingerprintCache.get(functionCall);
  if (fingerprint === undefined) {
    fingerprint = getToolCallFingerprint(functionCall.name, functionCall.args);
    functionCallFingerprintCache.set(functionCall, fingerprint);
  }
  return fingerprint;
}

/**
 * True when an incoming provider tool call replays an already-handled call:
 * the provider id was handled before AND the (name, args) fingerprint
 * matches the call that first executed under that id. An id collision with
 * a different fingerprint is a fresh call and must execute (under the
 * unique suffixed id assigned by {@link normalizeModelToolCallIds}).
 */
export function isReplayOfHandledToolCall(
  handledToolCallFingerprints: ReadonlyMap<string, string>,
  providerCallId: string,
  name: string | undefined,
  args: unknown,
): boolean {
  const handledFingerprint = handledToolCallFingerprints.get(providerCallId);
  return (
    handledFingerprint !== undefined &&
    handledFingerprint === getToolCallFingerprint(name, args)
  );
}

/**
 * Records a call admitted for execution. First-occurrence semantics: a
 * provider id keeps naming the call that first executed under it, so a
 * later id-colliding call (executed under its suffixed id) does not
 * redefine what counts as a replay of the original.
 */
export function recordHandledToolCall(
  handledToolCallFingerprints: Map<string, string>,
  providerCallId: string,
  name: string | undefined,
  args: unknown,
): void {
  if (!handledToolCallFingerprints.has(providerCallId)) {
    handledToolCallFingerprints.set(
      providerCallId,
      getToolCallFingerprint(name, args),
    );
  }
}

export function normalizeModelToolCallIds(
  parts: readonly Part[],
  usedIds: Set<string>,
  rawIdsInCurrentTurn: Set<string>,
  reservedIds?: ReadonlyMap<string, string>,
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
      ? (reservedIds?.get(rawId) ?? nextAvailableDuplicateId(rawId, usedIds))
      : nextGeneratedId(usedIds);
    if (rawId && id !== rawId) {
      debugLogger.debug(
        `Suffixing cross-turn duplicate functionCall id=${rawId} normalizedId=${id} name=${functionCall.name}`,
      );
    }
    usedIds.add(id);

    const normalizedFunctionCall: FunctionCallWithProviderId = {
      ...functionCall,
      id,
    };
    if (rawId) {
      Object.defineProperty(normalizedFunctionCall, PROVIDER_TOOL_CALL_ID, {
        value: rawId,
        enumerable: false,
      });
    }

    normalized.push({
      ...part,
      functionCall: normalizedFunctionCall,
    });
  }

  return normalized;
}

export function reserveModelToolCallId(
  rawId: string,
  usedIds: Set<string>,
  reservedIds: Map<string, string>,
): string {
  const existing = reservedIds.get(rawId);
  if (existing) return existing;

  const id = nextAvailableDuplicateId(rawId, usedIds);
  reservedIds.set(rawId, id);
  usedIds.add(id);
  return id;
}

export function getProviderToolCallId(
  functionCall: FunctionCall,
): string | undefined {
  return (functionCall as FunctionCallWithProviderId)[PROVIDER_TOOL_CALL_ID];
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
