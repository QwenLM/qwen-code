/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Extract the renderable agent text from a `session_update` SSE frame's `data`,
 * shared by every streaming bridge (Discord, Matrix).
 *
 * The gateway relays the daemon's ACP `SessionNotification` verbatim as the frame
 * `data`: `{ sessionId, update }` where `update.sessionUpdate` is the kind and
 * `update.content.text` is the chunk (confirmed against the reference web client).
 * We render ONLY `agent_message_chunk` — the assistant's prose — and deliberately
 * skip `agent_thought_chunk`, `tool_call`, plan, etc., to keep the chat surface
 * readable. Returns '' for any other kind or a malformed frame, so the caller can
 * simply `if (!text) return`.
 */
export function extractAgentText(data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  // The notification may be `{update: {...}}` or the update object directly.
  const update = (
    d['update'] && typeof d['update'] === 'object' ? d['update'] : d
  ) as Record<string, unknown>;
  if (update['sessionUpdate'] !== 'agent_message_chunk') return '';
  const content = update['content'];
  if (content && typeof content === 'object') {
    const text = (content as Record<string, unknown>)['text'];
    if (typeof text === 'string') return text;
  }
  return '';
}
