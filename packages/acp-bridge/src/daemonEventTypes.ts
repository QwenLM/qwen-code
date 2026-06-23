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
