/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The environment contract between a session and the processes it spawns.
 *
 * Kept in its own leaf module — no core imports — so the startup path can
 * scrub an inherited pair before anything is spawned without paying for the
 * messaging stack it would otherwise pull in.
 */

/**
 * Where child processes of this session find its inbox, so a script or
 * hook it runs can inject a message back into it (through the same
 * inbound gate as any peer). Cleared when the inbox closes.
 *
 * The token is the session's *child* token, not the one it publishes for
 * peers: it goes nowhere but this environment, so a connection presenting
 * it is known to come from a process the session started, and the gate
 * treats such a message as the session's own rather than as another
 * session's.
 */
export const MESSAGING_SOCKET_ENV = 'QWEN_CODE_MESSAGING_SOCKET';
export const MESSAGING_TOKEN_ENV = 'QWEN_CODE_MESSAGING_TOKEN';

/**
 * Drop an inherited address/token pair.
 *
 * These two variables name one capability: the address a child connects to
 * and the token that authenticates it there. A process that inherits them
 * from an ancestor session but binds no inbox of its own would otherwise
 * pass the ancestor's capability straight down to its own children — a hook
 * following the documented injection pattern would then authenticate to the
 * ancestor's inbox and, under the default policy, land its message in the
 * wrong session's context while reporting success.
 *
 * Called once at startup, before anything is spawned. A session that does
 * bind its own inbox re-exports its own pair on the success path
 * ({@link PeerMessaging.start}), so the scrub only ever removes a pair this
 * process has no right to hand on.
 */
export function clearInheritedPeerMessagingEnv(): void {
  delete process.env[MESSAGING_SOCKET_ENV];
  delete process.env[MESSAGING_TOKEN_ENV];
}
