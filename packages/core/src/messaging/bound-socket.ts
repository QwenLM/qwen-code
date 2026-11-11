/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where *this* process listens.
 *
 * Its own module because both halves of the transport need the answer and they
 * already point at each other: the server hands receipts to the client, so the
 * client cannot import the server back. Keeping the state here is what lets one
 * definition serve both instead of each deriving its own.
 *
 * The distinction this exists to hold is between two questions that used to have
 * one answer:
 *
 * - *Where do I listen?* — this module. Set by a successful bind, cleared on
 *   close, never inherited.
 * - *Where does the session that spawned me listen?* — `ENV_MESSAGING_SOCKET`.
 *   A child inherits it and no bind-failure path clears it.
 *
 * Answering the first with the second is what made a non-bound child sign its
 * messages with its parent's address, so anything about *this* process must come
 * from here.
 */

/** Set once a bind succeeds, cleared on close. */
let boundSocketPath: string | undefined;

/** The socket this process is listening on, or undefined when it never bound. */
export function boundMessagingSocket(): string | undefined {
  return boundSocketPath;
}

/**
 * Records the outcome of a bind.
 *
 * @internal Called by the bind and close paths, and by tests that need to stand
 * in for a session other than the one they bound.
 */
export function setBoundMessagingSocket(socketPath: string | undefined): void {
  boundSocketPath = socketPath;
}
