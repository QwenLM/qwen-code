/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Feature gate for cross-session peer messaging.
 *
 * Everything in `src/messaging/` hangs off this one predicate: when it is false
 * no socket is bound, no session registry entry is written, `ListAgents` is not
 * registered, and `SendMessage` renders its original description. `ListAgents`
 * additionally needs {@link isListAgentsToolEnabled}.
 */

import { isFeatureOpen } from '../config/feature-flags.js';

export const CROSS_SESSION_FEATURE_NAME = 'CROSS_SESSION';

/**
 * Whether cross-session peer messaging is available in this process.
 *
 * Windows is unsupported: the transport relies on Unix filesystem permissions
 * (0700 directory, 0600 socket) for same-user isolation, and named pipes have a
 * different ACL model that this implementation does not handle.
 */
export function isCrossSessionMessagingEnabled(): boolean {
  if (process.platform === 'win32') return false;
  return isFeatureOpen(CROSS_SESSION_FEATURE_NAME);
}

export const CROSS_SESSION_LIST_AGENTS_FEATURE_NAME =
  'CROSS_SESSION_LIST_AGENTS';

/**
 * Whether the model is given `ListAgents`.
 *
 * Default off. A tool whose only purpose is listing other sessions is a
 * standing cue to go and contact them, and the model does, unprompted. Without
 * it the model reaches a peer only through a label the user @-mentioned or the
 * `from` address of a message the peer sent; the user lists sessions with
 * `/peers`.
 */
export function isListAgentsToolEnabled(): boolean {
  return (
    isCrossSessionMessagingEnabled() &&
    isFeatureOpen(CROSS_SESSION_LIST_AGENTS_FEATURE_NAME)
  );
}

export const CROSS_SESSION_MODE_EMIT_FEATURE_NAME = 'CROSS_SESSION_MODE_EMIT';

/**
 * Whether a sender may declare its permission-mode class to peers.
 *
 * Default off, and applied on both sides: with it off we neither stamp
 * `from-mode` nor honour one a peer stamps anyway. Honouring the attribute is a
 * convenience between cooperating sessions, never a control — it is
 * self-declared and any same-user process can forge it — so the default is to
 * ignore it and let permission-mode parity fall back to holding for review.
 *
 * Gating only the send side would be worse than not gating at all: a peer on an
 * older build would keep asserting and would keep sliding past this session's
 * gate.
 */
export function isPeerModeEmitEnabled(): boolean {
  return (
    isCrossSessionMessagingEnabled() &&
    isFeatureOpen(CROSS_SESSION_MODE_EMIT_FEATURE_NAME)
  );
}
