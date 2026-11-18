/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PendingAsyncOutput } from './types.js';

/**
 * Reserved tag wrapping background (async) hook output when it is delivered
 * to the model on the next request. Async hooks complete between turns and
 * their output accumulates in the async registry; nothing read it before a
 * request (capability ledger L11), so the context never reached the model.
 * The drain is get-and-clear: a block is delivered once, so unlike the
 * UserPromptSubmit context it needs no history dedup or resume receipt.
 */
export const ASYNC_HOOK_CONTEXT_OPEN = '<qwen:async-hook-context>';
export const ASYNC_HOOK_CONTEXT_CLOSE = '</qwen:async-hook-context>';

/**
 * Upper bound on the joined async block, mirroring the user-prompt-expansion
 * additional-context cap. The registry accumulates every completion with no
 * total limit, so a verbose hook (or many completions) could otherwise append
 * megabytes to the request and to the side query that reuses it.
 */
export const MAX_ASYNC_HOOK_CONTEXT_LENGTH = 10_000;

export function wrapAsyncHookContext(context: string): string {
  return `${ASYNC_HOOK_CONTEXT_OPEN}\n${context}\n${ASYNC_HOOK_CONTEXT_CLOSE}`;
}

/**
 * Whether `text` is a complete async-hook-context envelope. The wire-order
 * classifier (`isInjectedPromptContext`) uses this to recognize the block as
 * injected context rather than the caller's own text, so it is hoisted ahead
 * of the user's instruction like the other injected blocks. Mirrors
 * `isUserPromptSubmitContextPartText`: the body must not carry another tag,
 * which `formatAsyncHookOutput` guarantees by escaping `<`/`>`.
 */
export function isAsyncHookContextPartText(text: string): boolean {
  const trimmed = text.trim();
  const prefix = `${ASYNC_HOOK_CONTEXT_OPEN}\n`;
  const suffix = `\n${ASYNC_HOOK_CONTEXT_CLOSE}`;
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith(suffix)) {
    return false;
  }
  const body = trimmed.slice(prefix.length, -suffix.length);
  return (
    !body.includes(ASYNC_HOOK_CONTEXT_OPEN) &&
    !body.includes(ASYNC_HOOK_CONTEXT_CLOSE)
  );
}

/**
 * Render pending async output as model-facing text: the additional contexts
 * verbatim, then the notification messages labeled by type and hook. `<`/`>`
 * are escaped so hook output cannot forge the closing tag. The joined block is
 * bounded by `MAX_ASYNC_HOOK_CONTEXT_LENGTH`. Returns null when there is
 * nothing to deliver.
 */
export function formatAsyncHookOutput(
  output: PendingAsyncOutput,
): string | null {
  const escape = (text: string) =>
    text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const blocks: string[] = [];
  for (const context of output.contexts) {
    if (context.trim()) {
      blocks.push(escape(context));
    }
  }
  for (const message of output.messages) {
    if (message.message.trim()) {
      blocks.push(
        escape(`[${message.type}] ${message.hookName}: ${message.message}`),
      );
    }
  }
  if (blocks.length === 0) {
    return null;
  }
  const joined = blocks.join('\n\n');
  if (joined.length <= MAX_ASYNC_HOOK_CONTEXT_LENGTH) {
    return joined;
  }
  // Strip a trailing partial escape entity left by the cut, mirroring
  // sanitizeUserPromptExpansionAdditionalContext.
  return joined
    .slice(0, MAX_ASYNC_HOOK_CONTEXT_LENGTH)
    .replace(/&(?:lt?|gt?)?$/, '');
}

/**
 * Drain the pending async hook output and build the tagged part to append to
 * the outgoing request, or null when there is nothing to deliver. The drain
 * clears the registry, so a block is selected for delivery once. This proves
 * "selected and removed from the registry", not "admitted by a model turn":
 * a send that fails after the drain consumes the block without delivering it
 * (the consume-but-not-sent window documented in the design). The method is
 * called defensively so a partial hook-system double without it degrades to
 * "nothing to deliver" rather than throwing.
 */
export function drainAsyncHookContextPart(
  hookSystem: { getPendingAsyncOutput?(): PendingAsyncOutput } | undefined,
): { text: string } | null {
  const output = hookSystem?.getPendingAsyncOutput?.();
  if (!output) {
    return null;
  }
  const context = formatAsyncHookOutput(output);
  if (context === null) {
    return null;
  }
  return { text: wrapAsyncHookContext(context) };
}

/**
 * Append the async context part to the outgoing request parts. When the
 * UserPromptSubmit context receipt is the trailing part, splice the async
 * part in *before* it so the sync block stays trailing: the resume half of
 * the receipt contract (`restoreUserPromptSubmitContextReceipt`), the legacy
 * transcript-projection strip and the session-title strip all recognize the
 * sync block only in last position, so an async part trailing it would
 * silently defeat them on a co-occurrence turn. With no trailing sync
 * receipt the async part is simply appended.
 */
export function appendAsyncHookContextPart<T>(
  parts: readonly T[],
  asyncPart: T,
  syncReceiptTrailing: boolean,
): T[] {
  if (syncReceiptTrailing && parts.length > 0) {
    return [...parts.slice(0, -1), asyncPart, parts[parts.length - 1]];
  }
  return [...parts, asyncPart];
}
