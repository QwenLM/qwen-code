/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';

/**
 * Create a paired in-memory NDJSON channel: two `Stream`s connected
 * back-to-back via two `TransformStream<Uint8Array, Uint8Array>` instances
 * (one per direction).
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
 * `abort(reason?)` is the universal teardown primitive. It errors
 * both underlying byte-level `TransformStream` controllers, immediately settling
 * pending `read()` / `write()` operations on both sides so the channel can be
 * reclaimed.
 * Use this to terminate the channel during shutdown / crash simulation
 * / daemon teardown.
 *
 * **Settlement shape**: at the inner byte-level layer the pending read
 * rejects with the supplied reason; at the outer SDK-wrapped `Stream`
 * layer (what callers actually see) the SDK's `ndJsonStream` translates
 * that error into a clean end-of-stream signal — `read()` resolves with
 * `{value: undefined, done: true}` rather than rejecting. The exact
 * shape depends on how deep the consumer is in the wrapper chain, but
 * the key invariant — **pending operations no longer hang** — holds
 * either way. Consumers wanting to distinguish "graceful close" from
 * "aborted" should track the call themselves.
 *
 * We expose `abort` rather than `close` because `close()` only reaches
 * the opposite `ReadableStream` after pending writes flush, and in
 * practice the SDK's `ndJsonStream` outer wrapper does not reliably
 * propagate close at all. `abort` is forceful and synchronous-by-spec,
 * so it is the safe primitive for stream teardown across an
 * `ndJsonStream`-wrapped pair.
 *
 * SDK RPC promises still need the connection owner's close/cancel guard;
 * closing streams alone does not reject outstanding SDK requests.
 *
 * Consumers that don't need teardown (most test sites, which let the
 * channel die with the test scope) can ignore `abort`. `abort` is a
 * platform-level primitive (not a test-fixture concern), so exposing
 * it does not pull fixture machinery into this production module.
 */
export function createInMemoryChannel(): {
  clientStream: Stream;
  agentStream: Stream;
  abort(reason?: unknown): void;
} {
  let abController!: TransformStreamDefaultController<Uint8Array>;
  let baController!: TransformStreamDefaultController<Uint8Array>;
  const ab = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      abController = controller;
    },
  });
  const ba = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      baController = controller;
    },
  });
  const clientStream = ndJsonStream(ab.writable, ba.readable);
  const agentStream = ndJsonStream(ba.writable, ab.readable);
  return {
    clientStream,
    agentStream,
    abort(reason?: unknown) {
      // The NDJSON writer can hold the writable lock while sending a frame.
      // Error the controllers so closure cannot be lost in that window.
      abController.error(reason);
      baController.error(reason);
    },
  };
}
