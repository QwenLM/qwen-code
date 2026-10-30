/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isUserPromptSubmitContextPartText as isUserPromptSubmitContextPartTextInternal,
  wrapUserPromptSubmitContext,
} from '../utils/transcript-records.js';

/**
 * Reserved tag wrapping UserPromptSubmit `additionalContext` when it is
 * appended to the model-bound user message. The canonical tag and matcher
 * definitions live in the Node-free transcript-records module.
 */
export {
  USER_PROMPT_SUBMIT_CONTEXT_OPEN as USER_PROMPT_SUBMIT_CONTEXT_OPEN_TAG,
  USER_PROMPT_SUBMIT_CONTEXT_CLOSE as USER_PROMPT_SUBMIT_CONTEXT_CLOSE_TAG,
  isUserPromptSubmitContextPartText,
  wrapUserPromptSubmitContext,
} from '../utils/transcript-records.js';

type UserPromptSubmitContextPart = { text: string } & Record<symbol, unknown>;

/**
 * Receipt stamped by the injector on the tagged part it appends. History
 * carries no hook-origin field, and a caller-authored message can reproduce
 * the injection shape byte-for-byte (multi-part user text ending in the
 * wrapped block), so shape alone cannot prove the hook delivered a block.
 * The symbol is module-private: JSON transcript records, ACP prompt blocks,
 * and model output cannot carry it, so only a part built by
 * `createUserPromptSubmitContextPart` — or one re-stamped by resume from the
 * recorded per-turn `hookContext` provenance — counts as injector-owned.
 */
const userPromptSubmitContextReceipt = Symbol('userPromptSubmitContextReceipt');

/** Builds the tagged part the injector appends, stamped with its receipt. */
export function createUserPromptSubmitContextPart(
  context: string,
): UserPromptSubmitContextPart {
  return {
    text: wrapUserPromptSubmitContext(context),
    [userPromptSubmitContextReceipt]: true,
  };
}

/**
 * Re-stamps a receipt onto a trailing tagged part whose text matches
 * `context` — the resume half of the receipt contract, used when transcript
 * records are rebuilt into API history and only the recorded `hookContext`
 * provenance can attest which parts the injector delivered.
 */
export function restoreUserPromptSubmitContextReceipt(
  entry: unknown,
  context: string,
): void {
  const candidate = entry as { parts?: unknown } | null;
  const parts = candidate?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    return;
  }
  const last = parts[parts.length - 1] as UserPromptSubmitContextPart | null;
  if (last?.text === wrapUserPromptSubmitContext(context)) {
    last[userPromptSubmitContextReceipt] = true;
  }
}

/**
 * Drops a trailing part that is entirely a tagged UserPromptSubmit context
 * block. Ordinary injection appends after the user's own part(s). Without
 * provenance, a sole matching part is kept as user-authored text. Returns the
 * same array reference when nothing is stripped.
 */
export function stripTrailingUserPromptSubmitContextPart<T>(
  parts: readonly T[],
): readonly T[] {
  if (parts.length <= 1) {
    return parts;
  }
  const last = parts[parts.length - 1] as { text?: unknown } | undefined;
  if (
    !last ||
    typeof last.text !== 'string' ||
    !isUserPromptSubmitContextPartTextInternal(last.text)
  ) {
    return parts;
  }
  return parts.slice(0, -1);
}

/**
 * Matches the whole wrapped block rather than a substring, so `context` must be
 * the escaped string that injection appends, not the raw hook output. Unlike
 * `isUserPromptSubmitContextPartText`, which recognizes any tagged block, this
 * recognizes one exact payload and does not trim.
 *
 * A match requires injector-owned evidence, not shape: a matching part that
 * carries the module-private receipt in a user entry matches when it sits after
 * index zero (so later appended parts, including a memory catalog snapshot, do
 * not invalidate the evidence) or when it is the entry's sole part (reactive
 * compaction can rescue the block that way). Tagged text that merely appears —
 * authored by the user or the model, in any entry shape — never carries the
 * receipt, so it does not suppress a fresh delivery; when provenance cannot be
 * established, injection proceeds as before.
 * does not suppress a fresh delivery; when provenance cannot be established,
 * injection proceeds as before.
 */
export function hasUserPromptSubmitContext(
  entry: unknown,
  context: string,
): boolean {
  const candidate = entry as { role?: unknown; parts?: unknown } | null;
  if (candidate?.role !== 'user' || !Array.isArray(candidate.parts)) {
    return false;
  }
  const parts = candidate.parts;
  if (parts.length === 0) {
    return false;
  }
  const wrapped = wrapUserPromptSubmitContext(context);
  return parts.some(
    (part: UserPromptSubmitContextPart | null, index: number) =>
      (index > 0 || parts.length === 1) &&
      part?.text === wrapped &&
      part[userPromptSubmitContextReceipt] === true,
  );
}
