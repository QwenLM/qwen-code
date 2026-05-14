/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';

/**
 * Create a paired in-memory NDJSON channel: two `Stream`s connected
 * back-to-back via two `TransformStream<Uint8Array, Uint8Array>` pairs.
 * Whatever `clientStream.writable` writes appears on `agentStream.readable`,
 * and vice versa. Each side is a full ACP `Stream` (via SDK `ndJsonStream`)
 * so callers can hand them to `ClientSideConnection` / `AgentSideConnection`
 * exactly as they would a real stdio pair.
 *
 * Used today by Stage 1 tests (replaces 10 sites of inline boilerplate
 * in `httpAcpBridge.test.ts`). Will also be consumed by the Stage 1.5b
 * in-process bridge (issue #4156) when that lands, to wrap an in-process
 * `QwenAgent` without spawning a `qwen --acp` child.
 *
 * The helper is intentionally bare — it returns only the stream pair, no
 * lifecycle / teardown surface. Two reasons:
 *
 *   1. Consumer behavior diverges widely (stuck channel, crashable
 *      child simulation, no-op, real in-process termination). A
 *      one-size-fits-all `close()` would either pull test-fixture
 *      concerns into a production module or force a single shape on
 *      consumers that don't want it.
 *
 *   2. The SDK's `ndJsonStream` outer wrapper does not reliably
 *      propagate close on `Stream.writable` to the opposite
 *      `Stream.readable`. Consumers needing to simulate a child exit
 *      (like the inline `makeChannel` in `httpAcpBridge.test.ts`) hold
 *      onto their own underlying `TransformStream` references and
 *      close those directly. A `close()` on this helper would have to
 *      either expose the same internals or be silently incomplete.
 */
export function createInMemoryChannel(): {
  clientStream: Stream;
  agentStream: Stream;
} {
  const ab = new TransformStream<Uint8Array, Uint8Array>();
  const ba = new TransformStream<Uint8Array, Uint8Array>();
  const clientStream = ndJsonStream(ab.writable, ba.readable);
  const agentStream = ndJsonStream(ba.writable, ab.readable);
  return { clientStream, agentStream };
}
