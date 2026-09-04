/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Daemon SSE event-`type` wire literals shared across the daemon publisher
 * (`acp-bridge`), the SDK validator/reducer, and the browser consumer.
 *
 * Kept in this DEPENDENCY-FREE module (no `import type` from core, unlike
 * `bridgeTypes.ts`) so the SDK can re-export these from `@qwen-code/sdk/daemon`
 * via its build-time devDep on acp-bridge WITHOUT pulling acp-bridge's type
 * graph into the SDK's bundled `.d.ts` — the same lightweight pattern as
 * `mcpTimeouts.ts`.
 */

/**
 * Published when the daemon drains queued mid-turn messages into the running
 * turn. The browser consumes it to move those messages out of its pending queue
 * so they aren't resent as the next turn (a transient dedupe signal). Single
 * source of truth: a rename here propagates to every importer, so it can't
 * silently break browser-side dedup. `data: { sessionId, messages: string[] }`.
 */
export const MID_TURN_MESSAGE_INJECTED_EVENT = 'mid_turn_message_injected';

/**
 * Published when a prompt is accepted into the per-session FIFO queue
 * (i.e. a previous prompt is still running, so this one must wait).
 * The first prompt on an idle session does NOT publish this event —
 * it starts immediately without queueing.
 * `data: { sessionId, promptId, text, queuedAt }`.
 */
export const PENDING_PROMPT_ADDED_EVENT = 'pending_prompt_added';

/**
 * Published when a queued prompt begins dispatch (reaches the head of the
 * FIFO). `data: { sessionId, promptId, text }`.
 */
export const PENDING_PROMPT_STARTED_EVENT = 'pending_prompt_started';

/**
 * Published when a pending prompt settles (completed normally or
 * explicitly removed). `data: { sessionId, promptId, state:
 * 'completed' | 'removed' }`. Errors during prompt execution still
 * produce `'completed'` — the terminal SSE event (`turn_error`)
 * carries the actual error detail.
 */
export const PENDING_PROMPT_COMPLETED_EVENT = 'pending_prompt_completed';
