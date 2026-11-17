/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Server } from 'node:http';

/** Idle delay before the first TCP keepalive probe on accepted sockets. */
export const SOCKET_KEEPALIVE_IDLE_MS = 30_000;

/**
 * Enable TCP keepalive on every socket a listener accepts. Lets the kernel
 * reap half-open connections whose peer vanished without FIN/RST while the
 * socket sits idle (e.g. pooled keep-alive HTTP connections, NAT-dropped
 * pairing clients).
 *
 * Boundary with the SSE writer-stall reaper (routes/sse-events.ts):
 * keepalive does NOT catch a live peer that stopped reading — its TCP
 * stack still ACKs the probes — and never fires on a connection that keeps
 * sending heartbeats. Those cases belong to the application-level reaper,
 * which evicts writers stuck on `drain`.
 *
 * Registered on every server the daemon creates (primary, local-control,
 * remote-access); for HTTPS the 'connection' event carries the raw socket
 * before the TLS handshake, so the setting applies to the underlying TCP
 * connection either way.
 */
export function enableSocketKeepalive(server: Server): void {
  server.on('connection', (socket) => {
    socket.setKeepAlive(true, SOCKET_KEEPALIVE_IDLE_MS);
  });
}
