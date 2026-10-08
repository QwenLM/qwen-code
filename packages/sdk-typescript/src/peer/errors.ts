/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Why a peer endpoint could not start, or can no longer act.
 *
 * - `invalid-name`: the name is blank once flattened to one line.
 * - `invalid-kind`: the kind is not lowercase ASCII letters, digits and
 *   dashes of at most 16 characters starting with a letter.
 * - `invalid-session-id`: the session id is blank.
 * - `invalid-controller-token`: the controller token is not a token a
 *   session would consider — empty, or without the `qpc_` prefix — or a
 *   controller send was asked of an endpoint started without one.
 * - `unsupported-platform`: this platform has no UNIX domain sockets the
 *   endpoint knows how to place.
 * - `bind-failed`: no candidate socket path could be bound.
 * - `registry-unwritable`: the session record could not be written.
 * - `closed`: the endpoint was closed.
 */
export type PeerEndpointErrorCode =
  | 'invalid-name'
  | 'invalid-kind'
  | 'invalid-session-id'
  | 'invalid-controller-token'
  | 'unsupported-platform'
  | 'bind-failed'
  | 'registry-unwritable'
  | 'closed';

export class PeerEndpointError extends Error {
  constructor(
    readonly code: PeerEndpointErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PeerEndpointError';
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
