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

export function wrapAsyncHookContext(context: string): string {
  return `${ASYNC_HOOK_CONTEXT_OPEN}\n${context}\n${ASYNC_HOOK_CONTEXT_CLOSE}`;
}

/**
 * Render pending async output as model-facing text: the additional contexts
 * verbatim, then the notification messages labeled by type and hook. `<`/`>`
 * are escaped so hook output cannot forge the closing tag. Returns null when
 * there is nothing to deliver.
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
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

/**
 * Drain the pending async hook output and build the tagged part to append to
 * the outgoing request, or null when there is nothing to deliver. The drain
 * clears the registry, so the output is delivered exactly once.
 */
export function drainAsyncHookContextPart(
  hookSystem: { getPendingAsyncOutput(): PendingAsyncOutput } | undefined,
): { text: string } | null {
  const output = hookSystem?.getPendingAsyncOutput();
  if (!output) {
    return null;
  }
  const context = formatAsyncHookOutput(output);
  if (context === null) {
    return null;
  }
  return { text: wrapAsyncHookContext(context) };
}
