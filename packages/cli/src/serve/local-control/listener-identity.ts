/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Request } from 'express';

/**
 * Which listener a request arrived on.
 *
 * `primary` is the listener `qwen serve` binds at startup — loopback by
 * default, or whatever `--hostname` names. `local-control` is the LAN
 * listener attached at runtime by {@link LocalControlService}.
 *
 * The distinction is load-bearing for auth: the runtime token authenticates
 * only on `primary`, the pairing token only on `local-control`. That is the
 * invariant the Tauri proxy enforced by rejecting a request that already
 * carried the runtime token; in-daemon we get it by attributing the request to
 * its listener instead.
 */
export type ListenerKind = 'primary' | 'local-control';

export interface ListenerIdentity {
  readonly kind: ListenerKind;
  /**
   * The authority this listener advertises, lowercased, e.g.
   * `192.168.1.42:4170`. Set for `local-control`, where it is the sole
   * accepted `Host` value. Undefined for `primary`, which derives its
   * allowlist from the bind + port instead.
   */
  readonly authority?: string;
  /** Exact browser Origin accepted by the Local Control WebSocket gate. */
  readonly origin?: string;
}

/**
 * Identity is stamped on the `http.Server` object itself rather than tracked
 * in a side table keyed by port. A port comparison silently degrades if the
 * OS reuses the port after a restart; a tag set at construction cannot drift
 * from the socket it describes.
 *
 * `Symbol.for` rather than a module-local symbol so the tag survives duplicate
 * copies of this module in a workspace with hoisting quirks — a request whose
 * identity fails to resolve is treated as `primary`, which would let a pairing
 * token be presented to the operator listener if the lookup ever missed.
 */
const LISTENER_TAG = Symbol.for('qwen.serve.listenerIdentity');

type Tagged = { [LISTENER_TAG]?: ListenerIdentity };

export function tagListener(server: Server, identity: ListenerIdentity): void {
  (server as unknown as Tagged)[LISTENER_TAG] = identity;
}

const PRIMARY: ListenerIdentity = { kind: 'primary' };

function fromServer(server: unknown): ListenerIdentity | undefined {
  if (!server || typeof server !== 'object') return undefined;
  return (server as Tagged)[LISTENER_TAG];
}

/**
 * Resolve the listener an Express request arrived on.
 *
 * Falls back to `primary` when the socket has no server backreference — which
 * happens in unit tests that drive handlers with a synthetic `req`. Defaulting
 * to `primary` is the safe direction: it means an untagged request is held to
 * the runtime token, never to the weaker pairing credential.
 */
export function listenerIdentityOf(req: Request): ListenerIdentity {
  const socket = req.socket as unknown as { server?: unknown };
  return fromServer(socket?.server) ?? PRIMARY;
}

/** Same resolution for the raw socket handed to an `'upgrade'` listener. */
export function listenerIdentityOfSocket(socket: Duplex): ListenerIdentity {
  const withServer = socket as unknown as { server?: unknown };
  return fromServer(withServer?.server) ?? PRIMARY;
}
